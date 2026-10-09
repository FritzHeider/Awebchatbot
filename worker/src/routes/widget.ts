import { Hono, type Context } from 'hono';
import type { AppEnv, Env, Workspace } from '../env';
import { sanitizeVisitorId, signVisitorToken, verifyVisitorToken } from '../auth';
import { SseWriter } from '../ai/sse';
import {
  agentsOnline,
  getConversation,
  getMessages,
  handleVisitorMessage,
  handoff,
  startConversation,
  toPublicMessage,
  updateCustomerContact,
  type PublicMessage,
} from '../chat';
import { broadcast, connectToRoom } from '../realtime';
import { getWorkspace, getWorkspaceByKey, originAllowed, publicConfig } from '../workspaces';
import { HttpError, newId } from '../util';

const widget = new Hono<AppEnv>();

const ALLOWED_UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function waitUntilFor(c: Context<AppEnv>) {
  return (p: Promise<unknown>) => c.executionCtx.waitUntil(p.catch((err) => console.error('background task failed', err)));
}

function assertOrigin(c: Context<AppEnv>, ws: Workspace) {
  if (!originAllowed(ws, c.req.header('Origin') || null)) {
    throw new HttpError(403, 'This website is not allowed to use this chatbot. Add it to allowed origins.');
  }
}

async function rateLimit(env: Env, key: string): Promise<void> {
  if (!env.RATE_LIMITER) return;
  try {
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) throw new HttpError(429, 'Too many messages. Please wait a moment.');
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
}

async function verifyTurnstile(env: Env, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = (await res.json()) as { success?: boolean };
  return Boolean(data.success);
}

