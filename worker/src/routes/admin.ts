import { Hono, type Context } from 'hono';
import type { AppEnv, AgentRow, ConversationRow, CustomerRow, WorkspaceSettings } from '../env';
import { assertAdmin, assertWorkspaceAccess, authenticateAdmin, bearer, randomToken, sha256Hex } from '../auth';
import {
  agentReply,
  assignConversation,
  closeConversation,
  conversationTranscript,
  getConversation,
  getCustomer,
  getMessages,
  reopenConversation,
  suggestReply,
  summarizeConversation,
  testChat,
  toPublicMessage,
  updateCustomerContact,
} from '../chat';
import { latestCrawl, startCrawl } from '../crawler';
import { PLATFORMS, installCode, type Platform } from '../install';
import { providerConfigured } from '../ai/providers';
import { deleteDocument, indexDocument, searchKnowledge } from '../rag';
import { broadcast, connectToRoom, presence } from '../realtime';
import {
  activateScenario,
  addStep,
  createScenario,
  deactivateScenario,
  deleteScenario,
  deleteStep,
  getActiveScenario,
  getScenario,
  importFlow,
  listScenarios,
  renameScenario,
  setStartStep,
  updateStep,
  validateFlow,
  type FlowDefinitionStep,
} from '../scenario';
import { inboxStats } from '../stats';
import { createWorkspace, getWorkspace, invalidateWorkspaceCache, listWorkspaces, updateWorkspace, PROVIDERS } from '../workspaces';
import { HttpError, baseUrl, clampInt, newId, now, parseJson, toRootUrl } from '../util';

const admin = new Hono<AppEnv>();

// WebSocket for the inbox (token in the query string because browsers cannot set headers on websockets).
admin.get('/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected websocket');
  const auth = await authenticateAdmin(c.env, c.req.query('token') || null);
  const workspaceId = c.req.query('workspace') || '';
  assertWorkspaceAccess(auth, workspaceId);
  await getWorkspace(c.env, workspaceId);
  return connectToRoom(c.env, `inbox:${workspaceId}`, c.req.raw, 'agent', auth.agentId || 'owner', auth.agentName);
});

admin.use('*', async (c, next) => {
  c.set('auth', await authenticateAdmin(c.env, bearer(c.req.raw)));
  await next();
});

function waitUntilFor(c: Context<AppEnv>) {
  return (p: Promise<unknown>) => c.executionCtx.waitUntil(p.catch((err) => console.error('background task failed', err)));
}

async function wsFor(c: Context<AppEnv>, id: string) {
  assertWorkspaceAccess(c.get('auth'), id);
  return getWorkspace(c.env, id);
}

async function convFor(c: Context<AppEnv>, id: string) {
  const conv = await getConversation(c.env, id);
  const ws = await wsFor(c, conv.workspace_id);
  return { conv, ws };
}

function agentName(c: Context<AppEnv>) {
  return c.get('auth').agentName;
}

