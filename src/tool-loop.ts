/**
 * Tool Loop
 *
 * The core agentic loop. Calls the LLM with tools, streams text to
 * the client, executes tool calls when requested, feeds results back,
 * and repeats until the LLM produces a final text response or the
 * iteration cap is reached.
 *
 * Two variants:
 *   - runToolLoop()              — Streaming, sends SSE events to client
 *   - runToolLoopNonStreaming()   — For job scheduler, no client events
 */

import type { ServerResponse } from 'node:http';
import type { Logger, ToolCallInfo } from './types.js';
import type { ToolRegistry, ToolDefinition } from './tool-registry.js';
import type { ToolExecutor, ToolExecResult } from './tool-executor.js';

/** Maximum tool loop iterations per message. */
const MAX_ITERATIONS = 10;

/** Accumulated tool call fragment from streaming delta. */
interface ToolCallAccumulator {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ---------------------------------------------------------------------------
// Streaming variant (for live chat)
// ---------------------------------------------------------------------------

export interface ToolLoopStreamOptions {
  messages: Array<{ role: string; content: string | Array<any>; tool_calls?: any[]; tool_call_id?: string; name?: string }>;
  model: string;
  tools: ToolDefinition[];
  gatewayOrigin: string;
  authToken: string | undefined;
  res: ServerResponse;
  registry: ToolRegistry;
  executor: ToolExecutor;
  logger: Logger;
}

export interface ToolLoopStreamResult {
  fullContent: string;
  responseModel: string | undefined;
  toolCallMessages: Array<{ role: string; content: string; tool_calls?: ToolCallInfo[]; tool_call_id?: string; name?: string }>;
}

/**
 * Run the streaming tool loop. Streams text to the client via SSE,
 * executes tool calls, and loops until done or max iterations.
 */
export async function runToolLoop(opts: ToolLoopStreamOptions): Promise<ToolLoopStreamResult> {
  const { messages, model, tools, gatewayOrigin, authToken, res, executor, logger } = opts;
  let fullContent = '';
  let responseModel: string | undefined;
  const toolCallMessages: ToolLoopStreamResult['toolCallMessages'] = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    let llmResponse: Response;
    try {
      llmResponse = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      logger.error(`ToolLoop: LLM fetch failed (iteration ${iteration}): ${err}`);
      throw err;
    }

    if (!llmResponse.ok) {
      const errBody = await llmResponse.text().catch(() => '');
      logger.warn(`ToolLoop: LLM error (${llmResponse.status}): ${errBody.slice(0, 200)}`);
      throw new Error(`LLM error (${llmResponse.status}): ${errBody.slice(0, 500)}`);
    }

    const reader = llmResponse.body?.getReader();
    if (!reader) throw new Error('No response body from AI provider');

    // Parse the SSE stream
    const decoder = new TextDecoder();
    let buffer = '';
    let iterContent = '';
    let finishReason: string | null = null;
    const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        // Forward raw SSE text chunks to client (for streaming text display)
        // We only forward on the first iteration or when we're streaming new content
        // For tool loop iterations > 0, we only forward content deltas
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              if (!responseModel && parsed.model) {
                responseModel = parsed.model;
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              // Accumulate text content
              const contentDelta = choice.delta?.content;
              if (contentDelta) {
                iterContent += contentDelta;
                // Forward content to client as standard SSE
                res.write(`data: ${JSON.stringify({
                  choices: [{ delta: { content: contentDelta } }],
                  model: parsed.model,
                })}\n\n`);
              }

              // Accumulate tool call fragments
              const toolCallDeltas = choice.delta?.tool_calls;
              if (toolCallDeltas && Array.isArray(toolCallDeltas)) {
                for (const tc of toolCallDeltas) {
                  const idx = tc.index ?? 0;
                  let acc = toolCallAccumulators.get(idx);
                  if (!acc) {
                    acc = {
                      id: tc.id ?? '',
                      type: 'function',
                      function: { name: '', arguments: '' },
                    };
                    toolCallAccumulators.set(idx, acc);
                  }
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.function.name += tc.function.name;
                  if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                }
                // Send SSE comment as keepalive while accumulating tool call
                // arguments. Without this, the client sees no data during long
                // tool-argument generation (e.g. writing a large document) and
                // its inactivity timer fires.
                res.write(': keepalive\n\n');
              }

              // Capture finish reason
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
            } catch {
              // Partial chunk, ignore parse error
            }
          }
        }
      }
    } catch (err) {
      logger.error(`ToolLoop: stream read error (iteration ${iteration}): ${err}`);
      throw err;
    }

    fullContent += iterContent;

    // If the model wants to call tools
    if (finishReason === 'tool_calls' && toolCallAccumulators.size > 0) {
      const toolCalls: ToolCallInfo[] = [];
      for (const [, acc] of toolCallAccumulators) {
        toolCalls.push({
          id: acc.id,
          type: 'function',
          function: { name: acc.function.name, arguments: acc.function.arguments },
        });
      }

      // Add assistant message with tool_calls to messages array
      const assistantToolMsg: any = {
        role: 'assistant',
        content: iterContent || null,
        tool_calls: toolCalls,
      };
      messages.push(assistantToolMsg);
      toolCallMessages.push(assistantToolMsg);

      // Execute each tool call
      for (const tc of toolCalls) {
        // Send tool_start event to client
        res.write(`event: tool_start\ndata: ${JSON.stringify({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })}\n\n`);

        const result = await executor.execute(tc.function.name, tc.function.arguments);

        // Send tool_end event to client
        res.write(`event: tool_end\ndata: ${JSON.stringify({
          id: tc.id,
          name: tc.function.name,
          success: result.success,
          content: result.content.slice(0, 2000), // Truncate for SSE event
          durationMs: result.durationMs,
        })}\n\n`);

        // Add tool result to messages array
        const toolResultMsg: any = {
          role: 'tool',
          content: result.content,
          tool_call_id: tc.id,
          name: tc.function.name,
        };
        messages.push(toolResultMsg);
        toolCallMessages.push(toolResultMsg);
      }

      // Continue the loop — LLM will see the tool results
      logger.info(`ToolLoop: iteration ${iteration + 1}, executed ${toolCalls.length} tool(s)`);
      continue;
    }

    // Model finished with text response (or stop)
    break;
  }

  return { fullContent, responseModel, toolCallMessages };
}

