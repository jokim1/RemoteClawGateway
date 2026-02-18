import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { extractGoogleDocsDocumentIdFromUrl } from './google-docs-url.js';

type OAuthTokenFile = {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  token_uri?: string;
  access_token?: string;
  expiry_date?: number;
};

type OAuthTokenStore = {
  version?: number;
  activeProfile?: string;
  profiles?: Record<string, OAuthTokenFile>;
};

const DEFAULT_TOKEN_PATH = path.join(homedir(), '.openclaw', 'workspace', 'gdocs_token.json');
const GOOGLE_DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_PROFILE = 'default';
const OAUTH_SESSION_TTL_MS = 10 * 60_000;

type OAuthConnectSession = {
  id: string;
  state: string;
  profile?: string;
  redirectUri: string;
  createdAt: number;
  status: 'pending' | 'success' | 'error';
  error?: string;
  profileResolved?: string;
  accountEmail?: string;
  accountDisplayName?: string;
};

const oauthSessions = new Map<string, OAuthConnectSession>();

function normalizeProfileName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed) return DEFAULT_PROFILE;
  const normalized = trimmed.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_PROFILE;
}

function normalizeProfileFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const domain = email.split('@')[1] ?? '';
  const base = `${local}-${domain}`.toLowerCase();
  const normalized = base.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_PROFILE;
}

function cleanupOAuthSessions(now = Date.now()): void {
  for (const [id, session] of oauthSessions.entries()) {
    if (now - session.createdAt > OAUTH_SESSION_TTL_MS) {
      oauthSessions.delete(id);
    }
  }
}

function findOAuthSessionByState(state: string): OAuthConnectSession | undefined {
  cleanupOAuthSessions();
  for (const session of oauthSessions.values()) {
    if (session.state === state) return session;
  }
  return undefined;
}

function resolveTokenPath(): string {
  const fromEnv = process.env.GOOGLE_DOCS_TOKEN_PATH?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_TOKEN_PATH;
}

function isStoreShape(value: unknown): value is OAuthTokenStore {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'profiles' in (value as Record<string, unknown>));
}

function toStoreShape(raw: unknown): OAuthTokenStore {
  if (isStoreShape(raw)) {
    const store = raw as OAuthTokenStore;
    const activeProfile = normalizeProfileName(store.activeProfile);
    const profiles: Record<string, OAuthTokenFile> = {};
    for (const [name, rec] of Object.entries(store.profiles ?? {})) {
      if (!rec || typeof rec !== 'object') continue;
      profiles[normalizeProfileName(name)] = rec as OAuthTokenFile;
    }
    if (!profiles[activeProfile]) {
      profiles[activeProfile] = {};
    }
    return {
      version: 2,
      activeProfile,
      profiles,
    };
  }

  const legacy = (raw && typeof raw === 'object' ? raw as OAuthTokenFile : {});
  return {
    version: 2,
    activeProfile: DEFAULT_PROFILE,
    profiles: {
      [DEFAULT_PROFILE]: legacy,
    },
  };
}

async function loadTokenStore(): Promise<{ store: OAuthTokenStore; tokenPath: string }> {
  const tokenPath = resolveTokenPath();
  const raw = await fsp.readFile(tokenPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return { store: toStoreShape(parsed), tokenPath };
}

async function saveTokenStore(tokenPath: string, store: OAuthTokenStore): Promise<void> {
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify(store, null, 2));
}

function resolveProfileRecord(
  store: OAuthTokenStore,
  profile: string | undefined,
): { profile: string; record: OAuthTokenFile } {
  const activeProfile = normalizeProfileName(store.activeProfile);
  const selectedProfile = normalizeProfileName(profile) || activeProfile;
  const profiles = store.profiles ?? {};
  return {
    profile: selectedProfile,
    record: profiles[selectedProfile] ?? {},
  };
}

function mergeEnvOAuthOverrides(profile: string, record: OAuthTokenFile): OAuthTokenFile {
  // Keep env overrides only for default profile to preserve existing single-account behavior
  // without unexpectedly hijacking explicitly-selected non-default profiles.
  if (profile !== DEFAULT_PROFILE) return record;
  return {
    ...record,
    ...(process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ? { client_id: process.env.GOOGLE_OAUTH_CLIENT_ID.trim() } : {}),
    ...(process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ? { client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET.trim() } : {}),
    ...(process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() ? { refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN.trim() } : {}),
    ...(process.env.GOOGLE_OAUTH_TOKEN_URI?.trim() ? { token_uri: process.env.GOOGLE_OAUTH_TOKEN_URI.trim() } : {}),
  };
}