async function body<T>(c: Context<AppEnv>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

// ------------------------------------------------------------------------------------------------
// Account
// ------------------------------------------------------------------------------------------------

admin.get('/me', (c) => c.json(c.get('auth')));

admin.get('/providers', (c) =>
  c.json({
    providers: PROVIDERS.map((p) => ({ name: p, configured: providerConfigured(c.env, p) })),
    aiGateway: Boolean(c.env.CF_ACCOUNT_ID && c.env.AI_GATEWAY_ID),
    vectorize: Boolean(c.env.VECTORIZE),
    browserRendering: Boolean(c.env.CF_API_TOKEN && c.env.CF_ACCOUNT_ID),
    turnstile: Boolean(c.env.TURNSTILE_SECRET),
    supabaseMirror: Boolean(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY),
    email: Boolean(c.env.RESEND_API_KEY && c.env.RESEND_FROM),
  }),
);

// ------------------------------------------------------------------------------------------------
// Workspaces & setup
// ------------------------------------------------------------------------------------------------

admin.get('/workspaces', async (c) => {
  const list = await listWorkspaces(c.env, c.get('auth').workspaceIds);
  return c.json({ workspaces: list });
});

/** add_chatbot_to_website: create workspace, start crawl, optional preset flow, return install code. */
admin.post('/workspaces', async (c) => {
  assertAdmin(c.get('auth'));
  const input = await body<{
    url?: string;
    name?: string;
    settings?: Partial<WorkspaceSettings>;
    allowedOrigins?: string[];
    crawl?: boolean;
    maxPages?: number;
    flow?: { name: string; start: string; steps: FlowDefinitionStep[]; activate?: boolean };
    knowledge?: { title: string; content: string; url?: string }[];
  }>(c);
  if (!input.url) throw new HttpError(400, 'url is required');
  const rootUrl = toRootUrl(input.url);
  const ws = await createWorkspace(c.env, { name: input.name, url: rootUrl, settings: input.settings, allowedOrigins: input.allowedOrigins });
  const knowledge = [];
  for (const doc of input.knowledge || []) {
    if (!doc.title || !doc.content) continue;
    knowledge.push(
      await indexDocument(c.env, ws.id, {
        url: doc.url || `manual://${newId('note')}`,
        title: doc.title,
        content: doc.content,
        source: 'manual',
      }),
    );
  }
  const crawl = input.crawl === false ? null : await startCrawl(c.env, ws, rootUrl, { maxPages: input.maxPages });
  const flow = input.flow ? await importFlow(c.env, ws.id, input.flow) : null;
  const base = baseUrl(c.env, c.req.raw);
  return c.json(
    {
      workspace: ws,
      crawl,
      flow,
      knowledge,
      install: installCode(base, ws.publicKey, 'html'),
      inboxUrl: `${base}/inbox/#/${ws.id}`,
      next_steps: [
        'Paste the install snippet on your site (or ask for platform-specific code with get_widget_install_code).',
        'Wait for the crawl to finish (get_setup_status) so the bot can answer from your pages.',
        'Open the inbox to answer handoffs live.',
      ],
    },
    201,
  );
});

admin.get('/workspaces/:ws', async (c) => c.json({ workspace: await wsFor(c, c.req.param('ws')) }));

admin.patch('/workspaces/:ws', async (c) => {
  assertAdmin(c.get('auth'));
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ name?: string; settings?: Partial<WorkspaceSettings>; allowedOrigins?: string[] }>(c);
  return c.json({ workspace: await updateWorkspace(c.env, ws, input) });
});

admin.delete('/workspaces/:ws', async (c) => {
  assertAdmin(c.get('auth'));
  const ws = await wsFor(c, c.req.param('ws'));
  const { results } = await c.env.DB.prepare('SELECT id FROM kb_documents WHERE workspace_id = ?').bind(ws.id).all<{ id: string }>();
  for (const doc of results) await deleteDocument(c.env, ws.id, doc.id);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM messages_fts WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM messages WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM conversations WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM customers WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM scenario_steps WHERE scenario_id IN (SELECT id FROM scenarios WHERE workspace_id = ?)').bind(ws.id),
    c.env.DB.prepare('DELETE FROM scenarios WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM webhooks WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM crawl_jobs WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM usage_daily WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(ws.id),
  ]);
  await invalidateWorkspaceCache(c.env, ws);
  let cursor: string | undefined;
  do {
    const listing = await c.env.FILES.list({ prefix: `${ws.id}/`, cursor });
    if (listing.objects.length) await c.env.FILES.delete(listing.objects.map((o) => o.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return c.json({ ok: true });
});

admin.get('/workspaces/:ws/setup-status', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const [docs, crawl, flow, convs, online] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS documents, COALESCE(SUM(chunk_count),0) AS chunks, COALESCE(SUM(vector_indexed),0) AS vector_docs FROM kb_documents WHERE workspace_id = ? AND status = 'indexed'",
    )
      .bind(ws.id)
      .first<{ documents: number; chunks: number; vector_docs: number }>(),
    latestCrawl(c.env, ws.id),
    getActiveScenario(c.env, ws.id),
    c.env.DB.prepare('SELECT COUNT(*) AS total, MAX(created_at) AS last_at FROM conversations WHERE workspace_id = ?')
      .bind(ws.id)
      .first<{ total: number; last_at: number | null }>(),
    presence(c.env, `inbox:${ws.id}`),
  ]);
  const providers = PROVIDERS.filter((p) => providerConfigured(c.env, p));
  const checklist = [
    { item: 'Workspace created', done: true },
    { item: 'At least one AI provider configured', done: providers.length > 0, detail: providers.join(', ') || 'none — answers fall back to knowledge snippets' },
    { item: 'Knowledge base indexed', done: (docs?.documents || 0) > 0, detail: `${docs?.documents || 0} pages, ${docs?.chunks || 0} chunks` },
    { item: 'Crawl finished', done: crawl?.status === 'done', detail: crawl ? `${crawl.status}: ${crawl.pages_done}/${crawl.pages_queued} pages, ${crawl.pages_failed} failed` : 'no crawl yet' },
    { item: 'Widget installed on the site (first conversation received)', done: (convs?.total || 0) > 0 },
    { item: 'Chatbot flow published (optional)', done: Boolean(flow), detail: flow ? flow.name : 'AI answers directly with the greeting' },
    { item: 'Bot protection with Turnstile (optional)', done: Boolean(ws.settings.turnstileSiteKey && c.env.TURNSTILE_SECRET) },
    { item: 'Agent online in inbox', done: online.agents.length > 0, detail: online.agents.map((a) => a.name).join(', ') },
  ];
  return c.json({
    workspace: { id: ws.id, name: ws.name, domain: ws.domain, publicKey: ws.publicKey },
    knowledge: docs,
    crawl,
    activeFlow: flow ? { id: flow.id, name: flow.name } : null,
    conversations: convs,
    providers,
    agentsOnline: online.agents,
    checklist,
    ready: providers.length > 0 && (docs?.documents || 0) > 0,
  });
});

