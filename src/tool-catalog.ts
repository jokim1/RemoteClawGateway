import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './types.js';
import type { ToolInfo } from './tool-registry.js';

export type CatalogToolStatus = 'installable' | 'planned';

export interface CatalogToolDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  status: CatalogToolStatus;
  toolNames: string[];
  requiredAuth?: string[];
  defaultInstalled?: boolean;
}

export interface CatalogToolEntry extends CatalogToolDefinition {
  installed: boolean;
  canInstall: boolean;
  missingTools: string[];
}

type CatalogPersistedState = {
  installedIds: string[];
};

const DEFAULT_DATA_DIR = join(
  process.env.HOME || '~',
  '.openclaw',
  'plugins',
  'clawtalk',
);

const CATALOG_DEFINITIONS: CatalogToolDefinition[] = [
  {
    id: 'google_docs',
    name: 'Google Docs',
    description: 'Create, read, and append Google Docs content.',
    version: '1.0.0',
    status: 'installable',
    toolNames: ['google_docs_create', 'google_docs_append', 'google_docs_read', 'google_docs_auth_status'],
    requiredAuth: ['google_oauth'],
    // Keep current behavior stable for existing users.
    defaultInstalled: true,
  },
  {
    id: 'google_docs_tabs',
    name: 'Google Docs Tabs',
    description: 'List, create, update, and delete tabs in Google Docs.',
    version: '1.0.0',
    status: 'installable',
    toolNames: [
      'google_docs_list_tabs',
      'google_docs_add_tab',
      'google_docs_update_tab',
      'google_docs_delete_tab',
    ],
    requiredAuth: ['google_oauth'],
  },
  {
    id: 'web_fetch_extract',
    name: 'Web Fetch Extract',
    description: 'Fetch a URL and return clean extracted text.',
    version: '1.0.0',
    status: 'installable',
    toolNames: ['web_fetch_extract'],
    defaultInstalled: true,
  },
  {
    id: 'google_drive_files',
    name: 'Google Drive Files',
    description: 'List/search/move files and folders in Google Drive.',
    version: '1.0.0',
    status: 'installable',
    toolNames: ['google_drive_files'],
    requiredAuth: ['google_oauth'],
  },
  {
    id: 'google_sheets',
    name: 'Google Sheets',
    description: 'Read and write spreadsheet ranges, append rows.',
    version: '0.0.0',
    status: 'planned',
    toolNames: [],
    requiredAuth: ['google_oauth'],
  },
  {
    id: 'calendar_google',
    name: 'Google Calendar',
    description: 'Read, create, and update calendar events.',
    version: '0.0.0',
    status: 'planned',
    toolNames: [],
    requiredAuth: ['google_oauth'],
  },
  {
    id: 'notion_basic',
    name: 'Notion Basic',
    description: 'Create pages and read/write simple Notion content.',
    version: '0.0.0',
    status: 'planned',
    toolNames: [],
    requiredAuth: ['notion_oauth'],
  },
  {
    id: 'github_core',
    name: 'GitHub Core',
    description: 'Core repo actions: issues, PR metadata, file reads.',
    version: '0.0.0',
    status: 'planned',
    toolNames: [],
    requiredAuth: ['github_token'],
  },
  {
    id: 'email_gmail',
    name: 'Gmail Draft & Send',
    description: 'Draft and send email with confirmation workflows.',
    version: '0.0.0',
    status: 'planned',
    toolNames: [],
    requiredAuth: ['google_oauth'],
  },
  {
    id: 'http_api_client',
    name: 'HTTP API Client',
    description: 'Call allowlisted external APIs with structured requests.',
    version: '0.0.0',
    status: 'planned',
    toolNames: [],
  },
];

export class ToolCatalog {
  private readonly logger: Logger;
  private readonly persistPath?: string;
  private readonly installedIds = new Set<string>();
  private readonly managedToolToCatalogId = new Map<string, string>();
  private readonly managedToolAuthRequirements = new Map<string, string[]>();

