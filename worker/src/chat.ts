import type { ConversationRow, CustomerRow, Env, MessageRow, Workspace } from './env';
import { HANDOFF_MARKER, MarkerFilter } from './ai/marker';
import { SUMMARY_SYSTEM, buildSuggestPrompt, buildSystemPrompt, historyToTurns } from './ai/prompt';
import { generate, providerChain, type ChatTurn } from './ai/providers';
import { extractiveAnswer, searchKnowledge, type KnowledgeHit } from './rag';
import { broadcast, presence } from './realtime';
import { getActiveScenario, runFlow, type FlowState, type FlowStep } from './scenario';
import { alertTeamByEmail, fireWebhooks, mirrorToSupabase, recordUsage, sendEmail, trackEvent, transcriptHtml } from './notify';
import { HttpError, isEmail, newId, now, parseJson, truncate } from './util';

export type WaitUntil = (promise: Promise<unknown>) => void;

export interface ConversationMeta {
  flow?: FlowState;
  referrer?: string;
  userAgent?: string;
  country?: string;
  city?: string;
  askEmail?: boolean;
  summary?: string;
  tags?: string[];
}

export interface PublicMessage {
  id: string;
  role: MessageRow['role'];
  content: string;
  buttons: string[];
  attachments: { url: string; name: string; type: string; size: number }[];
  meta: Record<string, unknown>;
  authorName?: string;
  createdAt: number;
}

export function toPublicMessage(row: MessageRow): PublicMessage {
  const meta = parseJson<Record<string, unknown>>(row.meta, {});
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    buttons: parseJson<string[]>(row.buttons, []),
    attachments: parseJson(row.attachments, []),
    meta,
    authorName: typeof meta.authorName === 'string' ? meta.authorName : undefined,
    createdAt: row.created_at,
  };
}

export async function getConversation(env: Env, id: string): Promise<ConversationRow> {
  const row = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<ConversationRow>();
  if (!row) throw new HttpError(404, `Conversation ${id} not found`);
  return row;
}

export async function getMessages(
  env: Env,
  conversationId: string,
  after = 0,
  limit = 500,
  visitorView = false,
): Promise<MessageRow[]> {
  const notes = visitorView ? "AND json_extract(meta, '$.note') IS NULL" : '';
  const { results } = await env.DB.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ${notes} ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  )
    .bind(conversationId, after, limit)
    .all<MessageRow>();
  return results;
}

export async function getCustomer(env: Env, id: string): Promise<CustomerRow | null> {
  return env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<CustomerRow>();
}