// ---------------------------------------------------------------------------
// Non-streaming variant (for job scheduler)
// ---------------------------------------------------------------------------

export interface ToolLoopNonStreamOptions {
  messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>;
  model: string;
  tools: ToolDefinition[];
  gatewayOrigin: string;
  authToken: string | undefined;
  executor: ToolExecutor;
  logger: Logger;
  timeoutMs?: number;
}

export interface ToolLoopNonStreamResult {
  fullContent: string;
  responseModel: string | undefined;
  usage: { prompt_tokens: number; completion_tokens: number } | undefined;
}

/**
 * Run the non-streaming tool loop for background jobs.
 * Same logic as streaming variant but uses stream: false and no SSE events.
 */
export async function runToolLoopNonStreaming(opts: ToolLoopNonStreamOptions): Promise<ToolLoopNonStreamResult> {
  const { messages, model, tools, gatewayOrigin, authToken, executor, logger, timeoutMs = 120_000 } = opts;
  let fullContent = '';
  let responseModel: string | undefined;
  let lastUsage: { prompt_tokens: number; completion_tokens: number } | undefined;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const response = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`LLM call failed (${response.status}): ${errBody.slice(0, 200)}`);
    }

    const json = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: ToolCallInfo[];
        };
        finish_reason?: string;
      }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    if (!responseModel && json.model) responseModel = json.model;
    if (json.usage) {
      lastUsage = {
        prompt_tokens: json.usage.prompt_tokens ?? 0,
        completion_tokens: json.usage.completion_tokens ?? 0,
      };
    }

    const choice = json.choices?.[0];
    const message = choice?.message;
    const textContent = message?.content ?? '';
    const toolCalls = message?.tool_calls;

    if (toolCalls && toolCalls.length > 0 && choice?.finish_reason === 'tool_calls') {
      // Add assistant message with tool_calls
      messages.push({
        role: 'assistant',
        content: textContent || '',
        tool_calls: toolCalls,
      } as any);

      // Execute each tool
      for (const tc of toolCalls) {
        const result = await executor.execute(tc.function.name, tc.function.arguments);
        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: tc.id,
          name: tc.function.name,
        } as any);
      }

      logger.info(`ToolLoop (non-stream): iteration ${iteration + 1}, executed ${toolCalls.length} tool(s)`);
      continue;
    }

    // Final text response
    fullContent = textContent;
    break;
  }

  return { fullContent, responseModel, usage: lastUsage };
}