function getOAuthClientConfig(profile: string, record: OAuthTokenFile): {
  clientId: string;
  clientSecret: string;
  tokenUri: string;
} {
  const auth = mergeEnvOAuthOverrides(profile, record);
  const clientId = auth.client_id?.trim() ?? '';
  const clientSecret = auth.client_secret?.trim() ?? '';
  const tokenUri = auth.token_uri?.trim() || 'https://oauth2.googleapis.com/token';
  if (!clientId || !clientSecret) {
    throw new Error(
      `Google OAuth client is not configured for profile "${profile}". Set client_id and client_secret first.`,
    );
  }
  return { clientId, clientSecret, tokenUri };
}

async function refreshAccessToken(profile: string, record: OAuthTokenFile): Promise<{ accessToken: string; expiresIn?: number }> {
  const auth = mergeEnvOAuthOverrides(profile, record);
  const clientId = auth.client_id?.trim();
  const clientSecret = auth.client_secret?.trim();
  const refreshToken = auth.refresh_token?.trim();
  const tokenUri = auth.token_uri?.trim() || 'https://oauth2.googleapis.com/token';

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google Docs auth is not configured. Missing client_id/client_secret/refresh_token (env or token file).',
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const compactErr = errText.slice(0, 400);
    if (res.status === 400 && /invalid_grant/i.test(compactErr)) {
      throw new Error(
        `Google OAuth refresh token is invalid or expired (invalid_grant). `
        + `Re-auth Google and update client_id/client_secret/refresh_token in ${resolveTokenPath()}. `
        + `Raw response: ${compactErr}`,
      );
    }
    throw new Error(`Google OAuth token refresh failed (${res.status}): ${compactErr}`);
  }

  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Google OAuth token refresh returned no access token.');
  }

  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

async function getAccessToken(profile: string | undefined): Promise<string> {
  const { store, tokenPath } = await loadTokenStore();
  const selected = resolveProfileRecord(store, profile);
  const mergedRecord = mergeEnvOAuthOverrides(selected.profile, selected.record);
  const record = {
    ...selected.record,
    ...mergedRecord,
  };

  const now = Date.now();
  const validAccessToken =
    record.access_token
    && typeof record.expiry_date === 'number'
    && record.expiry_date > now + 60_000;

  if (validAccessToken) return record.access_token as string;

  const refreshed = await refreshAccessToken(selected.profile, record);
  const nextRecord: OAuthTokenFile = {
    ...record,
    access_token: refreshed.accessToken,
  };
  if (typeof refreshed.expiresIn === 'number') {
    nextRecord.expiry_date = now + refreshed.expiresIn * 1000;
  }
  const nextStore: OAuthTokenStore = {
    version: 2,
    activeProfile: normalizeProfileName(store.activeProfile),
    profiles: {
      ...(store.profiles ?? {}),
      [selected.profile]: nextRecord,
    },
  };
  await saveTokenStore(tokenPath, nextStore);
  return refreshed.accessToken;
}

function parseDocumentId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Document ID is required.');
  const fromUrl = extractGoogleDocsDocumentIdFromUrl(trimmed);
  return (fromUrl ?? trimmed).trim();
}

function parseDriveFileId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('File ID is required.');
  const fromDocsUrl =
    trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)
    ?? trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
    ?? trimmed.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/)
    ?? trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)
    ?? trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return (fromDocsUrl?.[1] ?? trimmed).trim();
}

async function googleFetchJson(url: string, init: RequestInit, profile?: string): Promise<any> {
  const token = await getAccessToken(profile);
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Google API failed (${res.status}): ${err.slice(0, 300)}`);
  }
  return await res.json();
}

async function googleFetchText(url: string, init: RequestInit, profile?: string): Promise<string> {
  const token = await getAccessToken(profile);
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Google API failed (${res.status}): ${err.slice(0, 300)}`);
  }
  return await res.text();
}

function isDocsApiDisabledErrorMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('google docs api has not been used')
    || (m.includes('docs.googleapis.com') && m.includes('disabled'))
  );
}