export async function upsertCustomer(
  env: Env,
  workspaceId: string,
  visitorId: string,
  attrs: Record<string, string> = {},
): Promise<CustomerRow> {
  const ts = now();
  const existing = await env.DB.prepare('SELECT * FROM customers WHERE workspace_id = ? AND visitor_id = ?')
    .bind(workspaceId, visitorId)
    .first<CustomerRow>();
  if (existing) {
    const merged = { ...parseJson<Record<string, string>>(existing.attributes, {}), ...attrs };
    await env.DB.prepare('UPDATE customers SET last_seen_at = ?, attributes = ? WHERE id = ?')
      .bind(ts, JSON.stringify(merged), existing.id)
      .run();
    return { ...existing, last_seen_at: ts, attributes: JSON.stringify(merged) };
  }
  const id = newId('cus');
  await env.DB.prepare(
    'INSERT INTO customers (id, workspace_id, visitor_id, attributes, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, workspaceId, visitorId, JSON.stringify(attrs), ts, ts)
    .run();
  return (await getCustomer(env, id))!;
}

export async function updateCustomerContact(
  env: Env,
  waitUntil: WaitUntil,
  ws: Workspace,
  customerId: string,
  input: { name?: string; email?: string; phone?: string; attributes?: Record<string, string> },
  conversation?: ConversationRow,
): Promise<CustomerRow> {
  const customer = await getCustomer(env, customerId);
  if (!customer) throw new HttpError(404, 'Customer not found');
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
  const name = str(input.name)?.trim().slice(0, 120) || customer.name;
  const emailInput = str(input.email)?.trim().toLowerCase();
  if (emailInput && !isEmail(emailInput)) throw new HttpError(400, 'Invalid email address');
  const email = emailInput || customer.email;
  const phone = str(input.phone)?.trim().slice(0, 40) || customer.phone;
  const attributes = { ...parseJson<Record<string, string>>(customer.attributes, {}), ...(input.attributes || {}) };
  await env.DB.prepare('UPDATE customers SET name = ?, email = ?, phone = ?, attributes = ?, last_seen_at = ? WHERE id = ?')
    .bind(name, email, phone, JSON.stringify(attributes), now(), customerId)
    .run();
  const updated = (await getCustomer(env, customerId))!;
  waitUntil(mirrorToSupabase(env, 'customers', { ...updated, attributes }));
  if (emailInput && emailInput !== customer.email) {
    waitUntil(fireWebhooks(env, ws, 'lead.captured', { customer: updated, conversation }));
    trackEvent(env, ws.id, 'lead');
  }
  if (conversation) {
    waitUntil(broadcast(env, `inbox:${ws.id}`, { type: 'customer.updated', conversationId: conversation.id, customer: updated }));
  }
  return updated;
}

interface NewMessage {
  role: MessageRow['role'];
  content: string;
  authorId?: string | null;
  authorName?: string;
  buttons?: string[];
  attachments?: PublicMessage['attachments'];
  meta?: Record<string, unknown>;
}

/** Persist a message, update conversation counters, push it to live sockets and mirrors. */
export async function insertMessage(
  env: Env,
  waitUntil: WaitUntil,
  ws: Workspace,
  conversationId: string,
  input: NewMessage,
): Promise<MessageRow> {
  const id = newId('msg');
  // Strictly increasing timestamps keep ordering stable when several messages are inserted in one request.
  const ts = now();
  const meta = { ...(input.meta || {}), ...(input.authorName ? { authorName: input.authorName } : {}) };
  const row: MessageRow = {
    id,
    conversation_id: conversationId,
    workspace_id: ws.id,
    role: input.role,
    author_id: input.authorId || null,
    content: input.content,
    attachments: JSON.stringify(input.attachments || []),
    buttons: JSON.stringify(input.buttons || []),
    meta: JSON.stringify(meta),
    created_at: ts,
  };
  const preview = truncate(input.content.replace(/\s+/g, ' '), 140);
  const statements = [
    env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, workspace_id, role, author_id, content, attachments, buttons, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(row.id, row.conversation_id, row.workspace_id, row.role, row.author_id, row.content, row.attachments, row.buttons, row.meta, row.created_at),
    env.DB.prepare(
      'UPDATE conversations SET message_count = message_count + 1, last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?',
    ).bind(ts, preview, ts, conversationId),
  ];
  if (input.role !== 'system' && input.content.trim()) {
    statements.push(
      env.DB.prepare('INSERT INTO messages_fts (content, message_id, conversation_id, workspace_id) VALUES (?, ?, ?, ?)').bind(
        input.content,
        id,
        conversationId,
        ws.id,
      ),
    );
  }
  await env.DB.batch(statements);
  const publicMessage = toPublicMessage(row);
  waitUntil(
    Promise.all([
      broadcast(env, `conv:${conversationId}`, { type: 'message', message: publicMessage }),
      broadcast(env, `inbox:${ws.id}`, { type: 'message', conversationId, message: publicMessage, preview }),
      mirrorToSupabase(env, 'messages', { ...row, attachments: input.attachments || [], buttons: input.buttons || [], meta }),
    ]),
  );
  // Ensure the next message gets a later timestamp.
  await new Promise((r) => setTimeout(r, 2));
  return row;
}

async function saveMeta(env: Env, conversationId: string, meta: ConversationMeta): Promise<void> {
  await env.DB.prepare('UPDATE conversations SET meta = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(meta), now(), conversationId)
    .run();
}

async function setMode(env: Env, conversationId: string, mode: ConversationRow['mode']): Promise<void> {
  await env.DB.prepare('UPDATE conversations SET mode = ?, updated_at = ? WHERE id = ?').bind(mode, now(), conversationId).run();
}

async function flowSteps(env: Env, workspaceId: string, scenarioId: string): Promise<Map<string, FlowStep> | null> {
  const active = await getActiveScenario(env, workspaceId);
  if (!active || active.id !== scenarioId) return null;
  return new Map(active.steps.map((s) => [s.id, s]));
}

export async function agentsOnline(env: Env, workspaceId: string): Promise<number> {
  const p = await presence(env, `inbox:${workspaceId}`);
  return p.agents.length;
}

// ----------------------------------------------------------------------------------------------
// Conversation lifecycle
// ----------------------------------------------------------------------------------------------

export async function startConversation(
  env: Env,
  waitUntil: WaitUntil,
  ws: Workspace,
  input: { visitorId: string; pageUrl?: string; referrer?: string; userAgent?: string; country?: string; city?: string; locale?: string },
): Promise<{ conversation: ConversationRow; customer: CustomerRow; messages: MessageRow[] }> {
  const pageUrl = input.pageUrl && /^https?:\/\//i.test(input.pageUrl) ? input.pageUrl.slice(0, 1000) : null;
  const referrer = input.referrer && /^https?:\/\//i.test(input.referrer) ? input.referrer : undefined;
  const attrs: Record<string, string> = {};
  if (input.country) attrs.country = input.country;
  if (input.city) attrs.city = input.city;
  if (input.locale) attrs.locale = input.locale.slice(0, 20);
  const customer = await upsertCustomer(env, ws.id, input.visitorId, attrs);
  const id = newId('conv');
  const ts = now();
  const meta: ConversationMeta = {
    referrer: referrer?.slice(0, 500),
    userAgent: input.userAgent?.slice(0, 300),
    country: input.country,
    city: input.city,
  };
  await env.DB.prepare(
    `INSERT INTO conversations (id, workspace_id, customer_id, status, mode, page_url, meta, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, 'open', 'bot', ?, ?, ?, ?, ?)`,
  )
    .bind(id, ws.id, customer.id, pageUrl, JSON.stringify(meta), ts, ts, ts)
    .run();

  const scenario = await getActiveScenario(env, ws.id);
  if (scenario && scenario.start_step_id) {
    const steps = new Map(scenario.steps.map((s) => [s.id, s]));
    const result = runFlow(steps, scenario.start_step_id, null, scenario.id);
    for (const m of result.messages) {
      await insertMessage(env, waitUntil, ws, id, { role: 'bot', content: m.content, buttons: m.buttons, authorName: ws.settings.botName });
    }
    meta.flow = result.state;
    await saveMeta(env, id, meta);
    if (result.action === 'wait') await setMode(env, id, 'flow');
    else if (result.action === 'handoff') await handoff(env, waitUntil, ws, await getConversation(env, id), 'flow');
  } else if (ws.settings.greeting.trim()) {
    await insertMessage(env, waitUntil, ws, id, {
      role: 'bot',
      content: ws.settings.greeting,
      buttons: ws.settings.quickReplies,
      authorName: ws.settings.botName,
    });
  }

  const conversation = await getConversation(env, id);
  waitUntil(mirrorToSupabase(env, 'customers', { ...customer, attributes: parseJson(customer.attributes, {}) }));
  waitUntil(mirrorToSupabase(env, 'conversations', { ...conversation, meta: parseJson(conversation.meta, {}) }));
  waitUntil(broadcast(env, `inbox:${ws.id}`, { type: 'conversation.created', conversation, customer }));
  waitUntil(fireWebhooks(env, ws, 'conversation.created', { conversation, customer }));
  trackEvent(env, ws.id, 'conversation.created');
  return { conversation, customer, messages: await getMessages(env, id, 0, 500, true) };
}

export type StreamSink = {
  message: (m: PublicMessage) => Promise<void>;
  delta: (text: string) => Promise<void>;
  status: (s: Record<string, unknown>) => Promise<void>;
};

/** Visitor sent a message: persist it, then run the flow, the AI or route to a human. */
export async function handleVisitorMessage(
  env: Env,
  waitUntil: WaitUntil,
  ws: Workspace,
  conversationId: string,
  input: { content: string; attachments?: PublicMessage['attachments'] },
  sink: StreamSink,
): Promise<void> {
  let conv = await getConversation(env, conversationId);
  const content = input.content.trim().slice(0, 4000);
  if (!content && !input.attachments?.length) throw new HttpError(400, 'Message is empty');

  if (conv.status === 'closed') {
    await env.DB.prepare("UPDATE conversations SET status = 'open', closed_at = NULL, updated_at = ? WHERE id = ?")
      .bind(now(), conv.id)
      .run();
    conv = await getConversation(env, conv.id);
    waitUntil(broadcast(env, `inbox:${ws.id}`, { type: 'conversation.updated', conversation: conv }));
  }

  const visitorMsg = await insertMessage(env, waitUntil, ws, conv.id, {
    role: 'visitor',
    content: content || '(attachment)',
    attachments: input.attachments,
  });
  await sink.message(toPublicMessage(visitorMsg));
  trackEvent(env, ws.id, 'message.visitor');
  if (!conv.subject && content) {
    await env.DB.prepare('UPDATE conversations SET subject = ? WHERE id = ?').bind(truncate(content, 120), conv.id).run();
  }

  const customer = await getCustomer(env, conv.customer_id);
  const meta = parseJson<ConversationMeta>(conv.meta, {});

  // Pending "leave your email" request after an offline handoff.
  if (meta.askEmail && conv.mode === 'human' && isEmail(content)) {
    await updateCustomerContact(env, waitUntil, ws, conv.customer_id, { email: content }, conv);
    meta.askEmail = false;
    await saveMeta(env, conv.id, meta);
    const thanks = await insertMessage(env, waitUntil, ws, conv.id, {
      role: 'bot',
      content: `Thanks! We'll reply to **${content}** as soon as a team member is available.`,
      authorName: ws.settings.botName,
    });
    await sink.message(toPublicMessage(thanks));
    return;
  }

  if (conv.mode === 'human') {
    waitUntil(fireWebhooks(env, ws, 'message.visitor', { conversation: conv, customer, message: visitorMsg }));
    await sink.status({ mode: 'human', waitingForAgent: true });
    return;
  }

  // Explicit request for a human.
  if (ws.settings.handoffEnabled && wantsHuman(content, ws.settings.handoffKeywords)) {
    const msgs = await handoff(env, waitUntil, ws, conv, 'keyword');
    for (const m of msgs) await sink.message(toPublicMessage(m));
    return;
  }

  let aiInput: string | null = content;
  if (conv.mode === 'flow' && meta.flow) {
    const steps = await flowSteps(env, ws.id, meta.flow.scenarioId);
    if (!steps) {
      meta.flow = undefined;
      await saveMeta(env, conv.id, meta);
      await setMode(env, conv.id, 'bot');
    } else {
      const result = runFlow(steps, null, meta.flow, meta.flow.scenarioId, content);
      for (const m of result.messages) {
        const row = await insertMessage(env, waitUntil, ws, conv.id, {
          role: 'bot',
          content: m.content,
          buttons: m.buttons,
          authorName: ws.settings.botName,
        });
        await sink.message(toPublicMessage(row));
      }
      meta.flow = result.state;
      await saveMeta(env, conv.id, meta);
      await applyFlowVariables(env, waitUntil, ws, conv, result.state.vars);
      if (result.action === 'wait') return;
      if (result.action === 'handoff') {
        const msgs = await handoff(env, waitUntil, ws, await getConversation(env, conv.id), 'flow');
        for (const m of msgs) await sink.message(toPublicMessage(m));
        return;
      }
      await setMode(env, conv.id, 'bot');
      if (!result.passthrough) return;
      aiInput = content;
    }
  }

  if (!aiInput) return;
  await sink.status({ typing: true });
  const answer = await answerWithAi(env, waitUntil, ws, await getConversation(env, conv.id), customer, sink.delta);
  await sink.message(toPublicMessage(answer.message));
  if (answer.handoff) {
    const msgs = await handoff(env, waitUntil, ws, await getConversation(env, conv.id), 'ai');
    for (const m of msgs) await sink.message(toPublicMessage(m));
  }
}

// Words that name a person. A keyword made only of these ("human", "real person", "support team") is too common in
// ordinary questions ("does it need human approval?", "is this person real?") to trigger a handoff on its own.
const PERSON_WORDS = new Set([
  'human', 'person', 'agent', 'someone', 'somebody', 'representative', 'rep', 'operator', 'staff',
  'team', 'support', 'member', 'real', 'live', 'actual',
]);
const PERSON_NOUNS = 'human|person|agent|someone|somebody|representative|rep|operator|staff|support team|team member';
const FILLERS = new Set(['please', 'pls', 'plz', 'now', 'hi', 'hello', 'hey', 'a', 'an', 'the']);
const ASKS_FOR_PERSON = [
  new RegExp(`\\b(talk|speak|chat|connect|transfer|escalate)(\\s+me)?\\s+(to|with)\\s+((a|an|the|your|some)\\s+)?((real|live|actual)\\s+)?(${PERSON_NOUNS})\\b`),
  new RegExp(`\\b(need|want|get me|give me)\\s+(a|an|some)\\s+((real|live|actual)\\s+)?(${PERSON_NOUNS})\\b`),
];

export function wantsHuman(text: string, keywords: string[]): boolean {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')} `;
  const words = t.trim().split(/\s+/);
  if (ASKS_FOR_PERSON.some((re) => re.test(t))) return true;
  // Long messages only count when they clearly ask for a person.
  if (words.length > 12) return false;
  // A bare request like "human", "agent please" or "real person".
  if (words.every((w) => PERSON_WORDS.has(w) || FILLERS.has(w)) && words.some((w) => PERSON_WORDS.has(w))) return true;
  return keywords.some((k) => {
    const kw = k.toLowerCase().trim();
    if (!kw || kw.split(/\s+/).every((w) => PERSON_WORDS.has(w))) return false;
    return t.includes(` ${kw} `);
  });
}

async function applyFlowVariables(env: Env, waitUntil: WaitUntil, ws: Workspace, conv: ConversationRow, vars: Record<string, string>) {
  const contact: { name?: string; email?: string; phone?: string; attributes?: Record<string, string> } = {};
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (key === 'name') contact.name = value;
    else if (key === 'email' && isEmail(value)) contact.email = value;
    else if (key === 'phone') contact.phone = value;
    else attributes[key] = value;
  }
  if (Object.keys(attributes).length) contact.attributes = attributes;
  if (Object.keys(contact).length) await updateCustomerContact(env, waitUntil, ws, conv.customer_id, contact, conv);
}

/** Generate the bot reply with RAG context, streaming deltas to the caller. */
export async function answerWithAi(
  env: Env,
  waitUntil: WaitUntil,
  ws: Workspace,
  conv: ConversationRow,
  customer: CustomerRow | null,
  onDelta: (text: string) => Promise<void>,
): Promise<{ message: MessageRow; handoff: boolean }> {
  const history = await getMessages(env, conv.id);
  const lastVisitor = [...history].reverse().find((m) => m.role === 'visitor');
  const prevVisitor = [...history].reverse().filter((m) => m.role === 'visitor')[1];
  const query = [lastVisitor?.content || '', prevVisitor && (lastVisitor?.content.length || 0) < 40 ? prevVisitor.content : '']
    .join(' ')
    .trim();
  const hits = await searchKnowledge(env, ws.id, query, 6);
  const system = buildSystemPrompt(ws, hits, { name: customer?.name, email: customer?.email, pageUrl: conv.page_url });
  const turns = historyToTurns(history);
  const chain = providerChain(env, ws.settings.provider, ws.settings.fallbacks);
  const filter = new MarkerFilter(HANDOFF_MARKER);

  const result = await generate(
    env,
    chain,
    { system, messages: turns, temperature: ws.settings.temperature, maxTokens: ws.settings.maxTokens },
    ws.settings.model || undefined,
    async (delta) => {
      const safe = filter.push(delta);
      if (safe) await onDelta(safe);
    },
    ws.settings.provider,
  );
  let text: string;
  let provider = 'extractive';
  let model = 'none';
  if (result) {
    const tail = filter.flush();
    if (tail) await onDelta(tail);
    text = result.text.split(HANDOFF_MARKER).join('').trim();
    provider = result.provider;
    model = result.model;
    waitUntil(recordUsage(env, ws.id, result.provider, result.model, result.usage.input, result.usage.output));
  } else {
    text = extractiveAnswer(hits, ws.settings.handoffEnabled);
    await onDelta(text);
  }
  if (!text) text = "Let me get a member of our team to help with that.";
  const sources = dedupeSources(hits).slice(0, 3);
  const message = await insertMessage(env, waitUntil, ws, conv.id, {
    role: 'bot',
    content: text,
    authorName: ws.settings.botName,
    meta: { provider, model, sources: ws.settings.showSources ? sources : [] },
  });
  trackEvent(env, ws.id, 'message.bot', { provider });
  return { message, handoff: filter.found };
}

function dedupeSources(hits: KnowledgeHit[]): { url: string; title: string }[] {
  const seen = new Set<string>();
  const out: { url: string; title: string }[] = [];
  for (const hit of hits) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push({ url: hit.url, title: hit.title });
  }
  return out;
}

