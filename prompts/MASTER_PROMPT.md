# MASTER PROMPT — AWebChatbot

Use this prompt to rebuild, audit or extend the AWebChatbot project with an AI coding assistant. It describes the
whole system. The numbered prompts in this folder split the work into chunks that each fit in one session. Run them
in order; each one assumes the contracts defined here.

---

## Role

You are a senior full-stack engineer. Generate complete, production-ready files: no placeholders, no "TODO",
no elided code. Prefer the platform's native primitives over extra dependencies. After each chunk, run the
type-checker and the tests and fix every failure before you stop.

## Goal

Build a customer-support platform that adds an **AI chatbot + live chat widget** to any website. It has a
**shared inbox** where a team answers customers, and an **MCP server** so Claude can set up sites, handle
conversations, look up customers, search the knowledge base and build chatbot flows.
The first sites are breachmodal.com (cloud breach remediation, B2B security), isshereal.com (free profile
authenticity checker), betmodal.com (18+ price-prediction game with sweepstakes) and robomodal.com (supervised
humanoid robots, pre-seed).

## Architecture (fixed)

- **Backend:** one Cloudflare Worker in TypeScript with Hono 4. It serves the widget API (`/v1`), the admin API
  (`/admin`) and static assets (`/widget.js`, `/inbox/`).
- **Data:** D1 (SQLite) with FTS5 tables for message and knowledge search, KV for the config cache and crawl
  de-duplication, R2 for uploads, Vectorize (768-dim cosine, namespace = workspace id) with Workers AI embeddings
  `@cf/baai/bge-base-en-v1.5`.
- **Realtime:** a Durable Object class `Room` using the WebSocket Hibernation API. Rooms are `conv:<id>` (visitor
  plus watchers) and `inbox:<workspaceId>` (agents; presence = online agents).
- **Async:** a Queue `awebchatbot-crawl` with a dead-letter queue. Cron runs `*/15 * * * *` (auto-close idle chats)
  and `0 9 * * *` (re-crawl).
