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

const GOOGLE_DOCS_CREATE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'google_docs_create',
    description:
      'Create a Google Doc with a title, optionally seed it with initial text, ' +
      'and optionally move it into a Drive folder. Requires configured Google OAuth token.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Document title.',
        },
        content: {
          type: 'string',
          description: 'Optional initial document content.',
        },
        folder_id: {
          type: 'string',
          description: 'Optional Google Drive folder ID to move the document into.',
        },
        profile: {
          type: 'string',
          description: 'Optional Google auth profile name (defaults to active profile or talk default).',
        },
      },
      required: ['title'],
    },
  },
};

const GOOGLE_DOCS_APPEND_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'google_docs_append',
    description:
      'Append text to an existing Google Doc. Accepts either a raw doc ID or full Google Docs URL.',
    parameters: {
      type: 'object',
      properties: {
        doc_id: {
          type: 'string',
          description: 'Google Docs document ID or full docs.google.com document URL.',
        },
        text: {
          type: 'string',
          description: 'Text to append at the end of the document.',
        },
        profile: {
          type: 'string',
          description: 'Optional Google auth profile name (defaults to active profile or talk default).',
        },
      },
      required: ['doc_id', 'text'],
    },
  },
};

const GOOGLE_DOCS_READ_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'google_docs_read',
    description:
      'Read text content from a Google Doc. Accepts either a raw doc ID or full Google Docs URL.',
    parameters: {
      type: 'object',
      properties: {
        doc_id: {
          type: 'string',
          description: 'Google Docs document ID or full docs.google.com document URL.',
        },
        max_chars: {
          type: 'number',
          description: 'Optional max characters to return (default 20000).',
        },
        profile: {
          type: 'string',
          description: 'Optional Google auth profile name (defaults to active profile or talk default).',
        },
      },
      required: ['doc_id'],
    },
  },
};

const GOOGLE_DOCS_AUTH_STATUS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'google_docs_auth_status',
    description:
      'Check Google Docs OAuth readiness for this gateway (token file/env presence + access token refresh test).',
    parameters: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Optional Google auth profile name to inspect.',
        },
      },
    },
  },
};

const WEB_FETCH_EXTRACT_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_fetch_extract',
    description:
      'Fetch a URL and return cleaned text content for summarization/research. ' +
      'Supports HTML, plain text, and JSON responses. For Google Docs URLs, use google_docs_read.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'HTTP(S) URL to fetch.',
        },
        max_chars: {
          type: 'number',
          description: 'Optional max characters to return (default 12000, max 50000).',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in seconds (default 15, max 60).',
        },
      },
      required: ['url'],
    },
  },
};

const GOOGLE_DRIVE_FILES_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'google_drive_files',
    description:
      'Work with Google Drive files and folders. Supports list, search by name, and move file operations.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform.',
          enum: ['list', 'search', 'move'],
        },
        folder_id: {
          type: 'string',
          description: 'Optional Drive folder ID (or URL) to scope list/search.',
        },
        query: {
          type: 'string',
          description: 'Search text for action=search (matches file/folder names).',
        },
        page_size: {
          type: 'number',
          description: 'Optional result count (default 25, max 200).',
        },
        page_token: {
          type: 'string',
          description: 'Optional pagination token for action=list.',
        },
        file_id: {
          type: 'string',
          description: 'File ID (or URL) for action=move.',
        },
        target_folder_id: {
          type: 'string',
          description: 'Target folder ID (or URL) for action=move.',
        },
        profile: {
          type: 'string',
          description: 'Optional Google auth profile name (defaults to active profile or talk default).',
        },
      },
      required: ['action'],
    },
  },
};

const BUILTIN_TOOLS = new Map<string, ToolDefinition>([
  ['shell_exec', SHELL_EXEC_TOOL],
  ['manage_tools', MANAGE_TOOLS_TOOL],
  ['google_docs_create', GOOGLE_DOCS_CREATE_TOOL],
  ['google_docs_append', GOOGLE_DOCS_APPEND_TOOL],
  ['google_docs_read', GOOGLE_DOCS_READ_TOOL],
  ['google_docs_auth_status', GOOGLE_DOCS_AUTH_STATUS_TOOL],
  ['google_drive_files', GOOGLE_DRIVE_FILES_TOOL],
  ['web_fetch_extract', WEB_FETCH_EXTRACT_TOOL],
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

  /** Maximum number of dynamic tools allowed. */
  private static readonly MAX_DYNAMIC_TOOLS = 200;

  /** Register a new dynamic tool. Returns false if name conflicts with a built-in or limit reached. */
  registerTool(name: string, description: string, parameters: ToolDefinition['function']['parameters']): boolean {
    if (BUILTIN_TOOLS.has(name)) {
      this.logger.warn(`ToolRegistry: cannot override built-in tool "${name}"`);
      return false;
    }
    // Reject if at capacity (updates to existing tools are still allowed)
    if (!this.dynamicTools.has(name) && this.dynamicTools.size >= ToolRegistry.MAX_DYNAMIC_TOOLS) {
      this.logger.warn(`ToolRegistry: dynamic tool limit reached (${ToolRegistry.MAX_DYNAMIC_TOOLS}), rejecting "${name}"`);
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
    } catch (err) {
      this.logger.warn(`ToolRegistry: failed to load tools from ${this.persistPath}: ${err}`);
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
