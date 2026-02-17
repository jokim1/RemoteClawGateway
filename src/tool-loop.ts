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
import { Agent } from 'undici';
import type { Logger, ToolCallInfo } from './types.js';
import type { ToolRegistry, ToolDefinition } from './tool-registry.js';
import type { ToolExecutor, ToolExecResult } from './tool-executor.js';

/** Dispatcher with disabled headers/body timeout for long-running non-streaming requests.
 *  Node.js undici defaults to 5 min headersTimeout which kills requests before our
 *  AbortSignal.timeout has a chance to fire. */
const longTimeoutDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** Maximum tool loop iterations per message. */
const MAX_ITERATIONS = 10;

/** Maximum auto-continuations when the model hits max output tokens. */
const MAX_CONTINUATIONS = 3;

/** Inactivity timeout for the streaming tool loop (5 min).
 *  With the keepalive relay active, this only fires if the gateway process
 *  itself is completely stuck (keepalives reset it every 30s). */
const LOOP_INACTIVITY_MS = 300_000;

/** Hard max timeout for the entire streaming tool loop (60 min). */
const LOOP_MAX_MS = 3_600_000;

/** Interval between keepalive SSE comments sent to the client (30s). */
const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Create an AbortController with an activity-based timeout.
 * The timer resets each time `touch()` is called.
 * Falls back to a hard maximum timeout as a safety net.
 */
function createActivityAbort(inactivityMs: number, maxMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), inactivityMs);
  };

  // Hard maximum timeout safety net
  const maxTimer = setTimeout(() => controller.abort(), maxMs);

  resetTimer();
  return {
    signal: controller.signal,
    touch: resetTimer,
    clear: () => { clearTimeout(timer); clearTimeout(maxTimer); },
  };
}

// ---------------------------------------------------------------------------
// Error classification and helpers
// ---------------------------------------------------------------------------

const TRANSIENT_CODES = new Set([429, 500, 502, 503, 529]);
const PERMANENT_CODES = new Set([400, 401, 403, 404]);

/**
 * Classify an error as transient (worth retrying) or permanent.
 * Client disconnects are never transient.
 */
