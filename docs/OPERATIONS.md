# Operations guide

## Day-to-day

- **Inbox:** `https://<worker>/inbox/`. "Needs human" shows handoffs, and a red dot marks chats still waiting for a
  first reply. Keep the tab open to appear online. Visitors are then told a teammate will reply; when no agent is
  online, the bot asks for their email instead.
- **AI draft:** the ✨ button writes a reply grounded in the knowledge base. Edit it, then send.
- **Internal notes:** tick "Internal note". Notes never reach the visitor.
- **Return to bot:** hands the chat back to the AI after you've resolved the human part.
- **Auto-close:** idle chats close after `autoCloseHours`, and the visitor is asked for a 1–5 rating.

## Improving answers

1. Stats → check the handoff rate and top pages.
2. Read recent handoffs. In Claude, the `improve_chatbot` prompt does this for you.
3. Knowledge → "Ask the bot a test question" to reproduce the gap.
4. Add a manual document (FAQ answer or policy), or fix the page and re-crawl.
5. Settings → persona and guardrails for tone and rules.

## Model choice and cost

- Default: `claude-haiku-5-5`, which is fast and cheap. For complex B2B questions (BreachModal), set
  `model = claude-sonnet-5-5` on that site only.
- `maxTokens` caps reply length and cost. 600–800 suits chat.
- Fallbacks keep the bot up through a provider outage. Order them by cost or quality.
- Each request sends at most about 6 knowledge chunks and the last 20 messages.
- With AI Gateway enabled, turn on caching for repeated FAQ answers and set spend limits there.
- Token usage per site and provider is under Stats → AI usage (`usage_daily` table).

## Crawling

- A crawl seeds from robots.txt sitemaps, `/sitemap.xml`, `/sitemap_index.xml` and the root page, then follows
  same-site links up to depth 3. It skips login, cart and admin paths, assets, and pages marked `noindex`.
- Unchanged pages are skipped by content hash, so re-crawls are cheap.
- For single-page apps whose HTML is empty without JavaScript, enable **Render JavaScript** and set `CF_API_TOKEN`
  (Browser Rendering permission) and `CF_ACCOUNT_ID`.
- The budget is `MAX_CRAWL_PAGES` (wrangler var) or the `maxPages` value per crawl.

## Monitoring

- `npx wrangler tail` streams live logs. Observability is enabled in `wrangler.toml`.
- `/health` returns `{ok: true}`.
- Queue failures retry 3 times, then go to `awebchatbot-crawl-dlq`.
- The Analytics Engine dataset `awebchatbot_events` records conversations, messages, handoffs and leads by
  workspace and provider. Query it with the SQL API.

## Backups and data

- D1: `npx wrangler d1 export awebchatbot --remote --output backup.sql`. Use Time Travel for point-in-time restore.
- The Supabase mirror (optional) keeps a continuous copy in Postgres.
- Deleting a workspace (`DELETE /admin/workspaces/:id`) removes its conversations, customers, knowledge and vectors.

## Rotating secrets

```bash
cd worker
python3 -c 'import secrets; print(secrets.token_urlsafe(36))' | npx wrangler secret put ADMIN_TOKEN
```

Rotating `SIGNING_SECRET` invalidates open widget sessions. Visitors simply start a new conversation.
Agent tokens: delete the agent and create it again.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Widget doesn't appear; console says "not allowed" | Add the site's origin under Settings → extra allowed origins |
| Bot answers "Here's what I found…" with quotes | No AI provider key is set or all providers failed. Check `/admin/providers` and `wrangler tail` |
| Answers ignore the site content | Check setup status. If the crawl failed, enable Render JavaScript or add a sitemap URL |
| "Bot check failed" | `turnstileSiteKey` is set but `TURNSTILE_SECRET` is missing or mismatched |
| Inbox shows "offline" | WebSocket blocked by a proxy. Check `/admin/ws` reachability |
| 429 errors | The rate limiter allows 20 messages a minute per conversation. Change `[[ratelimits]]` in `wrangler.toml` |