  constructor(dataDir: string | undefined, logger: Logger) {
    this.logger = logger;
    const resolvedDataDir = dataDir || DEFAULT_DATA_DIR;
    mkdirSync(resolvedDataDir, { recursive: true });
    this.persistPath = join(resolvedDataDir, 'tool-catalog.json');
    for (const entry of CATALOG_DEFINITIONS) {
      for (const toolName of entry.toolNames) {
        this.managedToolToCatalogId.set(toolName.toLowerCase(), entry.id);
        this.managedToolAuthRequirements.set(toolName.toLowerCase(), [...(entry.requiredAuth ?? [])]);
      }
      if (entry.defaultInstalled) this.installedIds.add(entry.id);
    }
    this.load();
  }

  list(registryTools: ToolInfo[]): CatalogToolEntry[] {
    const registered = new Set(registryTools.map((tool) => tool.name.toLowerCase()));
    return CATALOG_DEFINITIONS.map((entry) => {
      const missingTools = entry.toolNames.filter((name) => !registered.has(name.toLowerCase()));
      const canInstall = entry.status === 'installable' && missingTools.length === 0;
      return {
        ...entry,
        installed: this.installedIds.has(entry.id),
        canInstall,
        missingTools,
      };
    });
  }

  getInstalledIds(): string[] {
    return Array.from(this.installedIds);
  }

  isToolEnabled(toolName: string): boolean {
    const catalogId = this.managedToolToCatalogId.get(toolName.toLowerCase());
    if (!catalogId) return true;
    return this.installedIds.has(catalogId);
  }

  getToolRequiredAuth(toolName: string): string[] {
    return [...(this.managedToolAuthRequirements.get(toolName.toLowerCase()) ?? [])];
  }

  isManagedTool(toolName: string): boolean {
    return this.managedToolToCatalogId.has(toolName.toLowerCase());
  }

  filterEnabledTools<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter((tool) => this.isToolEnabled(tool.name));
  }

  install(toolId: string, registryTools: ToolInfo[]): {
    ok: boolean;
    error?: string;
    entry?: CatalogToolEntry;
  } {
    const entry = CATALOG_DEFINITIONS.find((row) => row.id === toolId);
    if (!entry) return { ok: false, error: `Unknown catalog tool "${toolId}"` };
    if (entry.status !== 'installable') {
      return { ok: false, error: `"${entry.name}" is not installable in this gateway build yet.` };
    }

    const registered = new Set(registryTools.map((tool) => tool.name.toLowerCase()));
    const missing = entry.toolNames.filter((name) => !registered.has(name.toLowerCase()));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Cannot install "${entry.name}" because required handlers are missing: ${missing.join(', ')}`,
      };
    }

    this.installedIds.add(toolId);
    this.save();
    return {
      ok: true,
      entry: this.list(registryTools).find((row) => row.id === toolId),
    };
  }

  uninstall(toolId: string, registryTools: ToolInfo[]): {
    ok: boolean;
    error?: string;
    entry?: CatalogToolEntry;
  } {
    const entry = CATALOG_DEFINITIONS.find((row) => row.id === toolId);
    if (!entry) return { ok: false, error: `Unknown catalog tool "${toolId}"` };
    this.installedIds.delete(toolId);
    this.save();
    return {
      ok: true,
      entry: this.list(registryTools).find((row) => row.id === toolId),
    };
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw) as CatalogPersistedState;
      const ids = Array.isArray(parsed.installedIds) ? parsed.installedIds : [];
      for (const id of ids) {
        if (CATALOG_DEFINITIONS.some((entry) => entry.id === id)) {
          this.installedIds.add(id);
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        this.logger.warn(`ToolCatalog: failed to load state from ${this.persistPath}: ${err}`);
      }
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      writeFileSync(this.persistPath, JSON.stringify({
        installedIds: Array.from(this.installedIds),
      }, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn(`ToolCatalog: failed to save: ${err}`);
    }
  }
}

const catalogSingletons = new Map<string, ToolCatalog>();

export function getToolCatalog(dataDir: string | undefined, logger: Logger): ToolCatalog {
  const key = dataDir || DEFAULT_DATA_DIR;
  const existing = catalogSingletons.get(key);
  if (existing) return existing;
  const created = new ToolCatalog(dataDir, logger);
  catalogSingletons.set(key, created);
  return created;
}