/** Route the conversation to the human team. Returns the bot messages that were added. */
export async function handoff(
  env: Env,
  waitUntil: WaitUntil,
  ws: Workspace,
  conv: ConversationRow,
  reason: 'keyword' | 'ai' | 'flow' | 'button',
): Promise<MessageRow[]> {
  const ts = now();
  await env.DB.prepare(
    "UPDATE conversations SET mode = 'human', status = 'open', handoff_at = COALESCE(handoff_at, ?), updated_at = ? WHERE id = ?",
  )
    .bind(ts, ts, conv.id)
    .run();
  const customer = await getCustomer(env, conv.customer_id);
  const online = await agentsOnline(env, ws.id);
  const added: MessageRow[] = [];
  const meta = parseJson<ConversationMeta>((await getConversation(env, conv.id)).meta, {});
  if (online > 0) {
    added.push(
      await insertMessage(env, waitUntil, ws, conv.id, {
        role: 'bot',
        content: ws.settings.handoffMessage,
        authorName: ws.settings.botName,
        meta: { handoff: true, reason },
      }),
    );
  } else {
    const needEmail = !customer?.email;
    added.push(
      await insertMessage(env, waitUntil, ws, conv.id, {
        role: 'bot',
        content: needEmail
          ? ws.settings.offlineMessage
          : `${ws.settings.handoffMessage} We'll also follow up at **${customer?.email}** if we miss you here.`,
        authorName: ws.settings.botName,
        meta: { handoff: true, reason, askEmail: needEmail },
      }),
    );
    if (needEmail) {
      meta.askEmail = true;
      await saveMeta(env, conv.id, meta);
    }
  }
  const updated = await getConversation(env, conv.id);
  waitUntil(mirrorToSupabase(env, 'conversations', { ...updated, meta: parseJson(updated.meta, {}) }));
  waitUntil(broadcast(env, `inbox:${ws.id}`, { type: 'conversation.handoff', conversation: updated, customer }));
  waitUntil(broadcast(env, `conv:${conv.id}`, { type: 'status', mode: 'human' }));
  waitUntil(fireWebhooks(env, ws, 'handoff', { conversation: updated, customer }));
  waitUntil(
    alertTeamByEmail(
      env,
      ws,
      `[${ws.name}] Visitor needs a human`,
      `${customer?.name || customer?.email || 'A visitor'} asked for help.\n\nLast message: ${updated.last_message_preview || ''}`,
      conv.id,
    ),
  );
  trackEvent(env, ws.id, 'handoff');
  return added;
}

