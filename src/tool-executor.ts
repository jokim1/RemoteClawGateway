/**
 * Tool Executor
 *
 * Executes tool calls server-side. Each tool handler receives parsed
 * arguments and returns a string result.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { Logger } from './types.js';
import type { ToolRegistry } from './tool-registry.js';

/** Maximum output size per tool execution (512KB). */
const MAX_OUTPUT_BYTES = 512 * 1024;

/** Default command timeout in seconds. */
const DEFAULT_TIMEOUT_S = 30;

/** Maximum command timeout in seconds. */
const MAX_TIMEOUT_S = 120;

export interface ToolExecResult {
  success: boolean;
  content: string;
  durationMs: number;
}

export class ToolExecutor {
  private registry: ToolRegistry;
  private logger: Logger;

  constructor(registry: ToolRegistry, logger: Logger) {
    this.registry = registry;
    this.logger = logger;
  }

  /**
   * Execute a tool call by name with the given arguments JSON string.
   */
  async execute(toolName: string, argsJson: string): Promise<ToolExecResult> {
    const start = Date.now();

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return {
        success: false,
        content: `Invalid JSON arguments: ${argsJson.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }

    if (!this.registry.hasTool(toolName)) {
      return {
        success: false,
        content: `Unknown tool: ${toolName}`,
        durationMs: Date.now() - start,
      };
    }

    this.logger.info(`ToolExecutor: executing ${toolName}(${argsJson.slice(0, 200)})`);

    try {
      let result: ToolExecResult;

      switch (toolName) {
        case 'shell_exec':
          result = await this.execShell(args);
          break;
        case 'manage_tools':
          result = await this.execManageTools(args);
          break;
        default:
          // Dynamic tools — execute via shell_exec with the tool's command template
          result = {
            success: false,
            content: `Tool "${toolName}" has no execution handler. Dynamic tool execution is not yet implemented.`,
            durationMs: Date.now() - start,
          };
          break;
      }

      result.durationMs = Date.now() - start;
      this.logger.info(`ToolExecutor: ${toolName} completed (${result.success ? 'ok' : 'error'}, ${result.durationMs}ms)`);
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`ToolExecutor: ${toolName} threw: ${errMsg}`);
      return {
        success: false,
        content: `Tool execution error: ${errMsg}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // -------------------------------------------------------------------------
  // shell_exec
  // -------------------------------------------------------------------------

  private execShell(args: Record<string, unknown>): Promise<ToolExecResult> {
    const command = String(args.command ?? '');
    if (!command.trim()) {
      return Promise.resolve({
        success: false,
        content: 'Empty command',
        durationMs: 0,
      });
    }

    const timeoutS = Math.min(
      Math.max(1, Number(args.timeout) || DEFAULT_TIMEOUT_S),
      MAX_TIMEOUT_S,
    );
    const cwd = String(args.working_dir || homedir());

    return new Promise<ToolExecResult>((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let truncated = false;
      let killed = false;

      const proc = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, HOME: homedir() },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutS * 1000,
      });

      const collectOutput = (data: Buffer) => {
        if (truncated) return;
        totalBytes += data.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          const remaining = MAX_OUTPUT_BYTES - (totalBytes - data.length);
          if (remaining > 0) {
            chunks.push(data.subarray(0, remaining));
          }
          proc.kill('SIGTERM');
          killed = true;
        } else {
          chunks.push(data);
        }
      };

      proc.stdout.on('data', collectOutput);
      proc.stderr.on('data', collectOutput);

      proc.on('error', (err) => {
        resolve({
          success: false,
          content: `Process error: ${err.message}`,
          durationMs: 0,
        });
      });

      proc.on('close', (code, signal) => {
        const output = Buffer.concat(chunks).toString('utf-8');
        const suffix = truncated ? '\n\n[Output truncated at 512KB]' : '';
        const timedOut = signal === 'SIGTERM' && !killed;

        if (timedOut) {
          resolve({
            success: false,
            content: `Command timed out after ${timeoutS}s.\n\nPartial output:\n${output}${suffix}`,
            durationMs: 0,
          });
        } else {
          resolve({
            success: code === 0,
            content: output
              ? `${output}${suffix}${code !== 0 ? `\n\n[Exit code: ${code}]` : ''}`
              : code === 0 ? '(no output)' : `Command failed with exit code ${code}`,
            durationMs: 0,
          });
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // manage_tools
  // -------------------------------------------------------------------------

  private async execManageTools(args: Record<string, unknown>): Promise<ToolExecResult> {
    const action = String(args.action ?? '');

    switch (action) {
      case 'list': {
        const tools = this.registry.listTools();
        const lines = tools.map(t =>
          `- ${t.name} ${t.builtin ? '(built-in)' : '(custom)'}: ${t.description.slice(0, 100)}`
        );
        return {
          success: true,
          content: `Available tools (${tools.length}):\n${lines.join('\n')}`,
          durationMs: 0,
        };
      }

      case 'register': {
        const name = String(args.name ?? '');
        const description = String(args.description ?? '');
        if (!name || !description) {
          return {
            success: false,
            content: 'Missing required fields: name, description',
            durationMs: 0,
          };
        }
        const parameters = (args.parameters as any) ?? {
          type: 'object',
          properties: {},
        };
        const ok = this.registry.registerTool(name, description, parameters);
        return {
          success: ok,
          content: ok ? `Tool "${name}" registered successfully.` : `Failed to register tool "${name}" (name may conflict with a built-in).`,
          durationMs: 0,
        };
      }

      case 'update': {
        const name = String(args.name ?? '');
        if (!name) {
          return { success: false, content: 'Missing required field: name', durationMs: 0 };
        }
        const updates: { description?: string; parameters?: any } = {};
        if (args.description) updates.description = String(args.description);
        if (args.parameters) updates.parameters = args.parameters as any;
        const ok = this.registry.updateTool(name, updates);
        return {
          success: ok,
          content: ok ? `Tool "${name}" updated.` : `Failed to update tool "${name}" (not found or built-in).`,
          durationMs: 0,
        };
      }

      case 'remove': {
        const name = String(args.name ?? '');
        if (!name) {
          return { success: false, content: 'Missing required field: name', durationMs: 0 };
        }
        const ok = this.registry.removeTool(name);
        return {
          success: ok,
          content: ok ? `Tool "${name}" removed.` : `Failed to remove tool "${name}" (not found or built-in).`,
          durationMs: 0,
        };
      }

      default:
        return {
          success: false,
          content: `Unknown action: "${action}". Valid actions: register, update, remove, list`,
          durationMs: 0,
        };
    }
  }
}
