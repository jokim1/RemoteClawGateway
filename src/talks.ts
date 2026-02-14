/**
 * Talk CRUD HTTP Handlers
 *
 * Handles /api/talks endpoints for creating, listing, reading,
 * updating, and deleting Talks, plus message history and pins.
 */

import type { HandlerContext } from './types.js';
import type { TalkStore } from './talk-store.js';
import type { ToolRegistry } from './tool-registry.js';
import { sendJson, readJsonBody } from './http.js';
import { validateSchedule, parseEventTrigger } from './job-scheduler.js';

/**
 * Route a /api/talks request to the appropriate handler.
 * Returns true if the request was handled.
 */
export async function handleTalks(ctx: HandlerContext, store: TalkStore): Promise<void> {
  const { req, res, url } = ctx;
  const pathname = url.pathname;

  // POST /api/talks — create
  if (pathname === '/api/talks' && req.method === 'POST') {
    return handleCreateTalk(ctx, store);
  }

  // GET /api/talks — list
  if (pathname === '/api/talks' && req.method === 'GET') {
    return handleListTalks(ctx, store);
  }

  // Match /api/talks/:id patterns
  const talkMatch = pathname.match(/^\/api\/talks\/([\w-]+)$/);
  if (talkMatch) {
    const talkId = talkMatch[1];
    if (req.method === 'GET') return handleGetTalk(ctx, store, talkId);
    if (req.method === 'PATCH') return handleUpdateTalk(ctx, store, talkId);
    if (req.method === 'DELETE') return handleDeleteTalk(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/messages
  const messagesMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/messages$/);
  if (messagesMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    return handleGetMessages(ctx, store, messagesMatch[1]);
  }

  // POST/DELETE /api/talks/:id/pin/:msgId
  const pinMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/pin\/([\w-]+)$/);
  if (pinMatch) {
    const [, talkId, msgId] = pinMatch;
    if (req.method === 'POST') return handleAddPin(ctx, store, talkId, msgId);
    if (req.method === 'DELETE') return handleRemovePin(ctx, store, talkId, msgId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/GET /api/talks/:id/jobs
  const jobsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs$/);
  if (jobsMatch) {
    const talkId = jobsMatch[1];
    if (req.method === 'POST') return handleCreateJob(ctx, store, talkId);
    if (req.method === 'GET') return handleListJobs(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // PATCH/DELETE /api/talks/:id/jobs/:jobId
  const jobMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs\/([\w-]+)$/);
  if (jobMatch) {
    const [, talkId, jobId] = jobMatch;
    if (req.method === 'PATCH') return handleUpdateJob(ctx, store, talkId, jobId);
    if (req.method === 'DELETE') return handleDeleteJob(ctx, store, talkId, jobId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/jobs/:jobId/reports
  const reportsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs\/([\w-]+)\/reports$/);
  if (reportsMatch) {
    const [, talkId, jobId] = reportsMatch;
    if (req.method === 'GET') return handleGetReports(ctx, store, talkId, jobId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/reports (all reports for a talk)
  const talkReportsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/reports$/);
  if (talkReportsMatch) {
    if (req.method === 'GET') return handleGetReports(ctx, store, talkReportsMatch[1]);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/GET /api/talks/:id/agents
  const agentsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/agents$/);
  if (agentsMatch) {
    const talkId = agentsMatch[1];
    if (req.method === 'POST') return handleAddAgent(ctx, store, talkId);
    if (req.method === 'GET') return handleListAgents(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // DELETE /api/talks/:id/agents/:name
  const agentMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/agents\/([\w-]+)$/);
  if (agentMatch) {
    const [, talkId, agentName] = agentMatch;
    if (req.method === 'DELETE') return handleDeleteAgent(ctx, store, talkId, agentName);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateTalk(ctx: HandlerContext, store: TalkStore): Promise<void> {
  let body: { model?: string; topicTitle?: string; objective?: string } = {};
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    // empty body is fine
  }

  const talk = store.createTalk(body.model);
  if (body.topicTitle) store.updateTalk(talk.id, { topicTitle: body.topicTitle });
  if (body.objective) store.updateTalk(talk.id, { objective: body.objective });

  sendJson(ctx.res, 201, talk);
}

async function handleListTalks(ctx: HandlerContext, store: TalkStore): Promise<void> {
  const talks = store.listTalks();
  sendJson(ctx.res, 200, { talks });
}

async function handleGetTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const contextMd = await store.getContextMd(talkId);
  sendJson(ctx.res, 200, { ...talk, contextMd });
}

async function handleUpdateTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  let body: { topicTitle?: string; objective?: string; model?: string; agents?: any[]; directives?: any[]; platformBindings?: any[] };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  if (body.agents !== undefined) {
    await store.setAgents(talkId, body.agents);
  }
  if (body.directives !== undefined) {
    await store.setDirectives(talkId, body.directives);
  }
  if (body.platformBindings !== undefined) {
    await store.setPlatformBindings(talkId, body.platformBindings);
  }

  const updated = store.updateTalk(talkId, body);
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  sendJson(ctx.res, 200, updated);
}

async function handleDeleteTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const success = store.deleteTalk(talkId);
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true });
}

async function handleGetMessages(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '100', 10);
  const afterId = ctx.url.searchParams.get('after') ?? undefined;

  let messages = await store.getMessages(talkId);

  // Pagination: skip messages up to and including `after`
  if (afterId) {
    const idx = messages.findIndex(m => m.id === afterId);
    if (idx !== -1) {
      messages = messages.slice(idx + 1);
    }
  }

  // Apply limit
  messages = messages.slice(-limit);

  sendJson(ctx.res, 200, { messages });
}