admin.get('/workspaces/:ws/install-code', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const platform = (c.req.query('platform') || 'html') as Platform;
  if (!PLATFORMS.includes(platform)) throw new HttpError(400, `platform must be one of ${PLATFORMS.join(', ')}`);
  return c.json(installCode(baseUrl(c.env, c.req.raw), ws.publicKey, platform));
});

admin.post('/workspaces/:ws/test-chat', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ question?: string }>(c);
  if (!input.question?.trim()) throw new HttpError(400, 'question is required');
  return c.json(await testChat(c.env, ws, input.question.trim()));
});

// ------------------------------------------------------------------------------------------------
// Conversations
// ------------------------------------------------------------------------------------------------

admin.get('/workspaces/:ws/conversations', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const auth = c.get('auth');
  const status = c.req.query('status') || 'open';
  const assignee = c.req.query('assignee');
  const mode = c.req.query('mode');
  const q = (c.req.query('q') || '').trim();
  const customerId = c.req.query('customer_id');
  const limit = clampInt(c.req.query('limit'), 1, 200, 50);
  const before = parseInt(c.req.query('before') || '0', 10) || 0;

  const where: string[] = ['c.workspace_id = ?'];
  const params: unknown[] = [ws.id];
  if (status !== 'all') {
    where.push('c.status = ?');
    params.push(status === 'closed' ? 'closed' : 'open');
  }
  if (assignee === 'unassigned') where.push('c.assignee_id IS NULL');
  else if (assignee === 'me') {
    where.push('c.assignee_id = ?');
    params.push(auth.agentId || '__owner__');
  } else if (assignee) {
    where.push('c.assignee_id = ?');
    params.push(assignee);
  }
  if (mode === 'human' || mode === 'bot' || mode === 'flow') {
    where.push('c.mode = ?');
    params.push(mode);
  }
  if (customerId) {
    where.push('c.customer_id = ?');
    params.push(customerId);
  }
  if (before) {
    where.push('c.last_message_at < ?');
    params.push(before);
  }
  if (q) {
    const terms = (q.toLowerCase().match(/[\p{L}\p{N}@._-]{2,}/gu) || []).slice(0, 8);
    const ftsTerms = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const like = `%${q.toLowerCase()}%`;
    const clauses = ['LOWER(cu.email) LIKE ?', 'LOWER(cu.name) LIKE ?', 'LOWER(c.subject) LIKE ?'];
    params.push(like, like, like);
    if (ftsTerms) {
      clauses.push('c.id IN (SELECT conversation_id FROM messages_fts WHERE messages_fts MATCH ? AND workspace_id = ?)');
      params.push(ftsTerms, ws.id);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  params.push(limit);
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, cu.name AS customer_name, cu.email AS customer_email, a.name AS assignee_name
     FROM conversations c
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN agents a ON a.id = c.assignee_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.last_message_at DESC
     LIMIT ?`,
  )
    .bind(...params)
    .all<ConversationRow & { customer_name: string | null; customer_email: string | null; assignee_name: string | null }>();
  return c.json({
    conversations: results.map((r) => ({ ...r, meta: parseJson(r.meta, {}) })),
    next_before: results.length === limit ? results[results.length - 1].last_message_at : null,
  });
});

admin.get('/conversations/:id', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  const [messages, customer, assignee] = await Promise.all([
    getMessages(c.env, conv.id),
    getCustomer(c.env, conv.customer_id),
    conv.assignee_id ? c.env.DB.prepare('SELECT id, name, email FROM agents WHERE id = ?').bind(conv.assignee_id).first() : null,
  ]);
  const live = await presence(c.env, `conv:${conv.id}`);
  return c.json({
    conversation: { ...conv, meta: parseJson(conv.meta, {}) },
    workspace: { id: ws.id, name: ws.name, domain: ws.domain },
    customer: customer ? { ...customer, attributes: parseJson(customer.attributes, {}) } : null,
    assignee,
    visitorOnline: live.visitors > 0,
    messages: messages.map(toPublicMessage),
  });
});

admin.get('/conversations/:id/transcript', async (c) => {
  const { ws } = await convFor(c, c.req.param('id'));
  const markdown = await conversationTranscript(c.env, ws, c.req.param('id'));
  return c.json({ markdown });
});

admin.post('/conversations/:id/reply', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  const auth = c.get('auth');
  const input = await body<{ content?: string; attachments?: { url: string; name: string; type: string; size: number }[] }>(c);
  const name = auth.kind === 'owner' ? `${ws.name} team` : auth.agentName;
  const row = await agentReply(c.env, waitUntilFor(c), ws, conv.id, { id: auth.agentId, name }, input.content || '', input.attachments || []);
  return c.json({ message: toPublicMessage(row) });
});

admin.post('/conversations/:id/note', async (c) => {
  // Internal note: stored as a system message with meta.note, never shown to the visitor.
  const { conv, ws } = await convFor(c, c.req.param('id'));
  const input = await body<{ content?: string }>(c);
  if (!input.content?.trim()) throw new HttpError(400, 'content is required');
  const id = newId('msg');
  const ts = now();
  const meta = JSON.stringify({ note: true, authorName: agentName(c) });
  await c.env.DB.prepare(
    "INSERT INTO messages (id, conversation_id, workspace_id, role, author_id, content, meta, created_at) VALUES (?, ?, ?, 'system', ?, ?, ?, ?)",
  )
    .bind(id, conv.id, ws.id, c.get('auth').agentId, input.content.trim(), meta, ts)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  const message = toPublicMessage(row as never);
  c.executionCtx.waitUntil(broadcast(c.env, `inbox:${ws.id}`, { type: 'message', conversationId: conv.id, message }));
  return c.json({ message });
});

admin.post('/conversations/:id/assign', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  const input = await body<{ agent_id?: string | null; me?: boolean }>(c);
  if (input.me && !c.get('auth').agentId) {
    throw new HttpError(400, 'The owner token is not an agent. Create an agent (create_agent) and assign by agent_id.');
  }
  const target = input.me ? c.get('auth').agentId : input.agent_id ?? null;
  const updated = await assignConversation(c.env, waitUntilFor(c), ws, conv.id, target);
  return c.json({ conversation: updated });
});

admin.post('/conversations/:id/close', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  return c.json({ conversation: await closeConversation(c.env, waitUntilFor(c), ws, conv.id, agentName(c)) });
});

admin.post('/conversations/:id/reopen', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  return c.json({ conversation: await reopenConversation(c.env, waitUntilFor(c), ws, conv.id) });
});

admin.post('/conversations/:id/return-to-bot', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  const meta = parseJson<Record<string, unknown>>(conv.meta, {});
  delete meta.askEmail;
  await c.env.DB.prepare("UPDATE conversations SET mode = 'bot', meta = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(meta), now(), conv.id)
    .run();
  const updated = await getConversation(c.env, conv.id);
  c.executionCtx.waitUntil(broadcast(c.env, `inbox:${ws.id}`, { type: 'conversation.updated', conversation: updated }));
  c.executionCtx.waitUntil(broadcast(c.env, `conv:${conv.id}`, { type: 'status', mode: 'bot' }));
  return c.json({ conversation: updated });
});

admin.post('/conversations/:id/typing', async (c) => {
  const { conv } = await convFor(c, c.req.param('id'));
  c.executionCtx.waitUntil(broadcast(c.env, `conv:${conv.id}`, { type: 'typing', role: 'agent', name: agentName(c) }, 'visitor'));
  return c.json({ ok: true });
});

admin.post('/conversations/:id/suggest-reply', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  const input = await body<{ instructions?: string }>(c);
  return c.json(await suggestReply(c.env, ws, conv.id, agentName(c), input.instructions));
});

admin.post('/conversations/:id/summarize', async (c) => {
  const { conv, ws } = await convFor(c, c.req.param('id'));
  return c.json({ summary: await summarizeConversation(c.env, ws, conv.id) });
});

admin.get('/workspaces/:ws/stats', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  return c.json(await inboxStats(c.env, ws.id, c.req.query('days')));
});

// ------------------------------------------------------------------------------------------------
// Customers
// ------------------------------------------------------------------------------------------------

admin.get('/workspaces/:ws/customers', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const limit = clampInt(c.req.query('limit'), 1, 200, 25);
  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT cu.*, (SELECT COUNT(*) FROM conversations c WHERE c.customer_id = cu.id) AS conversation_count
     FROM customers cu WHERE cu.workspace_id = ?
     ${q ? 'AND (LOWER(cu.email) LIKE ? OR LOWER(cu.name) LIKE ? OR cu.phone LIKE ? OR cu.id = ? OR LOWER(cu.attributes) LIKE ?)' : ''}
     ORDER BY cu.last_seen_at DESC LIMIT ?`,
  )
    .bind(...(q ? [ws.id, like, like, like, q, like, limit] : [ws.id, limit]))
    .all<CustomerRow & { conversation_count: number }>();
  return c.json({ customers: results.map((r) => ({ ...r, attributes: parseJson(r.attributes, {}) })) });
});

