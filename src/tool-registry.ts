/**
 * Tool Registry
 *
 * Manages tool definitions for LLM function calling. Built-in tools
 * (shell_exec, manage_tools) are hardcoded. Dynamic tools can be
 * registered at runtime and are persisted to {dataDir}/tools.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './types.js';

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameter>;
      required?: string[];
    };
  };
}

/** Simplified tool info for listing. */
export interface ToolInfo {
  name: string;
  description: string;
  builtin: boolean;
}

// ---------------------------------------------------------------------------
// Built-in tool definitions
// ---------------------------------------------------------------------------

const SHELL_EXEC_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_exec',
    description:
      'Execute a shell command on the server. Use this for file operations, ' +
      'web requests (curl/wget), package installation, code execution, and ' +
      'any other task that can be accomplished via a shell command. ' +
      'Commands run in a bash shell with a default timeout of 30 seconds.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in seconds (default 30, max 120).',
        },
        working_dir: {
          type: 'string',
          description: 'Working directory for the command. Defaults to home directory.',
        },
      },
      required: ['command'],
    },
  },
};

const MANAGE_TOOLS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'manage_tools',
    description:
      'Manage the tool registry. Register new tools, update existing ones, ' +
      'remove tools, or list all available tools. Use this to expand your ' +
      'own capabilities by creating custom tools.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The action to perform.',
          enum: ['register', 'update', 'remove', 'list'],
        },
        name: {
          type: 'string',
          description: 'Tool name (required for register/update/remove).',
        },
        description: {
          type: 'string',
          description: 'Tool description (required for register, optional for update).',
        },
        parameters: {
          type: 'object',
          description: 'Tool parameters schema (required for register, optional for update).',
        },
      },
      required: ['action'],
    },
  },
};

const BUILTIN_TOOLS = new Map<string, ToolDefinition>([
  ['shell_exec', SHELL_EXEC_TOOL],
  ['manage_tools', MANAGE_TOOLS_TOOL],
]);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private dynamicTools = new Map<string, ToolDefinition>();
  private persistPath: string | undefined;
  private logger: Logger;

  constructor(dataDir: string | undefined, logger: Logger) {
    this.logger = logger;
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      this.persistPath = join(dataDir, 'tools.json');
      this.load();
    }
  }

  /** Get all tool schemas in OpenAI format for LLM calls. */
  getToolSchemas(): ToolDefinition[] {
    return [
      ...BUILTIN_TOOLS.values(),
      ...this.dynamicTools.values(),
    ];
  }

  /** Get a single tool definition by name. */
  getTool(name: string): ToolDefinition | undefined {
    return BUILTIN_TOOLS.get(name) ?? this.dynamicTools.get(name);
  }

  /** Check if a tool exists. */
  hasTool(name: string): boolean {
    return BUILTIN_TOOLS.has(name) || this.dynamicTools.has(name);
  }

  /** List all tools with metadata. */
  listTools(): ToolInfo[] {
    const result: ToolInfo[] = [];
    for (const [name, tool] of BUILTIN_TOOLS) {
      result.push({ name, description: tool.function.description, builtin: true });
    }
    for (const [name, tool] of this.dynamicTools) {
      result.push({ name, description: tool.function.description, builtin: false });
    }
    return result;
  }

  /** Register a new dynamic tool. Returns false if name conflicts with a built-in. */
  registerTool(name: string, description: string, parameters: ToolDefinition['function']['parameters']): boolean {
    if (BUILTIN_TOOLS.has(name)) {
      this.logger.warn(`ToolRegistry: cannot override built-in tool "${name}"`);
      return false;
    }
    const tool: ToolDefinition = {
      type: 'function',
      function: { name, description, parameters },
    };
    this.dynamicTools.set(name, tool);
    this.save();
    this.logger.info(`ToolRegistry: registered tool "${name}"`);
    return true;
  }

  /** Update an existing dynamic tool. Returns false if not found or built-in. */
  updateTool(name: string, updates: { description?: string; parameters?: ToolDefinition['function']['parameters'] }): boolean {
    if (BUILTIN_TOOLS.has(name)) {
      this.logger.warn(`ToolRegistry: cannot modify built-in tool "${name}"`);
      return false;
    }
    const existing = this.dynamicTools.get(name);
    if (!existing) return false;

    if (updates.description) existing.function.description = updates.description;
    if (updates.parameters) existing.function.parameters = updates.parameters;
    this.dynamicTools.set(name, existing);
    this.save();
    this.logger.info(`ToolRegistry: updated tool "${name}"`);
    return true;
  }

  /** Remove a dynamic tool. Returns false if not found or built-in. */
  removeTool(name: string): boolean {
    if (BUILTIN_TOOLS.has(name)) {
      this.logger.warn(`ToolRegistry: cannot remove built-in tool "${name}"`);
      return false;
    }
    if (!this.dynamicTools.has(name)) return false;
    this.dynamicTools.delete(name);
    this.save();
    this.logger.info(`ToolRegistry: removed tool "${name}"`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, ToolDefinition>;
      for (const [name, tool] of Object.entries(data)) {
        if (!BUILTIN_TOOLS.has(name)) {
          this.dynamicTools.set(name, tool);
        }
      }
      this.logger.info(`ToolRegistry: loaded ${this.dynamicTools.size} dynamic tool(s)`);
    } catch {
      // No file or parse error — start fresh
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      const data: Record<string, ToolDefinition> = {};
      for (const [name, tool] of this.dynamicTools) {
        data[name] = tool;
      }
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn(`ToolRegistry: failed to save: ${err}`);
    }
  }
}
