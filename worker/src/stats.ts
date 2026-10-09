import type { Env } from './env';
import { clampInt } from './util';

export async function inboxStats(env: Env, workspaceId: string, daysInput?: unknown) {
  const days = clampInt(daysInput, 1, 365, 7);
  const since = Date.now() - days * 86_400_000;
  const db = env.DB;

  const [totals, current, responseTimes, daily, topPages, usage, ratings] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS conversations,
                SUM(CASE WHEN handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS handoffs,
                SUM(CASE WHEN status = 'closed' AND handoff_at IS NULL THEN 1 ELSE 0 END) AS bot_resolved,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
                SUM(message_count) AS messages
         FROM conversations WHERE workspace_id = ? AND created_at >= ?`,
      )
      .bind(workspaceId, since)
      .first<{ conversations: number; handoffs: number | null; bot_resolved: number | null; closed: number | null; messages: number | null }>(),
    db
      .prepare(
        `SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'open' AND mode = 'human' AND assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
                SUM(CASE WHEN status = 'open' AND mode = 'human' AND first_response_at IS NULL THEN 1 ELSE 0 END) AS awaiting_first_reply
         FROM conversations WHERE workspace_id = ?`,
      )
      .bind(workspaceId)
      .first<{ open: number | null; unassigned: number | null; awaiting_first_reply: number | null }>(),
    db
      .prepare(
        `SELECT AVG(first_response_at - handoff_at) AS avg_first_response_ms,
                AVG(CASE WHEN closed_at IS NOT NULL THEN closed_at - created_at END) AS avg_resolution_ms
         FROM conversations WHERE workspace_id = ? AND created_at >= ? AND handoff_at IS NOT NULL AND first_response_at IS NOT NULL`,
      )
      .bind(workspaceId, since)
      .first<{ avg_first_response_ms: number | null; avg_resolution_ms: number | null }>(),
    db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
                COUNT(*) AS conversations,
                SUM(CASE WHEN handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS handoffs
         FROM conversations WHERE workspace_id = ? AND created_at >= ? GROUP BY day ORDER BY day`,
      )
      .bind(workspaceId, since)
      .all<{ day: string; conversations: number; handoffs: number }>(),
    db
      .prepare(
        `SELECT page_url, COUNT(*) AS conversations FROM conversations
         WHERE workspace_id = ? AND created_at >= ? AND page_url IS NOT NULL
         GROUP BY page_url ORDER BY conversations DESC LIMIT 10`,
      )
      .bind(workspaceId, since)
      .all<{ page_url: string; conversations: number }>(),
    db
      .prepare(
        `SELECT provider, model, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
         FROM usage_daily WHERE workspace_id = ? AND day >= ? GROUP BY provider, model ORDER BY requests DESC`,
      )
      .bind(workspaceId, new Date(since).toISOString().slice(0, 10))
      .all<{ provider: string; model: string; requests: number; input_tokens: number; output_tokens: number }>(),
    db
      .prepare(`SELECT AVG(rating) AS avg_rating, COUNT(rating) AS rated FROM conversations WHERE workspace_id = ? AND created_at >= ? AND rating IS NOT NULL`)
      .bind(workspaceId, since)
      .first<{ avg_rating: number | null; rated: number }>(),
  ]);

  const conversations = totals?.conversations || 0;
  const handoffs = totals?.handoffs || 0;
  const minutes = (ms: number | null | undefined) => (ms ? Math.round((ms / 60000) * 10) / 10 : null);
  return {
    period_days: days,
    conversations,
    messages: totals?.messages || 0,
    handoffs,
    handoff_rate: conversations ? Math.round((handoffs / conversations) * 1000) / 10 : 0,
    closed: totals?.closed || 0,
    bot_resolved: totals?.bot_resolved || 0,
    bot_resolution_rate: conversations ? Math.round(((totals?.bot_resolved || 0) / conversations) * 1000) / 10 : 0,
    open_now: current?.open || 0,
    unassigned_now: current?.unassigned || 0,
    awaiting_first_reply_now: current?.awaiting_first_reply || 0,
    avg_first_response_minutes: minutes(responseTimes?.avg_first_response_ms),
    avg_resolution_minutes: minutes(responseTimes?.avg_resolution_ms),
    csat_avg: ratings?.avg_rating ? Math.round(ratings.avg_rating * 100) / 100 : null,
    csat_responses: ratings?.rated || 0,
    daily: daily.results,
    top_pages: topPages.results,
    ai_usage: usage.results,
  };
}