admin.get('/customers/:id', async (c) => {
  const customer = await getCustomer(c.env, c.req.param('id'));
  if (!customer) throw new HttpError(404, 'Customer not found');
  await wsFor(c, customer.workspace_id);
  const { results } = await c.env.DB.prepare(
    'SELECT id, status, mode, subject, page_url, message_count, rating, created_at, last_message_at, last_message_preview FROM conversations WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50',
  )
    .bind(customer.id)
    .all();
  return c.json({ customer: { ...customer, attributes: parseJson(customer.attributes, {}) }, conversations: results });
});

admin.patch('/customers/:id', async (c) => {
  const customer = await getCustomer(c.env, c.req.param('id'));
  if (!customer) throw new HttpError(404, 'Customer not found');
  const ws = await wsFor(c, customer.workspace_id);
  const input = await body<{ name?: string; email?: string; phone?: string; attributes?: Record<string, string> }>(c);
  const updated = await updateCustomerContact(c.env, waitUntilFor(c), ws, customer.id, input);
  return c.json({ customer: { ...updated, attributes: parseJson(updated.attributes, {}) } });
});

// ------------------------------------------------------------------------------------------------
// Knowledge base
// ------------------------------------------------------------------------------------------------

admin.get('/workspaces/:ws/kb/search', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const q = c.req.query('q') || '';
  if (!q.trim()) throw new HttpError(400, 'q is required');
  const hits = await searchKnowledge(c.env, ws.id, q, clampInt(c.req.query('limit'), 1, 20, 6));
  return c.json({ results: hits });
});