export async function agentReply(
  env: Env,
  waitUntil: WaitUntil,
  ws: Workspace,
  conversationId: string,
  agent: { id: string | null; name: string },
  content: string,
  attachments: PublicMessage['attachments'] = [],
): Promise<MessageRow> {
  const conv = await getConversation(env, conversationId);
  const text = content.trim();
  if (!text && !attachments.length) throw new HttpError(400, 'Reply is empty');
  const ts = now();
  await env.DB.prepare(
    `UPDATE conversations SET mode = 'human', status = 'open', closed_at = NULL,
       first_response_at = COALESCE(first_response_at, ?),
       handoff_at = COALESCE(handoff_at, ?),
       assignee_id = COALESCE(assignee_id, ?), updated_at = ? WHERE id = ?`,
  )
    .bind(ts, ts, agent.id, ts, conv.id)
    .run();
  const row = await insertMessage(env, waitUntil, ws, conv.id, {
    role: 'agent',
    content: text,
    authorId: agent.id,
    authorName: agent.name,
    attachments,
  });
  const meta = parseJson<ConversationMeta>(conv.meta, {});
  if (meta.askEmail) {
    meta.askEmail = false;
    await saveMeta(env, conv.id, meta);
  }
  // Visitor not connected and we have their email: send the reply by email too.
  const live = await presence(env, `conv:${conv.id}`);
  if (live.visitors === 0) {
    const customer = await getCustomer(env, conv.customer_id);
    if (customer?.email) {
      waitUntil(
        sendEmail(
          env,
          customer.email,
          `New reply from ${ws.name}`,
          `<div style="font-family:system-ui,sans-serif"><p><strong>${agent.name}</strong> replied:</p><p>${text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/\n/g, '<br>')}</p><p><a href="https://${ws.domain}">Continue the conversation on ${ws.domain}</a></p></div>`,
        ),
      );
    }
  }
  waitUntil(
    getConversation(env, conv.id).then((updated) =>
      broadcast(env, `inbox:${ws.id}`, { type: 'conversation.updated', conversation: updated }),
    ),
  );
  trackEvent(env, ws.id, 'message.agent');
  return row;
}