export function isTransientError(err: unknown, clientSignal?: AbortSignal): boolean {
  if (clientSignal?.aborted) return false;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (/abort|cancel/i.test(err.name)) return true;
    if (/econnreset|econnrefused|etimedout|epipe|socket hang up|fetch failed/i.test(msg)) return true;
    // Check for HTTP status codes in error messages like "LLM error (502): ..."
    const statusMatch = msg.match(/\((\d{3})\)/);
    if (statusMatch) {
      const code = parseInt(statusMatch[1], 10);
      if (PERMANENT_CODES.has(code)) return false;
      if (TRANSIENT_CODES.has(code)) return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isGoogleToolName(toolName: string): boolean {
  return /^google_(docs|drive)_/i.test(toolName);
}

function withDefaultGoogleProfile(
  toolName: string,
  argsJson: string,
  defaultProfile: string | undefined,
): string {
  const profile = defaultProfile?.trim();
  if (!profile || !isGoogleToolName(toolName)) return argsJson;
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.profile === undefined) {
      return JSON.stringify({ ...parsed, profile });
    }
  } catch {
    // keep original args if JSON parse fails; executor will surface the error
  }
  return argsJson;
}

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
  extraHeaders?: Record<string, string>;
  res: ServerResponse;
  registry: ToolRegistry;
  executor: ToolExecutor;
  logger: Logger;
  timeoutMs?: number;
  maxTotalMs?: number;
  /** Max time to receive first token/tool delta from provider in an iteration. */
  firstTokenTimeoutMs?: number;
  maxIterations?: number;
  toolChoice?: 'auto' | 'none';
  /** Signal that fires when the HTTP client disconnects. Not retried. */
  clientSignal?: AbortSignal;
  /** Correlation id for model routing diagnostics. */
  traceId?: string;
  /** Optional default Google auth profile for this run. */
  defaultGoogleAuthProfile?: string;
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
  const { messages, model, tools, gatewayOrigin, authToken, extraHeaders, res, executor, logger, clientSignal, traceId } = opts;
  let fullContent = '';
  let responseModel: string | undefined;
  const toolCallMessages: ToolLoopStreamResult['toolCallMessages'] = [];

  // Activity-based abort spanning the entire tool loop.
  // Resets on every chunk, tool event, and keepalive.
  const inactivityMs = opts.timeoutMs ?? LOOP_INACTIVITY_MS;
  const maxMs = Math.min(opts.maxTotalMs ?? inactivityMs * 6, LOOP_MAX_MS);
  const abort = createActivityAbort(inactivityMs, maxMs);

  // Compose the activity abort with the client disconnect signal so that
  // either one cancels the in-flight LLM fetch.
  const fetchSignal = clientSignal
    ? AbortSignal.any([abort.signal, clientSignal])
    : abort.signal;

  let continuations = 0;

  // Keepalive relay: send periodic SSE comments to the client while the
  // upstream agent is working.  This prevents client-side timeouts and
  // provides implicit "still alive" feedback.  Also touches the abort
  // timer so the inactivity timeout only fires if the process is stuck.
  const keepalive = setInterval(() => {
    if (!res.writableEnded && !clientSignal?.aborted) {
      res.write(': keepalive\n\n');
      abort.touch();
    }
  }, KEEPALIVE_INTERVAL_MS);

  try {
  const iterationLimit = Math.max(1, Math.min(opts.maxIterations ?? MAX_ITERATIONS, MAX_ITERATIONS));
  for (let iteration = 0; iteration < iterationLimit; iteration++) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (typeof value === 'string' && value.trim().length > 0) {
          headers[key] = value;
        }
      }
    }

    // Snapshot messages length so we can roll back on retry
    const messagesSnapshot = messages.length;

    // ---------- retry wrapper (max 1 retry per iteration) ----------
    let retried = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Check for client disconnect before each attempt
      if (clientSignal?.aborted) {
        logger.info('ToolLoop: client disconnected, aborting');
        throw new Error('Client disconnected');
      }

      let llmResponse: Response;
      let iterContent = '';
      const toolCallAccumulators = new Map<number, ToolCallAccumulator>();
      let finishReason: string | null = null;
      let fetchOk = false;
      let ttftTimer: ReturnType<typeof setTimeout> | undefined;
      const ttftController = new AbortController();
      let ttftAborted = false;
      let sawFirstDelta = false;
      const ttftMs = Math.max(5_000, opts.firstTokenTimeoutMs ?? 90_000);
      const markFirstDelta = () => {
        if (sawFirstDelta) return;
        sawFirstDelta = true;
        if (ttftTimer) {
          clearTimeout(ttftTimer);
          ttftTimer = undefined;
        }
      };
      ttftTimer = setTimeout(() => {
        if (sawFirstDelta) return;
        ttftAborted = true;
        ttftController.abort();
      }, ttftMs);

      try {
        llmResponse = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            tool_choice: opts.toolChoice,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: AbortSignal.any([fetchSignal, ttftController.signal]),
        });

        if (!llmResponse.ok) {
          const errBody = await llmResponse.text().catch(() => '');
          logger.warn(`ToolLoop: LLM error (${llmResponse.status}): ${errBody.slice(0, 200)}`);
          throw new Error(`LLM error (${llmResponse.status}): ${errBody.slice(0, 500)}`);
        }
        fetchOk = true;

        const reader = llmResponse.body?.getReader();
        if (!reader) throw new Error('No response body from AI provider');

        // Parse the SSE stream
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          abort.touch(); // Reset inactivity timer on each chunk
          const chunk = decoder.decode(value, { stream: true });

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
                  if (traceId) {
                    logger.info(
                      `ModelRoute trace=${traceId} flow=tool-loop responseModel=${responseModel} iteration=${iteration + 1} attempt=${attempt + 1}`,
                    );
                  }
                }

                const choice = parsed.choices?.[0];
                if (!choice) continue;

                // Accumulate text content
                const contentDelta = choice.delta?.content;
                if (contentDelta) {
                  markFirstDelta();
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
                  markFirstDelta();
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
                  res.write(': keepalive\n\n');
                }

                // Capture finish reason
                if (choice.finish_reason) {
                  markFirstDelta();
                  finishReason = choice.finish_reason;
                }
              } catch {
                // Partial chunk, ignore parse error
              }
            }
          }
        }
      } catch (err) {
        let effectiveErr: unknown = err;
        if (ttftAborted && !abort.signal.aborted && !clientSignal?.aborted) {
          effectiveErr = new Error(`First token timeout after ${ttftMs}ms`);
        }
        if (ttftTimer) {
          clearTimeout(ttftTimer);
          ttftTimer = undefined;
        }
        // --- Retry decision ---
        if (attempt === 0 && !retried && isTransientError(effectiveErr, clientSignal)) {
          retried = true;

          if (iterContent) {
            // Mid-stream failure: partial content was already sent to client.
            // Signal the client to discard it, then ask the LLM to restate.
            res.write('event: content_reset\ndata: {}\n\n');
            messages.push({ role: 'assistant', content: iterContent });
            messages.push({ role: 'user', content: 'Your previous response was cut off. Please provide your complete response again.' });
            logger.info(`ToolLoop: mid-stream failure (iteration ${iteration}), resending after content_reset (${iterContent.length} chars discarded)`);
          } else if (!fetchOk) {
            // Pre-fetch failure: no content sent, just retry the same request
            // Roll back any messages added this iteration
            messages.length = messagesSnapshot;
            logger.info(`ToolLoop: fetch failure (iteration ${iteration}), retrying after 2s`);
          }

          await sleep(2000);
          abort.touch();
          continue; // retry the inner attempt loop
        }

        // Not retryable or already retried — propagate
        logger.error(`ToolLoop: ${fetchOk ? 'stream read' : 'LLM fetch'} error (iteration ${iteration}): ${effectiveErr}`);
        throw effectiveErr;
      }
      if (ttftTimer) {
        clearTimeout(ttftTimer);
        ttftTimer = undefined;
      }

      // --- Success path (no error thrown) ---
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
          // Check client disconnect before each tool execution
          if (clientSignal?.aborted) {
            logger.info('ToolLoop: client disconnected during tool execution, aborting');
            throw new Error('Client disconnected');
          }

          // Send tool_start event to client
          res.write(`event: tool_start\ndata: ${JSON.stringify({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })}\n\n`);
          abort.touch();

          const result = await executor.execute(
            tc.function.name,
            withDefaultGoogleProfile(tc.function.name, tc.function.arguments, opts.defaultGoogleAuthProfile),
          );

          // Send tool_end event to client
          res.write(`event: tool_end\ndata: ${JSON.stringify({
            id: tc.id,
            name: tc.function.name,
            success: result.success,
            content: result.content.slice(0, 2000), // Truncate for SSE event
            durationMs: result.durationMs,
          })}\n\n`);
          abort.touch();

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

        // Keepalive between iterations — resets both gateway and TUI client
        // inactivity timers during the TTFT gap before the next LLM call.
        res.write(': keepalive\n\n');
        abort.touch();

        // Continue the loop — LLM will see the tool results
        logger.info(`ToolLoop: iteration ${iteration + 1}, executed ${toolCalls.length} tool(s)`);
      } else if (finishReason === 'length' && continuations < MAX_CONTINUATIONS) {
        // If the model hit max output tokens, auto-continue
        continuations++;
        logger.info(`ToolLoop: output truncated (finish_reason=length), auto-continuing (${continuations}/${MAX_CONTINUATIONS})`);

        // Push the truncated assistant content so far
        messages.push({ role: 'assistant', content: iterContent });
        // Ask the model to continue
        messages.push({ role: 'user', content: 'Continue from where you left off.' });

        res.write(': keepalive\n\n');
        abort.touch();
      }

      // Break out of the retry loop — success
      break;
    }
    // ---------- end retry wrapper ----------

    // Check if we should continue the outer iteration loop
    // (tool calls and continuations set up messages above and need another iteration)
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'tool' || (lastMsg?.role === 'user' && lastMsg?.content === 'Continue from where you left off.')) {
      continue;
    }

    // Model finished with text response (or stop)
    break;
  }
  } finally {
    clearInterval(keepalive);
    abort.clear();
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
  toolChoice?: 'auto' | 'none';
  /** Optional default Google auth profile for this run. */
  defaultGoogleAuthProfile?: string;
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
  let continuations = 0;

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
        tool_choice: opts.toolChoice,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      // @ts-expect-error -- Node.js undici supports dispatcher option on fetch
      dispatcher: longTimeoutDispatcher,
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
        const result = await executor.execute(
          tc.function.name,
          withDefaultGoogleProfile(tc.function.name, tc.function.arguments, opts.defaultGoogleAuthProfile),
        );
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

    // If the model hit max output tokens, auto-continue
    if (choice?.finish_reason === 'length' && continuations < MAX_CONTINUATIONS) {
      continuations++;
      fullContent += textContent;
      logger.info(`ToolLoop (non-stream): output truncated (finish_reason=length), auto-continuing (${continuations}/${MAX_CONTINUATIONS})`);

      messages.push({ role: 'assistant', content: textContent } as any);
      messages.push({ role: 'user', content: 'Continue from where you left off.' } as any);
      continue;
    }

    // Final text response
    fullContent += textContent;
    break;
  }

  return { fullContent, responseModel, usage: lastUsage };
}