admin.get('/workspaces/:ws/kb/documents', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const limit = clampInt(c.req.query('limit'), 1, 500, 100);
  const offset = clampInt(c.req.query('offset'), 0, 1_000_000, 0);
  const { results } = await c.env.DB.prepare(
    'SELECT id, url, title, source, status, chunk_count, vector_indexed, error, updated_at FROM kb_documents WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
  )
    .bind(ws.id, limit, offset)
    .all();
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM kb_documents WHERE workspace_id = ?').bind(ws.id).first<{ n: number }>();
  return c.json({ documents: results, total: total?.n || 0 });
});

admin.post('/workspaces/:ws/kb/documents', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ title?: string; content?: string; url?: string }>(c);
  if (!input.title?.trim() || !input.content?.trim()) throw new HttpError(400, 'title and content are required');
  const result = await indexDocument(c.env, ws.id, {
    url: input.url?.trim() || `manual://${newId('note')}`,
    title: input.title.trim(),
    content: input.content,
    source: 'manual',
  });
  return c.json(result, 201);
});

admin.delete('/workspaces/:ws/kb/documents/:doc', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const ok = await deleteDocument(c.env, ws.id, c.req.param('doc'));
  if (!ok) throw new HttpError(404, 'Document not found');
  return c.json({ ok: true });
});