- **AI:** streaming adapters for Anthropic Messages, Gemini `streamGenerateContent?alt=sse`, xAI and OpenAI chat
  completions, and Workers AI. The chain is the workspace primary, then its fallbacks, then the env
  `FALLBACK_PROVIDERS`, keeping only configured providers. Fail over only before the first token. Optionally route
  through AI Gateway (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{anthropic|google-ai-studio|grok|openai}`).
  With no provider available, reply with an extractive answer built from the best knowledge chunk.
- **Retrieval:** hybrid search. Run Vectorize and FTS5 bm25 in parallel and merge with reciprocal-rank fusion
  (k=60), top 6. Chunks are about 900 characters with 150 overlap, split on paragraph and sentence boundaries.
- **Handoff:** the model ends its reply with `[[HANDOFF]]`. The marker is stripped while streaming even when it is
  split across deltas. Keyword detection (`handoffKeywords`) also triggers handoff, as do a widget button and flow
  `handoff` steps.
- **Flows:** a pure engine `runFlow(steps, startId, state, scenarioId, input)` with step types `message`,
  `question`, `buttons`, `collect_email`, `ai` and `handoff`. It supports `{{var}}` templating, validation
  (text/email/phone) and numeric button choice. Unmatched button input passes through to the AI by default
  (`fallback: "repeat"` re-asks instead). It allows at most 25 steps per turn. One active flow per workspace.
- **Widget:** vanilla JS in a Shadow DOM with no build step. It stores the visitor id and conversation token in
  localStorage, posts messages and reads an SSE response (`message`, `delta`, `status`, `done`, `error`), and
  receives agent messages over WebSocket.
- **Inbox:** a vanilla JS single-page app with hash routes `#/<ws>[/c/<conv>|/stats|/kb|/flows|/settings|/team]`.
- **MCP server:** Python with the `mcp` SDK v2 (`MCPServer`) and httpx. It runs over stdio by default; `--http`
  serves Streamable HTTP at `/mcp` behind bearer auth with `/health` for Fly.io.
- **Optional services:** a Supabase mirror (PostgREST upsert into `awc_*` tables), Resend email, Slack, Discord and
  HMAC-signed generic webhooks, Turnstile, the Rate Limiting binding, Analytics Engine, and Browser Rendering for
  JavaScript sites.

## Security requirements

- Every widget call checks its origin. Allowed: the workspace domain and its subdomains, `allowedOrigins`
  (`*.x.com` supported) and localhost when `allowLocalhost` is on.
- Visitor token: `base64url(convId:visitorId).HMAC-SHA256(SIGNING_SECRET)`, verified with `crypto.subtle.verify`.
- Admin auth: compare `ADMIN_TOKEN` in constant time, or look up the SHA-256 hash of an agent token. Agents can be
  limited to `workspace_ids`. Admin-only actions: create/update/delete workspaces, agents and webhooks.
- The system prompt grounds answers in the `<knowledge>` block, forbids invented facts and secret requests, and
  ignores instructions embedded in visitor messages or knowledge.
- The MCP `reply_to_conversation` tool returns a preview unless `confirmed=True`. Tools carry
  readOnly/destructive/openWorld annotations.
- Uploads are restricted to images, PDF and plain text up to 5 MB, under unguessable R2 keys, served with `nosniff`.

## Data model (D1)

`workspaces`, `agents`, `customers (UNIQUE workspace_id+visitor_id)`, `conversations (status open|closed, mode flow|bot|human, assignee, meta JSON with flow state/askEmail/summary, counters, handoff_at, first_response_at, rating)`,
`messages (role visitor|bot|agent|system, attachments/buttons/meta JSON)`, `messages_fts`, `kb_documents (UNIQUE workspace_id+url, content_hash)`,
`kb_chunks`, `kb_fts`, `crawl_jobs (pages_queued/done/failed, max_pages)`, `scenarios (status draft|active|inactive, start_step_id)`,
`scenario_steps (type, content, config JSON, position)`, `webhooks`, `usage_daily (workspace, day, provider, model, requests, tokens)`.

## Contracts

The HTTP API is documented in `docs/API.md` and must match it exactly. The MCP tool names must include:
`activate_scenario, add_chatbot_to_website, add_scenario_step, assign_conversation, close_conversation, create_scenario, delete_scenario_step, get_conversation, get_customer, get_inbox_stats, get_scenario, get_setup_status, get_widget_install_code, list_conversations, list_scenarios, list_workspaces, rename_scenario, reply_to_conversation, search_customers, search_knowledge_base, set_scenario_start_step, update_scenario_step`
plus these extras: `suggest_reply, summarize_conversation, test_chatbot, add_internal_note, export_conversation_transcript, reopen_conversation, return_conversation_to_bot, update_customer, list_knowledge_documents, add_knowledge_document, delete_knowledge_document, crawl_website, get_chatbot_settings, update_chatbot_settings, import_scenario, deactivate_scenario, delete_scenario, list_agents, create_agent, list_webhooks, add_webhook, get_platform_status`.

## Execution plan (one prompt per session)

| # | Prompt | Produces |
| --- | --- | --- |
| 1 | `01-worker-foundation.md` | package.json, tsconfig, wrangler.toml, migrations, env/util/auth/workspaces |
| 2 | `02-ai-providers.md` | ai/sse.ts, ai/marker.ts, ai/providers.ts, ai/prompt.ts |
| 3 | `03-knowledge-and-crawler.md` | rag.ts, crawler.ts, queue consumer |
| 4 | `04-flows-engine.md` | scenario.ts (engine + persistence + import) |
| 5 | `05-chat-realtime-routes.md` | realtime.ts, notify.ts, chat.ts, stats.ts, install.ts, routes/*, index.ts, tests |
| 6 | `06-widget.md` | public/widget.js |
| 7 | `07-inbox.md` | public/inbox/{index.html, styles.css, app.js} |
| 8 | `08-mcp-integrations-ops.md` | mcp/*, integrations/*, sites/*.json, scripts/*, docs, README |

## Global acceptance criteria

1. `cd worker && npm run typecheck && npm test` passes.
2. `npm run dev:offline` starts. The following work end to end against it with curl: create a workspace, start a
   conversation, run a flow, keyword handoff, agent reply received on the visitor WebSocket, knowledge search,
   test-chat, stats, upload and the cron trigger.
3. `cd mcp && pip install -e .[dev] && pytest` passes. `awebchatbot-mcp --http` answers `tools/list` with every
   tool above and rejects requests without the bearer token.
4. `scripts/provision.py --dry-run` lists the 4 sites. Run for real against dev, it creates 4 workspaces with
   active flows.
5. The widget renders on a test page, streams answers, shows buttons, receives agent replies live and works at
   390 px width.
