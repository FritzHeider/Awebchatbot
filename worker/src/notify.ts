import type { ConversationRow, CustomerRow, Env, MessageRow, Workspace } from './env';
import { hmacHex } from './auth';
import { baseUrl, escapeHtml, parseJson, today, truncate } from './util';

export type WebhookEvent = 'conversation.created' | 'handoff' | 'message.visitor' | 'conversation.closed' | 'lead.captured';

interface WebhookRow {
  id: string;
  workspace_id: string;
  kind: 'slack' | 'discord' | 'generic';
  url: string;
  events: string;
  secret: string | null;
}

function inboxLink(env: Env, ws: Workspace, conversationId: string): string {
  const base = baseUrl(env);
  return base ? `${base}/inbox/#/${ws.id}/c/${conversationId}` : '';
}

/** Fan an event out to Slack / Discord / generic webhooks configured for the workspace. */
export async function fireWebhooks(
  env: Env,
  ws: Workspace,
  event: WebhookEvent,
  payload: { conversation?: ConversationRow; customer?: CustomerRow | null; message?: MessageRow; text?: string },
): Promise<void> {
  const { results } = await env.DB.prepare('SELECT * FROM webhooks WHERE workspace_id = ?').bind(ws.id).all<WebhookRow>();
  if (!results.length) return;
  const convId = payload.conversation?.id || '';
  const link = convId ? inboxLink(env, ws, convId) : '';
  const who = payload.customer?.name || payload.customer?.email || 'A visitor';
  const headline =
    event === 'handoff'
      ? `🙋 ${who} wants to talk to a human on ${ws.name}`
      : event === 'conversation.created'
        ? `💬 New conversation on ${ws.name}`
        : event === 'lead.captured'
          ? `📇 New lead on ${ws.name}: ${payload.customer?.email || ''}`
          : event === 'conversation.closed'
            ? `✅ Conversation closed on ${ws.name}`
            : `✉️ New message on ${ws.name}`;
  const detail = payload.text || payload.message?.content || payload.conversation?.last_message_preview || '';
  const textLine = [headline, detail ? `> ${truncate(detail, 300)}` : '', link].filter(Boolean).join('\n');

  await Promise.allSettled(
    results
      .filter((hook) => parseJson<string[]>(hook.events, []).includes(event))
      .map(async (hook) => {
        let body: string;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (hook.kind === 'slack') body = JSON.stringify({ text: textLine });
        else if (hook.kind === 'discord') body = JSON.stringify({ content: truncate(textLine, 1900) });
        else {
          body = JSON.stringify({
            event,
            workspace: { id: ws.id, name: ws.name, domain: ws.domain },
            conversation: payload.conversation || null,
            customer: payload.customer || null,
            message: payload.message || null,
            link,
            sent_at: new Date().toISOString(),
          });
          if (hook.secret) headers['X-AWebChatbot-Signature'] = `sha256=${await hmacHex(hook.secret, body)}`;
        }
        const res = await fetch(hook.url, { method: 'POST', headers, body });
        if (!res.ok) console.warn('webhook failed', hook.id, res.status);
      }),
  );
}

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html }),
    });
    if (!res.ok) console.warn('resend failed', res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.warn('resend error', err instanceof Error ? err.message : err);
    return false;
  }
}

export function transcriptHtml(ws: Workspace, messages: MessageRow[]): string {
  const rows = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const who = m.role === 'visitor' ? 'You' : m.role === 'agent' ? `${ws.name} team` : ws.settings.botName;
      const time = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 16);
      return `<p style="margin:0 0 12px"><strong>${escapeHtml(who)}</strong> <span style="color:#888;font-size:12px">${time} UTC</span><br>${escapeHtml(m.content).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
  return `<div style="font-family:system-ui,sans-serif;max-width:600px"><h2 style="font-size:18px">Your conversation with ${escapeHtml(ws.name)}</h2>${rows}</div>`;
}

export async function alertTeamByEmail(env: Env, ws: Workspace, subject: string, text: string, conversationId: string) {
  const to = ws.settings.alertEmail || env.ALERT_EMAIL || '';
  if (!to) return;
  const link = inboxLink(env, ws, conversationId);
  await sendEmail(
    env,
    to,
    subject,
    `<div style="font-family:system-ui,sans-serif"><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>${link ? `<p><a href="${link}">Open in inbox</a></p>` : ''}</div>`,
  );
}

/** Optional mirror of conversations / messages / customers into Supabase (PostgREST upsert). */
export async function mirrorToSupabase(env: Env, table: 'conversations' | 'messages' | 'customers', row: object): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;
  try {
    const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/awc_${table}`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.warn('supabase mirror failed', table, res.status, (await res.text()).slice(0, 300));
  } catch (err) {
    console.warn('supabase mirror error', err instanceof Error ? err.message : err);
  }
}

export function trackEvent(env: Env, workspaceId: string, event: string, extra: { provider?: string; value?: number } = {}) {
  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: [workspaceId, event, extra.provider || ''],
      doubles: [extra.value ?? 1],
      indexes: [workspaceId],
    });
  } catch {
    // Analytics Engine not bound in local dev
  }
}

export async function recordUsage(
  env: Env,
  workspaceId: string,
  provider: string,
  model: string,
  input: number,
  output: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_daily (workspace_id, day, provider, model, requests, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (workspace_id, day, provider, model) DO UPDATE SET
       requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  )
    .bind(workspaceId, today(), provider, model, input, output)
    .run();
}