admin.post('/workspaces/:ws/crawl', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ url?: string; maxPages?: number; maxDepth?: number }>(c);
  const rootUrl = toRootUrl(input.url || `https://${ws.domain}`);
  const host = new URL(rootUrl).hostname.replace(/^www\./, '');
  if (host !== ws.domain && !host.endsWith(`.${ws.domain}`) && c.get('auth').role !== 'admin') {
    throw new HttpError(403, 'Only admins can crawl other domains');
  }
  return c.json({ crawl: await startCrawl(c.env, ws, rootUrl, input) }, 202);
});

admin.get('/workspaces/:ws/crawl', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const { results } = await c.env.DB.prepare('SELECT * FROM crawl_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10')
    .bind(ws.id)
    .all();
  return c.json({ crawls: results });
});

// ------------------------------------------------------------------------------------------------
// Chatbot flows (scenarios)
// ------------------------------------------------------------------------------------------------

admin.get('/workspaces/:ws/scenarios', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  return c.json({ scenarios: await listScenarios(c.env, ws.id) });
});

admin.post('/workspaces/:ws/scenarios', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ name?: string; definition?: { name: string; start: string; steps: FlowDefinitionStep[]; activate?: boolean } }>(c);
  if (input.definition) return c.json({ scenario: await importFlow(c.env, ws.id, input.definition) }, 201);
  const scenario = await createScenario(c.env, ws.id, input.name || 'New flow');
  return c.json({ scenario: await getScenario(c.env, ws.id, scenario.id) }, 201);
});

admin.get('/workspaces/:ws/scenarios/:sc', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const scenario = await getScenario(c.env, ws.id, c.req.param('sc'));
  return c.json({ scenario, problems: validateFlow(scenario.steps, scenario.start_step_id) });
});

admin.patch('/workspaces/:ws/scenarios/:sc', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ name?: string }>(c);
  if (!input.name?.trim()) throw new HttpError(400, 'name is required');
  return c.json({ scenario: await renameScenario(c.env, ws.id, c.req.param('sc'), input.name) });
});

admin.delete('/workspaces/:ws/scenarios/:sc', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  await deleteScenario(c.env, ws.id, c.req.param('sc'));
  return c.json({ ok: true });
});

admin.post('/workspaces/:ws/scenarios/:sc/steps', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ type: string; content?: string; config?: unknown; previous_step_id?: string }>(c);
  return c.json({ scenario: await addStep(c.env, ws.id, c.req.param('sc'), input) }, 201);
});

admin.patch('/workspaces/:ws/scenarios/:sc/steps/:step', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ type?: string; content?: string; config?: unknown }>(c);
  return c.json({ scenario: await updateStep(c.env, ws.id, c.req.param('sc'), c.req.param('step'), input) });
});

admin.delete('/workspaces/:ws/scenarios/:sc/steps/:step', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  return c.json({ scenario: await deleteStep(c.env, ws.id, c.req.param('sc'), c.req.param('step')) });
});

admin.post('/workspaces/:ws/scenarios/:sc/start', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ step_id?: string }>(c);
  if (!input.step_id) throw new HttpError(400, 'step_id is required');
  return c.json({ scenario: await setStartStep(c.env, ws.id, c.req.param('sc'), input.step_id) });
});

admin.post('/workspaces/:ws/scenarios/:sc/activate', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  return c.json({ scenario: await activateScenario(c.env, ws.id, c.req.param('sc')) });
});

