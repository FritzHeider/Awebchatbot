# Prompt 5 / 8 — Conversations, realtime, notifications, routes

Context: `MASTER_PROMPT.md`, prompts 1–4, and `docs/API.md` (must match exactly).

## Files

1. `src/realtime.ts`
   - `Room extends DurableObject`, using `ctx.acceptWebSocket(ws, [role, who])` and `serializeAttachment`.
   - `/connect`: send `hello` with presence. When an agent joins, broadcast `presence`.
   - `/broadcast?to=visitor|agent`: send the body to matching sockets.
   - `/presence`: return unique agents and the visitor count.
   - `webSocketMessage`: `ping` → `pong`; `typing` → relay to the other sockets.
   - When an agent socket closes, broadcast the new presence.
   - Helpers: `broadcast`, `presence`, `connectToRoom`.
2. `src/notify.ts`
   - `fireWebhooks`:
     - Slack sends `{text}` and Discord sends `{content}`.
     - Generic sends a JSON body with the `X-AWebChatbot-Signature: sha256=` HMAC.
     - Each hook only receives the events it subscribed to. Messages include an inbox deep link.
   - `sendEmail` via the Resend API, `transcriptHtml`, `alertTeamByEmail`.
   - `mirrorToSupabase(table, row)`: PostgREST upsert into `awc_<table>`.
   - `trackEvent`: Analytics Engine, safe when unbound.
   - `recordUsage`: an upsert into `usage_daily`.
3. `src/chat.ts`
   - `toPublicMessage`, `getConversation`, `getMessages`, `getCustomer`, `upsertCustomer`.
   - `updateCustomerContact`: validate the email; mirror; fire a `lead.captured` webhook on a new email.
   - `insertMessage`: one D1 batch (message, counters and preview, FTS row), then broadcast to `conv:` and
     `inbox:` and mirror.
   - `startConversation`:
     - Upsert the customer with cf country, city and locale.
     - Run the active flow, or post the greeting with the quick-reply buttons.
     - Broadcast, fire webhooks and mirror.
   - `handleVisitorMessage(env, waitUntil, ws, convId, {content, attachments}, sink{message, delta, status})`:
     - Reopen the conversation if it was closed, insert the message and set the subject.
     - If an email is pending (`askEmail`) and the message is an email, save it and thank the visitor.
     - In human mode, notify and return.
     - A handoff keyword hands off.
     - In flow mode, run the flow, apply the variables to the customer, and route by action/passthrough.
     - Otherwise call `answerWithAi`.
   - `wantsHuman(text, keywords)`: messages over 12 words count only on an explicit "talk to a human" pattern.
   - `answerWithAi`:
     - Build the RAG query from the last visitor message, plus the previous one when the last is short.
     - Build the system prompt and call `generate` with the `MarkerFilter`; use the extractive fallback when it
       returns null.
     - Save the message with meta `{provider, model, sources}` and record usage.
   - `handoff`:
     - Set mode `human` and `handoff_at`.
     - Use the online message when agents are present. Otherwise use the offline message and set
       `meta.askEmail` if the customer has no email.
     - Broadcast, fire webhooks, send an email alert and mirror.
   - `agentReply`:
     - Set `first_response_at` and `assignee` (both COALESCE) and clear `askEmail`.
     - Email the reply when no visitor socket is connected.
   - `assignConversation`, `closeConversation` (system message, rating prompt, optional transcript),
     `reopenConversation`.
   - `suggestReply`, `summarizeConversation` (saved in meta), `testChat`, `conversationTranscript`.
4. `src/stats.ts`: `inboxStats(env, ws, days)` as described in `docs/API.md`.
5. `src/install.ts`: `PLATFORMS` and `installCode(base, key, platform)` with a snippet and steps for html,
   wordpress, shopify, nextjs, react, nuxt, cloudflare (Zaraz, injector Worker, Pages) and gtm.
6. `src/routes/widget.ts`
   - Every `/v1` endpoint, with an origin check, the rate limiter (fails open when unbound) and Turnstile verify
     when a site key is set.
   - The messages POST returns `SseWriter.response` immediately and does the work in `waitUntil`.
   - Uploads go to R2 under `ws/conv/f_id-name` with a type and size allowlist; `/v1/files/*` serves them.
7. `src/routes/admin.ts`: every `/admin` endpoint. The `/admin/ws` WebSocket is registered before the auth
   middleware. Owner replies are signed "<Workspace> team".
8. `src/index.ts`:
   - CORS for `/v1` and `/admin`; `/health`; `/` redirects to `/inbox/`; the not-found handler falls back to ASSETS.
   - `onError` maps `HttpError`.
   - `queue()` caches `renderJs` per workspace and acks or retries with a 30 s delay.
   - `scheduled()` runs auto-close (per-workspace hours) or the daily re-crawl.
9. Tests:
   - `vitest.config.ts` aliases `cloudflare:workers` to a stub.
   - Tests cover `wantsHuman`, `originAllowed`, `mergeSettings` and `installCode` for every platform.

## Acceptance

`npm run typecheck && npm test` pass. Then the curl smoke test runs against `npm run dev:offline`:
workspace with flow → button → bad email → good email → handoff → second conversation → AI step → extractive
answer → "human please" → agent reply visible on the visitor WebSocket → search, stats, transcript, close, rate,
upload, cron.