async function handleAddPin(ctx: HandlerContext, store: TalkStore, talkId: string, msgId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const success = store.addPin(talkId, msgId);
  if (!success) {
    sendJson(ctx.res, 409, { error: 'Already pinned' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true, pinnedMessageIds: talk.pinnedMessageIds });
}

async function handleRemovePin(ctx: HandlerContext, store: TalkStore, talkId: string, msgId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const success = store.removePin(talkId, msgId);
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Pin not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true, pinnedMessageIds: talk.pinnedMessageIds });
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function handleCreateJob(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  let body: { schedule?: string; prompt?: string };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.schedule || !body.prompt) {
    sendJson(ctx.res, 400, { error: 'Missing schedule or prompt' });
    return;
  }

  const scheduleError = validateSchedule(body.schedule);
  if (scheduleError) {
    sendJson(ctx.res, 400, { error: scheduleError });
    return;
  }

  // Detect event-driven jobs and validate scope against platform bindings
  const eventScope = parseEventTrigger(body.schedule);
  let jobType: 'once' | 'recurring' | 'event' | undefined;

  if (eventScope) {
    const bindings = talk.platformBindings ?? [];
    const matchingBinding = bindings.find(
      b => b.scope.toLowerCase() === eventScope.toLowerCase(),
    );
    if (!matchingBinding) {
      sendJson(ctx.res, 400, {
        error: `No platform binding found for "${eventScope}". Add one with /platform <name> ${eventScope} <permission>`,
      });
      return;
    }
    jobType = 'event';
  }

  const job = store.addJob(talkId, body.schedule, body.prompt, jobType);
  if (!job) {
    sendJson(ctx.res, 500, { error: 'Failed to create job' });
    return;
  }
  sendJson(ctx.res, 201, job);
}

async function handleListJobs(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const jobs = store.listJobs(talkId);
  sendJson(ctx.res, 200, { jobs });
}

async function handleUpdateJob(ctx: HandlerContext, store: TalkStore, talkId: string, jobId: string): Promise<void> {
  let body: { active?: boolean; schedule?: string; prompt?: string };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (body.schedule) {
    const scheduleError = validateSchedule(body.schedule);
    if (scheduleError) {
      sendJson(ctx.res, 400, { error: scheduleError });
      return;
    }
  }

  const updated = store.updateJob(talkId, jobId, body);
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Job not found' });
    return;
  }
  sendJson(ctx.res, 200, updated);
}

async function handleDeleteJob(ctx: HandlerContext, store: TalkStore, talkId: string, jobId: string): Promise<void> {
  const success = store.deleteJob(talkId, jobId);
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Job not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true });
}

async function handleGetReports(ctx: HandlerContext, store: TalkStore, talkId: string, jobId?: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '20', 10);
  const sinceParam = ctx.url.searchParams.get('since');
  const since = sinceParam ? parseInt(sinceParam, 10) : undefined;
  const reports = await store.getRecentReports(talkId, limit, jobId, since);
  sendJson(ctx.res, 200, { reports });
}

// ---------------------------------------------------------------------------
// Agent handlers
// ---------------------------------------------------------------------------

async function handleAddAgent(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  let body: { name?: string; model?: string; role?: string; isPrimary?: boolean };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.name || !body.model || !body.role) {
    sendJson(ctx.res, 400, { error: 'Missing name, model, or role' });
    return;
  }

  const agent = await store.addAgent(talkId, {
    name: body.name,
    model: body.model,
    role: body.role as any,
    isPrimary: body.isPrimary ?? false,
  });
  sendJson(ctx.res, 201, agent);
}

async function handleListAgents(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const agents = store.listAgents(talkId);
  sendJson(ctx.res, 200, { agents });
}

async function handleDeleteAgent(ctx: HandlerContext, store: TalkStore, talkId: string, agentName: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  try {
    await store.removeAgent(talkId, agentName);
  } catch {
    sendJson(ctx.res, 404, { error: 'Agent not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Route /api/tools requests for managing the tool registry.
 */
export async function handleToolRoutes(ctx: HandlerContext, registry: ToolRegistry): Promise<void> {
  const { req, res, url } = ctx;
  const pathname = url.pathname;

  // GET /api/tools — list all tools
  if (pathname === '/api/tools' && req.method === 'GET') {
    sendJson(res, 200, { tools: registry.listTools() });
    return;
  }

  // POST /api/tools — register a new tool
  if (pathname === '/api/tools' && req.method === 'POST') {
    let body: { name?: string; description?: string; parameters?: any };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!body.name || !body.description) {
      sendJson(res, 400, { error: 'Missing name or description' });
      return;
    }

    const parameters = body.parameters ?? { type: 'object', properties: {} };
    const ok = registry.registerTool(body.name, body.description, parameters);
    if (!ok) {
      sendJson(res, 409, { error: `Cannot register tool "${body.name}" (name conflicts with built-in)` });
      return;
    }
    sendJson(res, 201, { ok: true, name: body.name });
    return;
  }

  // DELETE /api/tools/:name — remove a dynamic tool
  const toolNameMatch = pathname.match(/^\/api\/tools\/([\w-]+)$/);
  if (toolNameMatch && req.method === 'DELETE') {
    const name = toolNameMatch[1];
    const ok = registry.removeTool(name);
    if (!ok) {
      sendJson(res, 404, { error: `Tool "${name}" not found or is built-in` });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}