admin.post('/workspaces/:ws/scenarios/:sc/deactivate', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  return c.json({ scenario: await deactivateScenario(c.env, ws.id, c.req.param('sc')) });
});

// ------------------------------------------------------------------------------------------------
// Agents & webhooks
// ------------------------------------------------------------------------------------------------

function assertTeamManager(auth: AppEnv['Variables']['auth']) {
  if (auth.role !== 'admin' || auth.workspaceIds.length > 0) {
    throw new HttpError(403, 'Only the owner or an unrestricted admin can manage agents');
  }
}

admin.get('/agents', async (c) => {
  const auth = c.get('auth');
  if (auth.role !== 'admin') {
    // Regular agents only need names for the assignee picker.
    const { results } = await c.env.DB.prepare('SELECT id, name FROM agents ORDER BY created_at').all();
    return c.json({ agents: results });
  }
  const { results } = await c.env.DB.prepare('SELECT id, name, email, role, workspace_ids, last_seen_at, created_at FROM agents ORDER BY created_at')
    .all<Omit<AgentRow, 'token_hash'>>();
  return c.json({ agents: results.map((a) => ({ ...a, workspace_ids: parseJson(a.workspace_ids, []) })) });
});

admin.post('/agents', async (c) => {
  assertTeamManager(c.get('auth'));
  const input = await body<{ name?: string; email?: string; role?: 'admin' | 'agent'; workspace_ids?: string[] }>(c);
  if (!input.name?.trim() || !input.email?.trim()) throw new HttpError(400, 'name and email are required');
  const token = `agt_${randomToken(32)}`;
  const id = newId('agt');
  await c.env.DB.prepare('INSERT INTO agents (id, name, email, role, workspace_ids, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      id,
      input.name.trim(),
      input.email.trim().toLowerCase(),
      input.role === 'admin' ? 'admin' : 'agent',
      JSON.stringify(input.workspace_ids || []),
      await sha256Hex(token),
      now(),
    )
    .run();
  return c.json({ agent: { id, name: input.name, email: input.email, role: input.role || 'agent' }, token, note: 'Store this token now; it is not shown again.' }, 201);
});

admin.delete('/agents/:id', async (c) => {
  assertTeamManager(c.get('auth'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE conversations SET assignee_id = NULL WHERE assignee_id = ?').bind(c.req.param('id')),
    c.env.DB.prepare('DELETE FROM agents WHERE id = ?').bind(c.req.param('id')),
  ]);
  return c.json({ ok: true });
});

admin.get('/workspaces/:ws/webhooks', async (c) => {
  const ws = await wsFor(c, c.req.param('ws'));
  const { results } = await c.env.DB.prepare('SELECT id, kind, url, events, created_at FROM webhooks WHERE workspace_id = ?').bind(ws.id).all<{
    events: string;
  }>();
  return c.json({ webhooks: results.map((w) => ({ ...w, events: parseJson(w.events, []) })) });
});

admin.post('/workspaces/:ws/webhooks', async (c) => {
  assertAdmin(c.get('auth'));
  const ws = await wsFor(c, c.req.param('ws'));
  const input = await body<{ kind?: string; url?: string; events?: string[] }>(c);
  const kind = input.kind === 'slack' || input.kind === 'discord' ? input.kind : 'generic';
  if (!input.url || !/^https:\/\//.test(input.url)) throw new HttpError(400, 'url must be https');
  const allowed = ['conversation.created', 'handoff', 'message.visitor', 'conversation.closed', 'lead.captured'];
  const events = (input.events?.length ? input.events : ['handoff', 'conversation.created', 'lead.captured']).filter((e) => allowed.includes(e));
  const secret = kind === 'generic' ? randomToken(24) : null;
  const id = newId('wh');
  await c.env.DB.prepare('INSERT INTO webhooks (id, workspace_id, kind, url, events, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, ws.id, kind, input.url, JSON.stringify(events), secret, now())
    .run();
  return c.json({ webhook: { id, kind, url: input.url, events }, signing_secret: secret }, 201);
});

admin.delete('/workspaces/:ws/webhooks/:id', async (c) => {
  assertAdmin(c.get('auth'));
  const ws = await wsFor(c, c.req.param('ws'));
  await c.env.DB.prepare('DELETE FROM webhooks WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws.id).run();
  return c.json({ ok: true });
});

export default admin;