export async function assignConversation(env: Env, waitUntil: WaitUntil, ws: Workspace, conversationId: string, agentId: string | null) {
  await getConversation(env, conversationId);
  if (agentId) {
    const agent = await env.DB.prepare('SELECT id FROM agents WHERE id = ?').bind(agentId).first();
    if (!agent) throw new HttpError(404, `Agent ${agentId} not found`);
  }
  await env.DB.prepare('UPDATE conversations SET assignee_id = ?, updated_at = ? WHERE id = ?').bind(agentId, now(), conversationId).run();
  const conv = await getConversation(env, conversationId);
  waitUntil(broadcast(env, `inbox:${ws.id}`, { type: 'conversation.updated', conversation: conv }));
  return conv;
}

export async function closeConversation(env: Env, waitUntil: WaitUntil, ws: Workspace, conversationId: string, by: string) {
  const conv = await getConversation(env, conversationId);
  if (conv.status === 'closed') return conv;
  const ts = now();
  await env.DB.prepare("UPDATE conversations SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").bind(ts, ts, conv.id).run();
  await insertMessage(env, waitUntil, ws, conv.id, { role: 'system', content: `Conversation closed by ${by}.`, meta: { event: 'closed' } });
  const updated = await getConversation(env, conv.id);
  waitUntil(broadcast(env, `conv:${conv.id}`, { type: 'status', status: 'closed' }));
  waitUntil(broadcast(env, `inbox:${ws.id}`, { type: 'conversation.updated', conversation: updated }));
  waitUntil(fireWebhooks(env, ws, 'conversation.closed', { conversation: updated }));
  waitUntil(mirrorToSupabase(env, 'conversations', { ...updated, meta: parseJson(updated.meta, {}) }));
  if (ws.settings.emailTranscripts) {
    const customer = await getCustomer(env, conv.customer_id);
    if (customer?.email) {
      const messages = await getMessages(env, conv.id);
      waitUntil(sendEmail(env, customer.email, `Your conversation with ${ws.name}`, transcriptHtml(ws, messages)));
    }
  }
  trackEvent(env, ws.id, 'conversation.closed');
  return updated;
}