async function getDocumentEndIndex(docId: string, profile?: string): Promise<number> {
  const doc = await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`,
    { method: 'GET' },
    profile,
  );
  const content = Array.isArray(doc?.body?.content) ? doc.body.content : [];
  if (content.length === 0) return 1;
  const last = content[content.length - 1];
  const end = typeof last?.endIndex === 'number' ? last.endIndex : 1;
  return Math.max(1, end - 1);
}

function extractDocumentText(doc: any): string {
  const content = Array.isArray(doc?.body?.content) ? doc.body.content : [];
  const parts: string[] = [];

  for (const block of content) {
    const elems = block?.paragraph?.elements;
    if (!Array.isArray(elems)) continue;
    for (const elem of elems) {
      const t = elem?.textRun?.content;
      if (typeof t === 'string') parts.push(t);
    }
  }

  return parts.join('').trim();
}

export interface GoogleDocsTabSummary {
  tabId: string;
  title: string;
  index?: number;
  parentTabId?: string;
}

function collectTabs(
  tabs: unknown,
  output: GoogleDocsTabSummary[],
  parentTabId?: string,
): void {
  if (!Array.isArray(tabs)) return;
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object') continue;
    const rec = tab as Record<string, unknown>;
    const props = (rec.tabProperties && typeof rec.tabProperties === 'object')
      ? rec.tabProperties as Record<string, unknown>
      : undefined;
    const tabId = typeof props?.tabId === 'string' ? props.tabId : '';
    if (tabId) {
      output.push({
        tabId,
        title: typeof props?.title === 'string' ? props.title : 'Untitled',
        ...(typeof props?.index === 'number' ? { index: props.index } : {}),
        ...(parentTabId ? { parentTabId } : {}),
      });
    }
    collectTabs(rec.childTabs, output, tabId || parentTabId);
  }
}

export async function googleDocsCreate(params: {
  title: string;
  content?: string;
  folderId?: string;
  profile?: string;
}): Promise<{ documentId: string; url: string; title: string }> {
  const title = params.title.trim();
  if (!title) throw new Error('title is required.');

  const created = await googleFetchJson('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    body: JSON.stringify({ title }),
  }, params.profile);

  const documentId = String(created?.documentId ?? '');
  if (!documentId) throw new Error('Google Docs create returned no documentId.');

  const content = params.content?.trim();
  if (content) {
    const index = await getDocumentEndIndex(documentId, params.profile);
    await googleFetchJson(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index },
                text: content,
              },
            },
          ],
        }),
      },
      params.profile,
    );
  }

  const folderId = params.folderId?.trim();
  if (folderId) {
    const meta = await googleFetchJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}?fields=parents`,
      { method: 'GET' },
      params.profile,
    );
    const existingParents = Array.isArray(meta?.parents) ? meta.parents.filter((p: unknown): p is string => typeof p === 'string') : [];
    const removeParents = existingParents.join(',');
    const moveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}`);
    moveUrl.searchParams.set('addParents', folderId);
    if (removeParents) moveUrl.searchParams.set('removeParents', removeParents);
    moveUrl.searchParams.set('fields', 'id,parents');
    await googleFetchJson(moveUrl.toString(), { method: 'PATCH' }, params.profile);
  }

  return {
    documentId,
    title,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsAppend(params: {
  docId: string;
  text: string;
  tabId?: string;
  profile?: string;
}): Promise<{ documentId: string; appendedChars: number; url: string }> {
  const documentId = parseDocumentId(params.docId);
  const text = params.text ?? '';
  if (!text.trim()) throw new Error('text is required.');

  const tabId = params.tabId?.trim();
  const index = tabId ? undefined : await getDocumentEndIndex(documentId, params.profile);
  await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              ...(tabId
                ? { endOfSegmentLocation: { ...(tabId ? { tabId } : {}) } }
                : { location: { index } }),
              text,
            },
          },
        ],
      }),
    },
    params.profile,
  );

  return {
    documentId,
    appendedChars: text.length,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsListTabs(params: {
  docId: string;
  profile?: string;
}): Promise<{ documentId: string; url: string; tabs: GoogleDocsTabSummary[] }> {
  const documentId = parseDocumentId(params.docId);
  const url = new URL(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
  url.searchParams.set('includeTabsContent', 'true');
  url.searchParams.set('fields', 'documentId,title,tabs(tabProperties(tabId,title,index,parentTabId),childTabs)');
  const doc = await googleFetchJson(url.toString(), { method: 'GET' }, params.profile);
  const tabs: GoogleDocsTabSummary[] = [];
  collectTabs(doc?.tabs, tabs);
  return {
    documentId,
    tabs,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsAddTab(params: {
  docId: string;
  title?: string;
  index?: number;
  parentTabId?: string;
  profile?: string;
}): Promise<{ documentId: string; url: string; tabId?: string; title?: string }> {
  const documentId = parseDocumentId(params.docId);
  const title = params.title?.trim();
  const parentTabId = params.parentTabId?.trim();
  const index = Number.isFinite(params.index) ? Math.max(0, Number(params.index)) : undefined;
  await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            addDocumentTab: {
              tabProperties: {
                ...(title ? { title } : {}),
                ...(index !== undefined ? { index } : {}),
                ...(parentTabId ? { parentTabId } : {}),
              },
            },
          },
        ],
      }),
    },
    params.profile,
  );
  const listed = await googleDocsListTabs({ docId: documentId, profile: params.profile });
  const candidates = listed.tabs.filter((tab) => {
    if (title && tab.title !== title) return false;
    if (index !== undefined && tab.index !== index) return false;
    if (parentTabId && tab.parentTabId !== parentTabId) return false;
    return true;
  });
  const newest = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
  return {
    documentId,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
    ...(newest?.tabId ? { tabId: newest.tabId } : {}),
    ...(newest?.title ? { title: newest.title } : {}),
  };
}

export async function googleDocsUpdateTab(params: {
  docId: string;
  tabId: string;
  title?: string;
  index?: number;
  parentTabId?: string;
  profile?: string;
}): Promise<{ documentId: string; url: string; tabId: string }> {
  const documentId = parseDocumentId(params.docId);
  const tabId = params.tabId.trim();
  if (!tabId) throw new Error('tabId is required.');
  const title = params.title?.trim();
  const parentTabId = params.parentTabId?.trim();
  const index = Number.isFinite(params.index) ? Math.max(0, Number(params.index)) : undefined;
  const fieldPaths: string[] = [];
  if (title !== undefined) fieldPaths.push('title');
  if (index !== undefined) fieldPaths.push('index');
  if (parentTabId !== undefined) fieldPaths.push('parentTabId');
  if (fieldPaths.length === 0) {
    throw new Error('At least one of title, index, or parentTabId is required.');
  }

  await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            updateDocumentTabProperties: {
              tabProperties: {
                tabId,
                ...(title !== undefined ? { title } : {}),
                ...(index !== undefined ? { index } : {}),
                ...(parentTabId !== undefined ? { parentTabId } : {}),
              },
              fields: fieldPaths.join(','),
            },
          },
        ],
      }),
    },
    params.profile,
  );

  return {
    documentId,
    tabId,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsDeleteTab(params: {
  docId: string;
  tabId: string;
  profile?: string;
}): Promise<{ documentId: string; tabId: string; url: string }> {
  const documentId = parseDocumentId(params.docId);
  const tabId = params.tabId.trim();
  if (!tabId) throw new Error('tabId is required.');
  await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            deleteTab: { tabId },
          },
        ],
      }),
    },
    params.profile,
  );
  return {
    documentId,
    tabId,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsRead(params: {
  docId: string;
  maxChars?: number;
  profile?: string;
}): Promise<{ documentId: string; title: string; text: string; truncated: boolean; url: string }> {
  const documentId = parseDocumentId(params.docId);
  const maxChars = Math.max(500, Math.min(200_000, Number(params.maxChars) || 20_000));

  let title = 'Untitled';
  let fullText = '';
  try {
    const doc = await googleFetchJson(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
      { method: 'GET' },
      params.profile,
    );
    title = String(doc?.title ?? 'Untitled');
    fullText = extractDocumentText(doc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isDocsApiDisabledErrorMessage(msg)) throw err;

    // Fallback for projects with Drive OAuth configured but Docs API disabled:
    // export as plain text through Drive API.
    fullText = (await googleFetchText(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}/export?mimeType=text/plain`,
      { method: 'GET' },
      params.profile,
    )).trim();
    try {
      const file = await googleFetchJson(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}?fields=name`,
        { method: 'GET' },
        params.profile,
      );
      if (typeof file?.name === 'string' && file.name.trim()) {
        title = file.name.trim();
      }
    } catch {
      // best effort title lookup
    }
  }

  const truncated = fullText.length > maxChars;
  const text = truncated ? fullText.slice(0, maxChars) : fullText;

  return {
    documentId,
    title,
    text,
    truncated,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsAuthStatus(): Promise<{
  profile: string;
  activeProfile: string;
  tokenPath: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  accessTokenReady: boolean;
  accountEmail?: string;
  accountDisplayName?: string;
  identityError?: string;
  error?: string;
}> {
  return googleDocsAuthStatusForProfile(undefined);
}

export async function googleDocsAuthStatusForProfile(profile: string | undefined): Promise<{
  profile: string;
  activeProfile: string;
  tokenPath: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  accessTokenReady: boolean;
  accountEmail?: string;
  accountDisplayName?: string;
  identityError?: string;
  error?: string;
}> {
  const tokenPath = resolveTokenPath();
  let store: OAuthTokenStore = {
    version: 2,
    activeProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: {} },
  };
  let selectedProfile = DEFAULT_PROFILE;
  let record: OAuthTokenFile = {};

  try {
    const loaded = await loadTokenStore();
    store = loaded.store;
    const selected = resolveProfileRecord(store, profile);
    selectedProfile = selected.profile;
    record = selected.record;
  } catch (err) {
    return {
      profile: normalizeProfileName(profile),
      activeProfile: normalizeProfileName(store.activeProfile),
      tokenPath,
      hasClientId: false,
      hasClientSecret: false,
      hasRefreshToken: false,
      accessTokenReady: false,
      error: `Token file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const auth = mergeEnvOAuthOverrides(selectedProfile, record);
  const clientId = auth.client_id?.trim();
  const clientSecret = auth.client_secret?.trim();
  const refreshToken = auth.refresh_token?.trim();

  try {
    await getAccessToken(selectedProfile);
    let accountEmail: string | undefined;
    let accountDisplayName: string | undefined;
    let identityError: string | undefined;
    try {
      const about = await googleFetchJson(
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)',
        { method: 'GET' },
        selectedProfile,
      );
      accountEmail = typeof about?.user?.emailAddress === 'string' ? about.user.emailAddress : undefined;
      accountDisplayName = typeof about?.user?.displayName === 'string' ? about.user.displayName : undefined;
    } catch (err) {
      identityError = err instanceof Error ? err.message : String(err);
    }
    return {
      profile: selectedProfile,
      activeProfile: normalizeProfileName(store.activeProfile),
      tokenPath,
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRefreshToken: Boolean(refreshToken),
      accessTokenReady: true,
      ...(accountEmail ? { accountEmail } : {}),
      ...(accountDisplayName ? { accountDisplayName } : {}),
      ...(identityError ? { identityError } : {}),
    };
  } catch (err) {
    return {
      profile: selectedProfile,
      activeProfile: normalizeProfileName(store.activeProfile),
      tokenPath,
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRefreshToken: Boolean(refreshToken),
      accessTokenReady: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const GOOGLE_DOCS_REQUIRED_SCOPES = [GOOGLE_DOCS_SCOPE, GOOGLE_DRIVE_SCOPE];

export async function googleDriveListFiles(params: {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  profile?: string;
}): Promise<{
  files: Array<{
    id: string;
    name: string;
    mimeType?: string;
    webViewLink?: string;
    modifiedTime?: string;
    parents?: string[];
  }>;
  nextPageToken?: string;
}> {
  const pageSize = Math.max(1, Math.min(200, Number(params.pageSize) || 25));
  const pageToken = params.pageToken?.trim();
  const folderId = params.folderId?.trim() ? parseDriveFileId(params.folderId) : undefined;

  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set(
    'fields',
    'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,parents)',
  );
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('orderBy', 'modifiedTime desc');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  url.searchParams.set('q', folderId
    ? `'${folderId}' in parents and trashed=false`
    : 'trashed=false');

  const data = await googleFetchJson(url.toString(), { method: 'GET' }, params.profile);
  const files = Array.isArray(data?.files) ? data.files : [];
  return {
    files: files.map((file: any) => ({
      id: String(file?.id ?? ''),
      name: String(file?.name ?? ''),
      mimeType: typeof file?.mimeType === 'string' ? file.mimeType : undefined,
      webViewLink: typeof file?.webViewLink === 'string' ? file.webViewLink : undefined,
      modifiedTime: typeof file?.modifiedTime === 'string' ? file.modifiedTime : undefined,
      parents: Array.isArray(file?.parents) ? file.parents.filter((p: unknown): p is string => typeof p === 'string') : undefined,
    })).filter((file: { id: string; name: string }) => Boolean(file.id && file.name)),
    nextPageToken: typeof data?.nextPageToken === 'string' ? data.nextPageToken : undefined,
  };
}

export async function googleDriveSearchFiles(params: {
  query: string;
  folderId?: string;
  pageSize?: number;
  profile?: string;
}): Promise<{
  files: Array<{
    id: string;
    name: string;
    mimeType?: string;
    webViewLink?: string;
    modifiedTime?: string;
    parents?: string[];
  }>;
}> {
  const query = params.query.trim();
  if (!query) throw new Error('query is required.');
  const pageSize = Math.max(1, Math.min(200, Number(params.pageSize) || 25));
  const folderId = params.folderId?.trim() ? parseDriveFileId(params.folderId) : undefined;

  const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const qParts = [`trashed=false`, `name contains '${escaped}'`];
  if (folderId) qParts.push(`'${folderId}' in parents`);

  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set(
    'fields',
    'files(id,name,mimeType,webViewLink,modifiedTime,parents)',
  );
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('q', qParts.join(' and '));

  const data = await googleFetchJson(url.toString(), { method: 'GET' }, params.profile);
  const files = Array.isArray(data?.files) ? data.files : [];
  return {
    files: files.map((file: any) => ({
      id: String(file?.id ?? ''),
      name: String(file?.name ?? ''),
      mimeType: typeof file?.mimeType === 'string' ? file.mimeType : undefined,
      webViewLink: typeof file?.webViewLink === 'string' ? file.webViewLink : undefined,
      modifiedTime: typeof file?.modifiedTime === 'string' ? file.modifiedTime : undefined,
      parents: Array.isArray(file?.parents) ? file.parents.filter((p: unknown): p is string => typeof p === 'string') : undefined,
    })).filter((file: { id: string; name: string }) => Boolean(file.id && file.name)),
  };
}

export async function googleDriveMoveFile(params: {
  fileId: string;
  targetFolderId: string;
  profile?: string;
}): Promise<{
  id: string;
  name: string;
  webViewLink?: string;
  parents?: string[];
}> {
  const fileId = parseDriveFileId(params.fileId);
  const targetFolderId = parseDriveFileId(params.targetFolderId);

  const current = await googleFetchJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,parents`,
    { method: 'GET' },
    params.profile,
  );
  const existingParents = Array.isArray(current?.parents)
    ? current.parents.filter((p: unknown): p is string => typeof p === 'string')
    : [];

  const moveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  moveUrl.searchParams.set('addParents', targetFolderId);
  if (existingParents.length > 0) {
    moveUrl.searchParams.set('removeParents', existingParents.join(','));
  }
  moveUrl.searchParams.set('fields', 'id,name,webViewLink,parents');

  const moved = await googleFetchJson(moveUrl.toString(), { method: 'PATCH' }, params.profile);
  return {
    id: String(moved?.id ?? fileId),
    name: String(moved?.name ?? ''),
    webViewLink: typeof moved?.webViewLink === 'string' ? moved.webViewLink : undefined,
    parents: Array.isArray(moved?.parents) ? moved.parents.filter((p: unknown): p is string => typeof p === 'string') : undefined,
  };
}

export interface GoogleDocsAuthConfigInput {
  profile?: string;
  setActive?: boolean;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUri?: string;
}

export interface GoogleDocsAuthConfigResult {
  profile: string;
  activeProfile: string;
  tokenPath: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
}

export async function upsertGoogleDocsAuthConfig(
  updates: GoogleDocsAuthConfigInput,
): Promise<GoogleDocsAuthConfigResult> {
  const tokenPath = resolveTokenPath();
  let store: OAuthTokenStore = {
    version: 2,
    activeProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: {} },
  };
  try {
    const loaded = await loadTokenStore();
    store = loaded.store;
  } catch {
    // start with a fresh store
  }
  const profile = normalizeProfileName(updates.profile);
  const nextStore: OAuthTokenStore = {
    version: 2,
    activeProfile: normalizeProfileName(store.activeProfile),
    profiles: { ...(store.profiles ?? {}) },
  };
  const profiles = nextStore.profiles ?? {};
  const record: OAuthTokenFile = { ...(profiles[profile] ?? {}) };

  const refreshToken = updates.refreshToken?.trim();
  const clientId = updates.clientId?.trim();
  const clientSecret = updates.clientSecret?.trim();
  const tokenUri = updates.tokenUri?.trim();

  if (refreshToken !== undefined) record.refresh_token = refreshToken;
  if (clientId !== undefined) record.client_id = clientId;
  if (clientSecret !== undefined) record.client_secret = clientSecret;
  if (tokenUri !== undefined) record.token_uri = tokenUri;

  // Force new token exchange on next call when auth settings change.
  if (
    refreshToken !== undefined
    || clientId !== undefined
    || clientSecret !== undefined
    || tokenUri !== undefined
  ) {
    delete record.access_token;
    delete record.expiry_date;
  }

  profiles[profile] = record;
  nextStore.profiles = profiles;
  if (updates.setActive === true || (!nextStore.activeProfile || !profiles[nextStore.activeProfile])) {
    nextStore.activeProfile = profile;
  }

  await saveTokenStore(tokenPath, nextStore);
  const effectiveRecord = mergeEnvOAuthOverrides(profile, record);
  return {
    profile,
    activeProfile: normalizeProfileName(nextStore.activeProfile),
    tokenPath,
    hasClientId: Boolean(effectiveRecord.client_id?.trim()),
    hasClientSecret: Boolean(effectiveRecord.client_secret?.trim()),
    hasRefreshToken: Boolean(effectiveRecord.refresh_token?.trim()),
  };
}

export async function listGoogleDocsAuthProfiles(): Promise<{
  tokenPath: string;
  activeProfile: string;
  profiles: Array<{
    name: string;
    hasClientId: boolean;
    hasClientSecret: boolean;
    hasRefreshToken: boolean;
    accountEmail?: string;
    accountDisplayName?: string;
  }>;
}> {
  const tokenPath = resolveTokenPath();
  let store: OAuthTokenStore = {
    version: 2,
    activeProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: {} },
  };
  try {
    const loaded = await loadTokenStore();
    store = loaded.store;
  } catch {
    // keep default empty store
  }
  const activeProfile = normalizeProfileName(store.activeProfile);
  const names = new Set<string>(Object.keys(store.profiles ?? {}));
  names.add(activeProfile);
  const profiles = await Promise.all(
    Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map(async (name) => {
        const record = mergeEnvOAuthOverrides(name, (store.profiles ?? {})[name] ?? {});
        const hasClientId = Boolean(record.client_id?.trim());
        const hasClientSecret = Boolean(record.client_secret?.trim());
        const hasRefreshToken = Boolean(record.refresh_token?.trim());
        let accountEmail: string | undefined;
        let accountDisplayName: string | undefined;

        // Best-effort identity lookup to make profile selection clear in clients.
        if (hasClientId && hasClientSecret && hasRefreshToken) {
          try {
            const about = await googleFetchJson(
              'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)',
              { method: 'GET' },
              name,
            );
            accountEmail = typeof about?.user?.emailAddress === 'string' ? about.user.emailAddress : undefined;
            accountDisplayName = typeof about?.user?.displayName === 'string' ? about.user.displayName : undefined;
          } catch {
            // Ignore lookup failures; readiness fields still indicate auth state.
          }
        }

        return {
          name,
          hasClientId,
          hasClientSecret,
          hasRefreshToken,
          ...(accountEmail ? { accountEmail } : {}),
          ...(accountDisplayName ? { accountDisplayName } : {}),
        };
      }),
  );
  return { tokenPath, activeProfile, profiles };
}

export async function setGoogleDocsActiveProfile(profile: string): Promise<{ tokenPath: string; activeProfile: string }> {
  const normalized = normalizeProfileName(profile);
  const tokenPath = resolveTokenPath();
  let store: OAuthTokenStore = {
    version: 2,
    activeProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: {} },
  };
  try {
    const loaded = await loadTokenStore();
    store = loaded.store;
  } catch {
    // keep default empty store
  }
  const nextStore: OAuthTokenStore = {
    version: 2,
    activeProfile: normalized,
    profiles: {
      ...(store.profiles ?? {}),
      [normalized]: (store.profiles ?? {})[normalized] ?? {},
    },
  };
  await saveTokenStore(tokenPath, nextStore);
  return { tokenPath, activeProfile: normalized };
}

export async function startGoogleOAuthConnect(input: {
  redirectUri: string;
  profile?: string;
}): Promise<{ sessionId: string; authUrl: string; profile?: string; expiresAt: number }> {
  const redirectUri = input.redirectUri.trim();
  if (!redirectUri) {
    throw new Error('redirectUri is required.');
  }
  const { store } = await loadTokenStore().catch(() => ({
    store: {
      version: 2,
      activeProfile: DEFAULT_PROFILE,
      profiles: { [DEFAULT_PROFILE]: {} },
    } as OAuthTokenStore,
  }));
  const requestedProfile = input.profile?.trim() ? normalizeProfileName(input.profile) : undefined;
  const activeProfile = normalizeProfileName(store.activeProfile);
  const candidateProfile = requestedProfile ?? activeProfile;
  const record = (store.profiles ?? {})[candidateProfile] ?? {};
  const { clientId } = getOAuthClientConfig(candidateProfile, record);

  const sessionId = randomUUID();
  const state = randomUUID();
  const now = Date.now();
  oauthSessions.set(sessionId, {
    id: sessionId,
    state,
    profile: requestedProfile,
    redirectUri,
    createdAt: now,
    status: 'pending',
  });
  cleanupOAuthSessions(now);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', `${GOOGLE_DOCS_SCOPE} ${GOOGLE_DRIVE_SCOPE}`);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return {
    sessionId,
    authUrl: authUrl.toString(),
    ...(requestedProfile ? { profile: requestedProfile } : {}),
    expiresAt: now + OAUTH_SESSION_TTL_MS,
  };
}

export async function completeGoogleOAuthConnect(input: {
  state: string;
  code?: string;
  error?: string;
}): Promise<{
  ok: boolean;
  sessionId?: string;
  profile?: string;
  accountEmail?: string;
  accountDisplayName?: string;
  error?: string;
}> {
  const state = input.state.trim();
  if (!state) return { ok: false, error: 'Missing state.' };
  const session = findOAuthSessionByState(state);
  if (!session) return { ok: false, error: 'OAuth session not found or expired.' };

  if (input.error) {
    session.status = 'error';
    session.error = `OAuth provider error: ${input.error}`;
    oauthSessions.set(session.id, session);
    return { ok: false, sessionId: session.id, error: session.error };
  }
  const code = input.code?.trim() ?? '';
  if (!code) {
    session.status = 'error';
    session.error = 'Missing authorization code.';
    oauthSessions.set(session.id, session);
    return { ok: false, sessionId: session.id, error: session.error };
  }

  const tokenPath = resolveTokenPath();
  let store: OAuthTokenStore = {
    version: 2,
    activeProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: {} },
  };
  try {
    const loaded = await loadTokenStore();
    store = loaded.store;
  } catch {
    // keep default empty store
  }

  const targetProfile = session.profile
    ? normalizeProfileName(session.profile)
    : normalizeProfileName(store.activeProfile);
  const targetRecord = { ...((store.profiles ?? {})[targetProfile] ?? {}) };
  let clientCfg;
  try {
    clientCfg = getOAuthClientConfig(targetProfile, targetRecord);
  } catch (err) {
    session.status = 'error';
    session.error = err instanceof Error ? err.message : String(err);
    oauthSessions.set(session.id, session);
    return { ok: false, sessionId: session.id, error: session.error };
  }

  const body = new URLSearchParams({
    client_id: clientCfg.clientId,
    client_secret: clientCfg.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: session.redirectUri,
  });
  const tokenRes = await fetch(clientCfg.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => '');
    session.status = 'error';
    session.error = `Token exchange failed (${tokenRes.status}): ${errBody.slice(0, 400)}`;
    oauthSessions.set(session.id, session);
    return { ok: false, sessionId: session.id, error: session.error };
  }
  const tokenJson = await tokenRes.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const refreshToken = tokenJson.refresh_token?.trim() || targetRecord.refresh_token?.trim() || '';
  if (!refreshToken) {
    session.status = 'error';
    session.error = 'Google token response did not include a refresh_token.';
    oauthSessions.set(session.id, session);
    return { ok: false, sessionId: session.id, error: session.error };
  }

  const accessToken = tokenJson.access_token?.trim() || '';
  let accountEmail: string | undefined;
  let accountDisplayName: string | undefined;
  if (accessToken) {
    try {
      const aboutRes = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (aboutRes.ok) {
        const about = await aboutRes.json() as any;
        accountEmail = typeof about?.user?.emailAddress === 'string' ? about.user.emailAddress : undefined;
        accountDisplayName = typeof about?.user?.displayName === 'string' ? about.user.displayName : undefined;
      }
    } catch {
      // best effort
    }
  }

  const resolvedProfile = session.profile
    ? targetProfile
    : (accountEmail ? normalizeProfileFromEmail(accountEmail) : targetProfile);

  const nextStore: OAuthTokenStore = {
    version: 2,
    activeProfile: normalizeProfileName(store.activeProfile),
    profiles: { ...(store.profiles ?? {}) },
  };
  const nextRecord: OAuthTokenFile = {
    ...(nextStore.profiles ?? {})[resolvedProfile] ?? {},
    client_id: clientCfg.clientId,
    client_secret: clientCfg.clientSecret,
    token_uri: clientCfg.tokenUri,
    refresh_token: refreshToken,
    ...(accessToken ? { access_token: accessToken } : {}),
  };
  if (typeof tokenJson.expires_in === 'number' && accessToken) {
    nextRecord.expiry_date = Date.now() + tokenJson.expires_in * 1000;
  } else {
    delete nextRecord.expiry_date;
  }
  nextStore.profiles = {
    ...(nextStore.profiles ?? {}),
    [resolvedProfile]: nextRecord,
  };
  await saveTokenStore(tokenPath, nextStore);

  session.status = 'success';
  session.profileResolved = resolvedProfile;
  session.accountEmail = accountEmail;
  session.accountDisplayName = accountDisplayName;
  oauthSessions.set(session.id, session);
  return {
    ok: true,
    sessionId: session.id,
    profile: resolvedProfile,
    ...(accountEmail ? { accountEmail } : {}),
    ...(accountDisplayName ? { accountDisplayName } : {}),
  };
}

export function getGoogleOAuthConnectSessionStatus(sessionId: string): {
  found: boolean;
  status?: 'pending' | 'success' | 'error';
  profile?: string;
  accountEmail?: string;
  accountDisplayName?: string;
  error?: string;
  expiresAt?: number;
} {
  cleanupOAuthSessions();
  const session = oauthSessions.get(sessionId.trim());
  if (!session) return { found: false };
  return {
    found: true,
    status: session.status,
    profile: session.profileResolved ?? session.profile,
    ...(session.accountEmail ? { accountEmail: session.accountEmail } : {}),
    ...(session.accountDisplayName ? { accountDisplayName: session.accountDisplayName } : {}),
    ...(session.error ? { error: session.error } : {}),
    expiresAt: session.createdAt + OAUTH_SESSION_TTL_MS,
  };
}