/** Resolve the conversation from the visitor token and make sure it belongs to the URL id. */
async function visitorConversation(c: Context<AppEnv>, conversationId: string) {
  const header = c.req.header('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '') || c.req.query('token') || '';
  const claims = await verifyVisitorToken(c.env, token);
  if (!claims || claims.conversationId !== conversationId) throw new HttpError(401, 'Invalid conversation token');
  const conv = await getConversation(c.env, conversationId);
  const ws = await getWorkspace(c.env, conv.workspace_id);
  return { conv, ws, visitorId: claims.visitorId };
}

widget.get('/config', async (c) => {
  const ws = await getWorkspaceByKey(c.env, c.req.query('key') || '');
  assertOrigin(c, ws);
  const online = await agentsOnline(c.env, ws.id);
  return c.json({ ...publicConfig(ws), agentsOnline: online }, 200, { 'Cache-Control': 'public, max-age=30' });
});

widget.post('/conversations', async (c) => {
  const body = await c.req.json<{
    key?: string;
    visitorId?: string;
    pageUrl?: string;
    referrer?: string;
    locale?: string;
    turnstileToken?: string;
  }>();
  const ws = await getWorkspaceByKey(c.env, body.key || '');
  assertOrigin(c, ws);
  const ip = c.req.header('CF-Connecting-IP') || undefined;
  await rateLimit(c.env, `start:${ip || 'unknown'}`);
  if (ws.settings.turnstileSiteKey && !(await verifyTurnstile(c.env, body.turnstileToken, ip))) {
    throw new HttpError(403, 'Bot check failed. Please reload the page and try again.');
  }
  const visitorId = sanitizeVisitorId(body.visitorId);
  const cf = (c.req.raw as Request & { cf?: { country?: string; city?: string } }).cf;
  const result = await startConversation(c.env, waitUntilFor(c), ws, {
    visitorId,
    pageUrl: body.pageUrl,
    referrer: body.referrer,
    locale: body.locale,
    userAgent: c.req.header('User-Agent'),
    country: cf?.country,
    city: cf?.city,
  });
  const token = await signVisitorToken(c.env, result.conversation.id, visitorId);
  return c.json({
    conversation: { id: result.conversation.id, status: result.conversation.status, mode: result.conversation.mode },
    visitorId,
    token,
    messages: result.messages.map(toPublicMessage),
  });
});

widget.get('/conversations/:id/messages', async (c) => {
  const { conv } = await visitorConversation(c, c.req.param('id'));
  const after = parseInt(c.req.query('after') || '0', 10) || 0;
  const messages = await getMessages(c.env, conv.id, after, 500, true);
  return c.json({
    conversation: { id: conv.id, status: conv.status, mode: conv.mode, rating: conv.rating },
    messages: messages.map(toPublicMessage),
  });
});

widget.post('/conversations/:id/messages', async (c) => {
  const { conv, ws } = await visitorConversation(c, c.req.param('id'));
  assertOrigin(c, ws);
  await rateLimit(c.env, `msg:${conv.id}`);
  const body = await c.req.json<{ content?: string; attachments?: PublicMessage['attachments'] }>();
  const content = typeof body.content === 'string' ? body.content : '';
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter((a) => a && typeof a.url === 'string' && a.url.startsWith('/v1/files/'))
        .slice(0, 5)
        .map((a) => ({ url: a.url, name: String(a.name || 'file').slice(0, 200), type: String(a.type || ''), size: Number(a.size) || 0 }))
    : [];

  const sse = new SseWriter({ 'Access-Control-Allow-Origin': c.req.header('Origin') || '*' });
  const waitUntil = waitUntilFor(c);
  const work = (async () => {
    try {
      await handleVisitorMessage(c.env, waitUntil, ws, conv.id, { content, attachments }, {
        message: (m) => sse.send('message', m),
        delta: (t) => sse.send('delta', { text: t }),
        status: (s) => sse.send('status', s),
      });
      const fresh = await getConversation(c.env, conv.id);
      await sse.send('done', { conversation: { id: fresh.id, status: fresh.status, mode: fresh.mode } });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Something went wrong. Please try again.';
      if (!(err instanceof HttpError)) console.error('visitor message failed', err);
      await sse.send('error', { status, message });
    } finally {
      await sse.close();
    }
  })();
  c.executionCtx.waitUntil(work);
  return sse.response;
});

widget.post('/conversations/:id/identify', async (c) => {
  const { conv, ws } = await visitorConversation(c, c.req.param('id'));
  const body = await c.req.json<{ name?: string; email?: string; phone?: string; attributes?: Record<string, unknown> }>();
  const attributes: Record<string, string> = {};
  if (body.attributes && typeof body.attributes === 'object') {
    for (const [k, v] of Object.entries(body.attributes).slice(0, 30)) {
      if (/^[a-zA-Z0-9_]{1,40}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        attributes[k] = String(v).slice(0, 500);
      }
    }
  }
  const customer = await updateCustomerContact(c.env, waitUntilFor(c), ws, conv.customer_id, { ...body, attributes }, conv);
  return c.json({ ok: true, customer: { name: customer.name, email: customer.email } });
});

widget.post('/conversations/:id/rate', async (c) => {
  const { conv, ws } = await visitorConversation(c, c.req.param('id'));
  const body = await c.req.json<{ rating?: number }>();
  const rating = Math.round(Number(body.rating));
  if (!(rating >= 1 && rating <= 5)) throw new HttpError(400, 'Rating must be 1-5');
  await c.env.DB.prepare('UPDATE conversations SET rating = ?, updated_at = ? WHERE id = ?').bind(rating, Date.now(), conv.id).run();
  c.executionCtx.waitUntil(broadcast(c.env, `inbox:${ws.id}`, { type: 'conversation.rated', conversationId: conv.id, rating }));
  return c.json({ ok: true });
});

widget.post('/conversations/:id/handoff', async (c) => {
  const { conv, ws } = await visitorConversation(c, c.req.param('id'));
  if (!ws.settings.handoffEnabled) throw new HttpError(400, 'Human handoff is disabled for this site');
  if (conv.mode === 'human') return c.json({ messages: [] });
  const messages = await handoff(c.env, waitUntilFor(c), ws, conv, 'button');
  return c.json({ messages: messages.map(toPublicMessage) });
});

widget.post('/conversations/:id/upload', async (c) => {
  const { conv, ws } = await visitorConversation(c, c.req.param('id'));
  await rateLimit(c.env, `upload:${conv.id}`);
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'No file uploaded');
  const blob = file as unknown as File;
  if (!ALLOWED_UPLOAD_TYPES.has(blob.type)) throw new HttpError(400, 'Only images, PDFs and text files are allowed');
  if (blob.size > MAX_UPLOAD_BYTES) throw new HttpError(400, 'File is larger than 5 MB');
  const safeName = (blob.name || 'upload').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const key = `${ws.id}/${conv.id}/${newId('f')}-${safeName}`;
  await c.env.FILES.put(key, blob.stream(), {
    httpMetadata: { contentType: blob.type, contentDisposition: `inline; filename="${safeName}"` },
    customMetadata: { conversationId: conv.id },
  });
  return c.json({ url: `/v1/files/${key}`, name: safeName, type: blob.type, size: blob.size });
});

widget.get('/files/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/v1\/files\//, ''));
  if (!key || key.includes('..')) throw new HttpError(400, 'Bad file key');
  const object = await c.env.FILES.get(key);
  if (!object) throw new HttpError(404, 'File not found');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (headers.get('Content-Type')?.startsWith('text/')) headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(object.body, { headers });
});

widget.get('/ws/:id', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected websocket');
  const claims = await verifyVisitorToken(c.env, c.req.query('token'));
  const id = c.req.param('id');
  if (!claims || claims.conversationId !== id) throw new HttpError(401, 'Invalid conversation token');
  return connectToRoom(c.env, `conv:${id}`, c.req.raw, 'visitor', claims.visitorId, 'Visitor');
});

export default widget;