export async function reopenConversation(env: Env, waitUntil: WaitUntil, ws: Workspace, conversationId: string) {
  await getConversation(env, conversationId);
  await env.DB.prepare("UPDATE conversations SET status = 'open', closed_at = NULL, updated_at = ? WHERE id = ?")
    .bind(now(), conversationId)
    .run();
  const conv = await getConversation(env, conversationId);
  waitUntil(broadcast(env, `inbox:${ws.id}`, { type: 'conversation.updated', conversation: conv }));
  waitUntil(broadcast(env, `conv:${conversationId}`, { type: 'status', status: 'open' }));
  return conv;
}

async function collect(env: Env, ws: Workspace, system: string, turns: ChatTurn[], maxTokens: number): Promise<string> {
  const chain = providerChain(env, ws.settings.provider, ws.settings.fallbacks);
  const result = await generate(
    env,
    chain,
    { system, messages: turns, temperature: 0.3, maxTokens },
    ws.settings.model || undefined,
    undefined,
    ws.settings.provider,
  );
  if (!result) throw new HttpError(503, 'No AI provider is configured or reachable');
  await recordUsage(env, ws.id, result.provider, result.model, result.usage.input, result.usage.output);
  return result.text.split(HANDOFF_MARKER).join('').trim();
}

/** Draft a reply for a human agent, grounded in the knowledge base. */
export async function suggestReply(env: Env, ws: Workspace, conversationId: string, agentName: string, instructions?: string) {
  const conv = await getConversation(env, conversationId);
  const customer = await getCustomer(env, conv.customer_id);
  const history = await getMessages(env, conversationId);
  const lastVisitor = [...history].reverse().find((m) => m.role === 'visitor');
  const hits = await searchKnowledge(env, ws.id, lastVisitor?.content || conv.subject || '', 6);
  let system = buildSuggestPrompt(ws, hits, { name: customer?.name, email: customer?.email, pageUrl: conv.page_url }, agentName);
  if (instructions?.trim()) system += `\n\nExtra instructions from the agent: ${instructions.trim()}`;
  const turns = historyToTurns(history, 30);
  turns.push({ role: 'user', content: '(Draft the next reply to the customer now.)' });
  const draft = await collect(env, ws, system, turns, 600);
  return { draft, sources: dedupeSources(hits).slice(0, 3) };
}

