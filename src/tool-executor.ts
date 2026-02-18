/**
 * Tool Executor
 *
 * Executes tool calls server-side. Each tool handler receives parsed
 * arguments and returns a string result.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import type { Logger } from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  googleDocsAddTab,
  googleDocsAppend,
  googleDocsAuthStatus,
  googleDocsAuthStatusForProfile,
  googleDocsCreate,
  googleDocsDeleteTab,
  googleDocsListTabs,
  googleDriveListFiles,
  googleDriveMoveFile,
  googleDriveSearchFiles,
  googleDocsRead,
  googleDocsUpdateTab,
  GOOGLE_DOCS_REQUIRED_SCOPES,
} from './google-docs.js';
import { extractGoogleDocsDocumentIdFromUrl } from './google-docs-url.js';

/** Maximum output size per tool execution (512KB). */
const MAX_OUTPUT_BYTES = 512 * 1024;

/** Default command timeout in seconds. */
const DEFAULT_TIMEOUT_S = 30;

/** Maximum command timeout in seconds. */
const MAX_TIMEOUT_S = 120;
const DEFAULT_AGENT_WORKSPACE_DIR = join(homedir(), '.openclaw', 'workspace-clawtalk');
const DEFAULT_DOWNLOADS_UPLOAD_DIR = join(homedir(), 'Downloads', 'ClawTalk');

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
        case 'google_docs_create':
          result = await this.execGoogleDocsCreate(args);
          break;
        case 'google_docs_append':
          result = await this.execGoogleDocsAppend(args);
          break;
        case 'google_docs_read':
          result = await this.execGoogleDocsRead(args);
          break;
        case 'google_docs_auth_status':
          result = await this.execGoogleDocsAuthStatus(args);
          break;
        case 'google_docs_list_tabs':
          result = await this.execGoogleDocsListTabs(args);
          break;
        case 'google_docs_add_tab':
          result = await this.execGoogleDocsAddTab(args);
          break;
        case 'google_docs_update_tab':
          result = await this.execGoogleDocsUpdateTab(args);
          break;
        case 'google_docs_delete_tab':
          result = await this.execGoogleDocsDeleteTab(args);
          break;
        case 'google_drive_files':
          result = await this.execGoogleDriveFiles(args);
          break;
        case 'web_fetch_extract':
          result = await this.execWebFetchExtract(args);
          break;
        case 'pdf_extract_text':
          result = await this.execPdfExtractText(args);
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

  // -------------------------------------------------------------------------
  // Google Docs tools
  // -------------------------------------------------------------------------

  private async execGoogleDocsCreate(args: Record<string, unknown>): Promise<ToolExecResult> {
    const title = String(args.title ?? '').trim();
    if (!title) {
      return { success: false, content: 'Missing required field: title', durationMs: 0 };
    }
    const content = args.content === undefined ? undefined : String(args.content);
    const folderId = args.folder_id === undefined ? undefined : String(args.folder_id).trim();
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();

    try {
      const created = await googleDocsCreate({
        title,
        content,
        folderId: folderId || undefined,
        profile: profile || undefined,
      });
      return {
        success: true,
        content:
          `Created Google Doc successfully.\n` +
          `Title: ${created.title}\n` +
          `Document ID: ${created.documentId}\n` +
          `URL: ${created.url}`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_docs_create failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDocsAppend(args: Record<string, unknown>): Promise<ToolExecResult> {
    const docId = String(args.doc_id ?? '').trim();
    const text = String(args.text ?? '');
    const tabId = args.tab_id === undefined ? undefined : String(args.tab_id).trim();
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    if (!docId || !text.trim()) {
      return { success: false, content: 'Missing required fields: doc_id, text', durationMs: 0 };
    }

    try {
      const appended = await googleDocsAppend({ docId, text, tabId: tabId || undefined, profile: profile || undefined });
      return {
        success: true,
        content:
          `Appended text to Google Doc.\n` +
          `Document ID: ${appended.documentId}\n` +
          `${tabId ? `Tab ID: ${tabId}\n` : ''}` +
          `Appended characters: ${appended.appendedChars}\n` +
          `URL: ${appended.url}`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_docs_append failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDocsRead(args: Record<string, unknown>): Promise<ToolExecResult> {
    const docId = String(args.doc_id ?? '').trim();
    const maxChars = args.max_chars === undefined ? undefined : Number(args.max_chars);
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    if (!docId) {
      return { success: false, content: 'Missing required field: doc_id', durationMs: 0 };
    }

    try {
      const read = await googleDocsRead({ docId, maxChars, profile: profile || undefined });
      return {
        success: true,
        content:
          `Google Doc: ${read.title}\n` +
          `Document ID: ${read.documentId}\n` +
          `URL: ${read.url}\n` +
          `Truncated: ${read.truncated ? 'yes' : 'no'}\n\n` +
          read.text,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_docs_read failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDocsAuthStatus(args?: Record<string, unknown>): Promise<ToolExecResult> {
    const profile = args?.profile === undefined ? undefined : String(args.profile).trim();
    try {
      const status = profile ? await googleDocsAuthStatusForProfile(profile) : await googleDocsAuthStatus();
      return {
        success: status.accessTokenReady,
        content:
          `Google Docs auth status:\n` +
          `Profile: ${status.profile}\n` +
          `Active profile: ${status.activeProfile}\n` +
          `Token path: ${status.tokenPath}\n` +
          `hasClientId: ${status.hasClientId}\n` +
          `hasClientSecret: ${status.hasClientSecret}\n` +
          `hasRefreshToken: ${status.hasRefreshToken}\n` +
          `accessTokenReady: ${status.accessTokenReady}\n` +
          `accountEmail: ${status.accountEmail ?? '(unknown)'}\n` +
          `accountDisplayName: ${status.accountDisplayName ?? '(unknown)'}\n` +
          `identityError: ${status.identityError ?? '(none)'}\n` +
          (status.error ? `error: ${status.error}` : 'error: (none)'),
        durationMs: 0,
      };
    } catch (err) {
      return {
        success: false,
        content: `google_docs_auth_status failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDocsListTabs(args: Record<string, unknown>): Promise<ToolExecResult> {
    const docId = String(args.doc_id ?? '').trim();
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    if (!docId) {
      return { success: false, content: 'Missing required field: doc_id', durationMs: 0 };
    }
    try {
      const listed = await googleDocsListTabs({ docId, profile: profile || undefined });
      const lines = listed.tabs.map((tab) => {
        const parts = [`- tabId=${tab.tabId}`, `title="${tab.title}"`];
        if (typeof tab.index === 'number') parts.push(`index=${tab.index}`);
        if (tab.parentTabId) parts.push(`parentTabId=${tab.parentTabId}`);
        return parts.join(' ');
      });
      return {
        success: true,
        content:
          `Google Doc tabs (${listed.tabs.length}):\n` +
          `${lines.join('\n') || '(none)'}\n` +
          `Document ID: ${listed.documentId}\n` +
          `URL: ${listed.url}`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_docs_list_tabs failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDocsAddTab(args: Record<string, unknown>): Promise<ToolExecResult> {
    const docId = String(args.doc_id ?? '').trim();
    const title = args.title === undefined ? undefined : String(args.title);
    const index = args.index === undefined ? undefined : Number(args.index);
    const parentTabId = args.parent_tab_id === undefined ? undefined : String(args.parent_tab_id);
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    if (!docId) {
      return { success: false, content: 'Missing required field: doc_id', durationMs: 0 };
    }
    try {
      const created = await googleDocsAddTab({
        docId,
        title,
        index,
        parentTabId,
        profile: profile || undefined,
      });
      return {
        success: true,
        content:
          `Added Google Doc tab.\n` +
          `Document ID: ${created.documentId}\n` +
          `${created.tabId ? `Tab ID: ${created.tabId}\n` : ''}` +
          `${created.title ? `Tab title: ${created.title}\n` : ''}` +
          `URL: ${created.url}`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_docs_add_tab failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDocsUpdateTab(args: Record<string, unknown>): Promise<ToolExecResult> {
    const docId = String(args.doc_id ?? '').trim();
    const tabId = String(args.tab_id ?? '').trim();
    const title = args.title === undefined ? undefined : String(args.title);
    const index = args.index === undefined ? undefined : Number(args.index);
    const parentTabId = args.parent_tab_id === undefined ? undefined : String(args.parent_tab_id);
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    if (!docId || !tabId) {
      return { success: false, content: 'Missing required fields: doc_id, tab_id', durationMs: 0 };
    }
    try {
      const updated = await googleDocsUpdateTab({
        docId,
        tabId,
        title,
        index,
        parentTabId,
        profile: profile || undefined,
      });
      return {
        success: true,
        content:
          `Updated Google Doc tab.\n` +
          `Document ID: ${updated.documentId}\n` +
          `Tab ID: ${updated.tabId}\n` +
          `URL: ${updated.url}`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_docs_update_tab failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDocsDeleteTab(args: Record<string, unknown>): Promise<ToolExecResult> {
    const docId = String(args.doc_id ?? '').trim();
    const tabId = String(args.tab_id ?? '').trim();
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    if (!docId || !tabId) {
      return { success: false, content: 'Missing required fields: doc_id, tab_id', durationMs: 0 };
    }
    try {
      const deleted = await googleDocsDeleteTab({
        docId,
        tabId,
        profile: profile || undefined,
      });
      return {
        success: true,
        content:
          `Deleted Google Doc tab.\n` +
          `Document ID: ${deleted.documentId}\n` +
          `Tab ID: ${deleted.tabId}\n` +
          `URL: ${deleted.url}`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_docs_delete_tab failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  private async execGoogleDriveFiles(args: Record<string, unknown>): Promise<ToolExecResult> {
    const action = String(args.action ?? '').trim().toLowerCase();
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    if (!action) {
      return { success: false, content: 'Missing required field: action', durationMs: 0 };
    }

    try {
      if (action === 'list') {
        const listed = await googleDriveListFiles({
          folderId: args.folder_id === undefined ? undefined : String(args.folder_id),
          pageSize: args.page_size === undefined ? undefined : Number(args.page_size),
          pageToken: args.page_token === undefined ? undefined : String(args.page_token),
          profile: profile || undefined,
        });
        const lines = listed.files.map((file) => {
          const type = file.mimeType?.includes('folder') ? 'folder' : 'file';
          return `- ${file.name} (${type}) id=${file.id}${file.webViewLink ? ` url=${file.webViewLink}` : ''}`;
        });
        return {
          success: true,
          content:
            `Google Drive list results (${listed.files.length}):\n` +
            `${lines.join('\n') || '(none)'}\n` +
            `${listed.nextPageToken ? `nextPageToken: ${listed.nextPageToken}` : ''}`.trim(),
          durationMs: 0,
        };
      }

      if (action === 'search') {
        const query = String(args.query ?? '').trim();
        if (!query) {
          return { success: false, content: 'Missing required field for action=search: query', durationMs: 0 };
        }
        const found = await googleDriveSearchFiles({
          query,
          folderId: args.folder_id === undefined ? undefined : String(args.folder_id),
          pageSize: args.page_size === undefined ? undefined : Number(args.page_size),
          profile: profile || undefined,
        });
        const lines = found.files.map((file) => {
          const type = file.mimeType?.includes('folder') ? 'folder' : 'file';
          return `- ${file.name} (${type}) id=${file.id}${file.webViewLink ? ` url=${file.webViewLink}` : ''}`;
        });
        return {
          success: true,
          content: `Google Drive search results (${found.files.length}) for "${query}":\n${lines.join('\n') || '(none)'}`,
          durationMs: 0,
        };
      }

      if (action === 'move') {
        const fileId = String(args.file_id ?? '').trim();
        const targetFolderId = String(args.target_folder_id ?? '').trim();
        if (!fileId || !targetFolderId) {
          return {
            success: false,
            content: 'Missing required fields for action=move: file_id, target_folder_id',
            durationMs: 0,
          };
        }
        const moved = await googleDriveMoveFile({ fileId, targetFolderId, profile: profile || undefined });
        return {
          success: true,
          content:
            `Moved file successfully.\n` +
            `Name: ${moved.name}\n` +
            `ID: ${moved.id}\n` +
            `${moved.webViewLink ? `URL: ${moved.webViewLink}\n` : ''}` +
            `${moved.parents?.length ? `Parents: ${moved.parents.join(', ')}` : ''}`.trim(),
          durationMs: 0,
        };
      }

      return {
        success: false,
        content: `Unknown action "${action}". Valid actions: list, search, move`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        content:
          `google_drive_files failed: ${msg}\n` +
          `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
        durationMs: 0,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Web fetch
  // -------------------------------------------------------------------------

  private async execWebFetchExtract(args: Record<string, unknown>): Promise<ToolExecResult> {
    const urlRaw = String(args.url ?? '').trim();
    if (!urlRaw) {
      return { success: false, content: 'Missing required field: url', durationMs: 0 };
    }

    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      return { success: false, content: `Invalid URL: ${urlRaw}`, durationMs: 0 };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, content: 'Only http:// and https:// URLs are supported.', durationMs: 0 };
    }

    const maxChars = Math.min(50_000, Math.max(500, Number(args.max_chars) || 12_000));
    const timeoutS = Math.min(60, Math.max(1, Number(args.timeout) || 15));
    const profile = args.profile === undefined ? undefined : String(args.profile).trim();
    const googleDocId = extractGoogleDocsDocumentIdFromUrl(urlRaw);

    if (googleDocId) {
      try {
        const read = await googleDocsRead({
          docId: googleDocId,
          maxChars,
          profile: profile || undefined,
        });
        return {
          success: true,
          content:
            `Auto-routed from web_fetch_extract to google_docs_read for authenticated Google Docs access.\n` +
            `Google Doc: ${read.title}\n` +
            `Document ID: ${read.documentId}\n` +
            `URL: ${read.url}\n` +
            `Truncated: ${read.truncated ? 'yes' : 'no'}\n\n` +
            read.text,
          durationMs: 0,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          content:
            `Google Docs URL detected. web_fetch_extract cannot reliably access Google Docs due to auth/cookie walls.\n` +
            `Attempted authenticated fallback via google_docs_read and failed: ${msg}\n` +
            `Required OAuth scopes: ${GOOGLE_DOCS_REQUIRED_SCOPES.join(', ')}`,
          durationMs: 0,
        };
      }
    }

    try {
      const res = await fetch(parsed, {
        method: 'GET',
        headers: { 'User-Agent': 'ClawTalkGateway/1.0 (+tool:web_fetch_extract)' },
        signal: AbortSignal.timeout(timeoutS * 1000),
      });
      if (!res.ok) {
        return {
          success: false,
          content: `Fetch failed with HTTP ${res.status} ${res.statusText}`,
          durationMs: 0,
        };
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const body = await res.text();
      let text = body;
      let title = '';

      if (contentType.includes('text/html') || /<html[\s>]/i.test(body)) {
        const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
        text = body
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/\s+/g, ' ')
          .trim();
      } else if (contentType.includes('application/json')) {
        try {
          text = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          text = body;
        }
      } else {
        text = body.replace(/\s+/g, ' ').trim();
      }

      if (!text) {
        return { success: true, content: 'Fetched successfully, but no readable text was extracted.', durationMs: 0 };
      }

      const clipped = text.length > maxChars;
      const output = text.slice(0, maxChars);
      const meta =
        `URL: ${parsed.toString()}\n` +
        (title ? `Title: ${title}\n` : '') +
        `Content-Type: ${contentType || '(unknown)'}\n` +
        `Characters: ${text.length}${clipped ? ` (clipped to ${maxChars})` : ''}\n`;

      return {
        success: true,
        content: `${meta}\n${output}`,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, content: `web_fetch_extract failed: ${msg}`, durationMs: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // PDF extraction
  // -------------------------------------------------------------------------

  private resolvePdfHostPath(rawPath: string): string {
    const input = rawPath.trim();
    if (!input) throw new Error('Missing required field: path');
    if (!/\.pdf$/i.test(input)) throw new Error('Path must point to a .pdf file');

    const workspaceRoot = (process.env.CLAWTALK_AGENT_WORKSPACE_DIR || DEFAULT_AGENT_WORKSPACE_DIR).trim() || DEFAULT_AGENT_WORKSPACE_DIR;
    const allowedRoots = [
      resolve(workspaceRoot),
      resolve(DEFAULT_DOWNLOADS_UPLOAD_DIR),
    ];

    let candidate: string;
    if (input.startsWith('/workspace/')) {
      const rel = input.slice('/workspace/'.length);
      candidate = resolve(workspaceRoot, rel);
    } else if (isAbsolute(input)) {
      candidate = resolve(input);
    } else {
      candidate = resolve(workspaceRoot, input);
    }

    const inAllowedRoot = allowedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
    if (!inAllowedRoot) {
      throw new Error(`PDF path is outside allowed roots. Allowed: ${allowedRoots.join(', ')}`);
    }
    if (extname(candidate).toLowerCase() !== '.pdf') {
      throw new Error('Path must end in .pdf');
    }
    return candidate;
  }

  private async execPdfExtractText(args: Record<string, unknown>): Promise<ToolExecResult> {
    const inputPath = String(args.path ?? '').trim();
    const maxChars = Math.max(500, Math.min(200_000, Number(args.max_chars) || 20_000));

    let hostPath: string;
    try {
      hostPath = this.resolvePdfHostPath(inputPath);
    } catch (err) {
      return {
        success: false,
        content: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      };
    }

    try {
      await access(hostPath, fsConstants.R_OK);
    } catch {
      return {
        success: false,
        content: `PDF file is not readable at: ${hostPath}`,
        durationMs: 0,
      };
    }

    const extraction = await new Promise<{ ok: boolean; text: string; error?: string }>((resolvePromise) => {
      const proc = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', hostPath, '-'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      proc.on('error', (spawnErr) => {
        resolvePromise({ ok: false, text: '', error: `pdftotext failed to start: ${spawnErr.message}` });
      });
      proc.on('close', (code) => {
        const stderr = Buffer.concat(err).toString('utf-8').trim();
        if (code !== 0) {
          resolvePromise({ ok: false, text: '', error: stderr || `pdftotext exited with code ${code}` });
          return;
        }
        const text = Buffer.concat(out).toString('utf-8');
        resolvePromise({ ok: true, text });
      });
    });

    if (!extraction.ok) {
      return {
        success: false,
        content:
          `pdf_extract_text failed: ${extraction.error}\n` +
          'Ensure poppler/pdftotext is installed on the gateway host.',
        durationMs: 0,
      };
    }

    const normalized = extraction.text.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return {
        success: false,
        content: 'No readable text extracted from PDF (possibly scanned image PDF).',
        durationMs: 0,
      };
    }
    const clipped = normalized.length > maxChars;
    const output = clipped ? normalized.slice(0, maxChars) : normalized;
    return {
      success: true,
      content:
        `PDF: ${hostPath}\n` +
        `Characters: ${normalized.length}${clipped ? ` (clipped to ${maxChars})` : ''}\n\n` +
        output,
      durationMs: 0,
    };
  }
}