export async function summarizeConversation(env: Env, ws: Workspace, conversationId: string) {
  const conv = await getConversation(env, conversationId);
  const history = await getMessages(env, conversationId);
  const transcript = history
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')
    .slice(-12000);
  const summary = await collect(env, ws, SUMMARY_SYSTEM, [{ role: 'user', content: `Conversation on ${ws.name}:\n\n${transcript}` }], 500);
  const meta = parseJson<ConversationMeta>(conv.meta, {});
  meta.summary = summary;
  await saveMeta(env, conv.id, meta);
  return summary;
}

/** Ask the bot a question without creating a conversation (for testing from Claude or the inbox). */
export async function testChat(env: Env, ws: Workspace, question: string) {
  const hits = await searchKnowledge(env, ws.id, question, 6);
  const system = buildSystemPrompt(ws, hits, {});
  const chain = providerChain(env, ws.settings.provider, ws.settings.fallbacks);
  const result = await generate(
    env,
    chain,
    { system, messages: [{ role: 'user', content: question }], temperature: ws.settings.temperature, maxTokens: ws.settings.maxTokens },
    ws.settings.model || undefined,
    undefined,
    ws.settings.provider,
  );
  if (result) await recordUsage(env, ws.id, result.provider, result.model, result.usage.input, result.usage.output);
  const raw = result ? result.text : extractiveAnswer(hits, ws.settings.handoffEnabled);
  return {
    answer: raw.split(HANDOFF_MARKER).join('').trim(),
    wouldHandoff: raw.includes(HANDOFF_MARKER),
    provider: result?.provider || 'extractive',
    model: result?.model || 'none',
    providersTried: chain,
    sources: hits.map((h) => ({ url: h.url, title: h.title, score: h.score })),
  };
}

export async function conversationTranscript(env: Env, ws: Workspace, conversationId: string): Promise<string> {
  const conv = await getConversation(env, conversationId);
  const customer = await getCustomer(env, conv.customer_id);
  const messages = await getMessages(env, conversationId);
  const lines = [
    `# Conversation ${conv.id}`,
    '',
    `- Workspace: ${ws.name} (${ws.domain})`,
    `- Customer: ${customer?.name || '-'} <${customer?.email || '-'}>`,
    `- Status: ${conv.status} · Mode: ${conv.mode}`,
    `- Started: ${new Date(conv.created_at).toISOString()}`,
    conv.page_url ? `- Page: ${conv.page_url}` : '',
    '',
  ];
  for (const m of messages) {
    const who =
      m.role === 'visitor' ? customer?.name || 'Visitor' : m.role === 'agent' ? parseJson<{ authorName?: string }>(m.meta, {}).authorName || 'Agent' : m.role === 'bot' ? ws.settings.botName : 'System';
    lines.push(`**${who}** (${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')}):`, m.content, '');
  }
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}
