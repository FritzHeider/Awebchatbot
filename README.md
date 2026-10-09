# AWebChatbot

An AI chatbot, live chat widget and shared support inbox for your websites. It runs on Cloudflare and
connects to Claude so you can run support without switching apps.

Built for **breachmodal.com**, **isshereal.com**, **betmodal.com** and **robomodal.com**, but it works on any site.

```
 Visitor's browser                      Cloudflare (one Worker)                         You / your team
 ┌───────────────┐  HTTPS + SSE   ┌──────────────────────────────────────┐   WebSocket  ┌─────────────────┐
 │ widget.js     │───────────────▶│ /v1  widget API (Hono)               │◀────────────▶│ /inbox  web app │
 │ (Shadow DOM)  │◀── WebSocket ──│ Durable Object rooms (live chat)     │              └─────────────────┘
 └───────────────┘                │ D1 (SQL + FTS5)   KV (cache)          │   /admin API  ┌─────────────────┐
                                  │ Vectorize + Workers AI embeddings     │◀─────────────│ MCP server       │──▶ Claude
                                  │ Queues → crawler (HTMLRewriter /      │              │ (Python, stdio   │
                                  │          Browser Rendering)           │              │  or Fly.io HTTP) │
                                  │ R2 (attachments)  Analytics Engine    │              └─────────────────┘
                                  │ AI Gateway → Claude · Gemini · Grok · │
                                  │              OpenAI · Workers AI      │──▶ Slack / Discord / webhooks
                                  │ Turnstile · Rate limiting · Cron      │──▶ Resend email · Supabase mirror
                                  └──────────────────────────────────────┘
```

## What you get

| Piece | Where | What it does |
| --- | --- | --- |
| **Chat widget** | `worker/public/widget.js` | One `<script>` tag. Streams AI answers, shows source links, button menus, file uploads, live agent replies, email capture, ratings, dark mode, mobile full screen, `window.AWebChatbot` JS API. |
| **AI chatbot** | `worker/src/chat.ts`, `ai/`, `rag.ts` | Answers from your crawled pages (hybrid Vectorize + D1 full-text search). It uses Claude by default and fails over automatically to Gemini, Grok (xAI), OpenAI or Workers AI. It hands off to a human on request, on frustration or when it can't answer. |
| **Chatbot flows** | `worker/src/scenario.ts` | Welcome messages, questions, button menus, email capture, AI answers and human handoff, with `{{variables}}`. Publish one flow per site. |
| **Live chat + inbox** | `worker/public/inbox/` | A shared inbox for your team. Filter by open, needs human, unassigned, mine or closed, with full-text search, live updates, typing indicators and desktop notifications. It also has AI draft replies, AI summaries, internal notes, assignment, close/reopen, customer profiles, stats, knowledge base, flow editor, settings, install code and team management. |
| **Crawler** | `worker/src/crawler.ts` | Reads robots.txt sitemaps, sitemap indexes and links, and extracts clean text with HTMLRewriter. It can use Cloudflare Browser Rendering for JavaScript sites and re-crawls daily. |
| **MCP server for Claude** | `mcp/` | 44 tools (the 22 from the project brief plus extras) and 3 prompts. Runs locally over stdio or on Fly.io over HTTP. |
| **Integrations** | `integrations/` | HTML, WordPress plugin, Shopify, Next.js, React, Nuxt, Cloudflare zero-code injector Worker, Zaraz, Google Tag Manager, Supabase mirror. |
| **Site presets** | `sites/*.json` | A persona, guardrails, flow and seed knowledge for each of your four sites. |
| **Prompts** | `prompts/` | A master prompt plus 8 sub-prompts for rebuilding or extending this project with an AI coding assistant. |

## Quick start (production)

Requirements: Node 20+, Python 3.10+, and a Cloudflare account. The Workers Paid plan ($5/mo) is needed for
Queues, Durable Objects and Vectorize at scale.

```bash
npx wrangler login
./scripts/bootstrap.sh
```

`bootstrap.sh` does the following:

1. Creates D1, KV, R2, Vectorize (768-dim cosine), the crawl Queue and its dead-letter queue.
2. Writes their IDs into `worker/wrangler.toml`.
3. Generates `ADMIN_TOKEN` and `SIGNING_SECRET`, saved in `.awebchatbot-secrets` (git-ignored).
4. Asks for optional keys: Anthropic, Gemini, xAI, OpenAI, Turnstile, Browser Rendering, AI Gateway, Supabase and Resend.
5. Migrates the database and deploys.

Then create the four chatbots:

```bash
export AWEBCHATBOT_URL=https://awebchatbot.<your-subdomain>.workers.dev
export AWEBCHATBOT_TOKEN=$(grep ADMIN_TOKEN .awebchatbot-secrets | cut -d= -f2)
python3 scripts/provision.py --webhook https://hooks.slack.com/services/XXX --webhook-kind slack
```

This creates a workspace per site. For each one it seeds knowledge, publishes the preset flow and starts a crawl.
It writes `install/<site>.html` and fills the widget keys into `integrations/cloudflare-injector/wrangler.toml`.

Install the widget on each site in one of three ways:

- **Cloudflare-hosted sites, no code change:** `cd integrations/cloudflare-injector && npm i && npx wrangler deploy --env robomodal`
  (once per site). Alternatively, use Zaraz with a Custom HTML tool and paste the snippet.
- **Any site:** paste the snippet from `install/<site>.html` before `</body>`.
- **Frameworks:** see `integrations/` or ask Claude to run `get_widget_install_code` with `platform=nextjs|react|nuxt|wordpress|shopify|gtm`.

Open `https://<worker>/inbox/` and sign in with the admin token.

## Local development

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars        # set ADMIN_TOKEN, SIGNING_SECRET, optionally AI keys
npm run dev:offline                   # no Cloudflare login needed (no Workers AI / Vectorize)
# or: npx wrangler login && npm run db:migrate:local && npm run dev   (full bindings, remote AI)
npm test                              # 26 unit tests
npm run typecheck
```

Open `http://127.0.0.1:8787/inbox/`. To test the widget, create a workspace and add
`<script src="http://127.0.0.1:8787/widget.js" data-key="pk_..." async></script>` to any local page.
Localhost is allowed by default.

## Connect Claude (MCP)

See `mcp/README.md`. In short:

```bash
cd mcp && python3 -m venv .venv && . .venv/bin/activate && pip install -e .
claude mcp add awebchatbot -e AWEBCHATBOT_URL=$AWEBCHATBOT_URL -e AWEBCHATBOT_TOKEN=$AWEBCHATBOT_TOKEN -- $(pwd)/.venv/bin/awebchatbot-mcp
```

Or deploy it to Fly.io (`mcp/fly.toml`) and add `https://awebchatbot-mcp.fly.dev/mcp` as a remote connector with a bearer token.

Things you can then ask Claude:

- "Add my chatbot to isshereal.com and give me the Next.js install code."
- "Show me open conversations that need a human on betmodal and draft replies." Replies are sent only after you confirm.
- "Which questions did the robomodal bot fail to answer this week? Add knowledge to fix them."
- "Build a flow for breachmodal: ask if they're in an active incident, collect email, hand off."

## AI providers

| Provider | Secret | Default model (change in `wrangler.toml` or per site) |
| --- | --- | --- |
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | `claude-haiku-5-5` (use `claude-sonnet-5-5` for harder support) |
| Gemini | `GEMINI_API_KEY` | `gemini-3.6-flash` |
| Grok (xAI) | `XAI_API_KEY` | `grok-4.6` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5-mini` |
| Workers AI | (binding, no key) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

Each site picks a primary provider and fallbacks (Settings → AI, or `update_chatbot_settings`). If a provider
errors before streaming, the next one answers. If none is configured, the bot replies with the best-matching
knowledge snippet and offers a human.

To route all model calls through **Cloudflare AI Gateway**, create a gateway in the dashboard and set
`CF_ACCOUNT_ID` and `AI_GATEWAY_ID` in `wrangler.toml`. If the gateway is authenticated, also set `AI_GATEWAY_TOKEN`.
The gateway adds caching, rate limiting, logs, cost analytics and provider fallbacks.

## Cloudflare features used

| Feature | Use |
| --- | --- |
| Workers + Static Assets | API, widget and inbox |
| D1 | All data. FTS5 provides message and knowledge search. |
| Durable Objects (WebSocket Hibernation) | Live chat rooms and inbox presence |
| Vectorize + Workers AI | Semantic retrieval (bge-base embeddings), plus an optional chat model |
| Queues + dead-letter queue | Crawling |
| Browser Rendering | Crawling JavaScript-heavy sites (`renderJs` setting plus `CF_API_TOKEN`) |
| R2 | Visitor and agent file uploads |
| KV | Workspace config cache and crawl de-duplication |
| AI Gateway | Model routing, caching and analytics |
| Turnstile | Optional invisible bot check before a chat starts |
| Rate Limiting binding | Per-conversation and per-IP message limits |
| Analytics Engine | Event analytics (conversations, handoffs, provider usage) |
| Cron Triggers | Auto-close idle chats every 15 minutes and re-crawl daily |
| Zaraz or an HTMLRewriter Worker | Zero-code widget install on Cloudflare-proxied sites |

## Optional services

- **Supabase:** run `integrations/supabase/migrations/0001_awebchatbot_mirror.sql`, then set `SUPABASE_URL` and
  `SUPABASE_SERVICE_KEY`. Conversations, messages and customers are upserted, which gives you SQL analytics, the
  `awc_daily_stats` and `awc_leads` views and `awc_search_messages()`.
- **Fly.io:** hosts the MCP server (`mcp/fly.toml`). The Next.js integration also deploys there unchanged.
- **Resend:** handoff alerts to `ALERT_EMAIL` or the per-site `alertEmail`, transcripts to customers, and agent
  replies by email when the visitor has left.
- **Slack and Discord:** add a webhook per site in Settings → Notifications, or use `add_webhook`. Generic
  webhooks are HMAC-SHA256 signed (`X-AWebChatbot-Signature`).

## Security notes

- Each widget key only works from its site's domain, its subdomains and any extra allowed origins.
- Visitor tokens are HMAC-signed and scoped to one conversation.
- Agent tokens are stored as SHA-256 hashes. Agents can be limited to specific workspaces, and only admins can
  create sites, agents and webhooks.
- `reply_to_conversation` in the MCP server needs `confirmed=True`, and tools that reach customers are annotated so
  Claude asks before using them.
- Every bot reply is grounded in the knowledge base. The system prompt forbids inventing facts or asking for secrets
  and resists instruction injection. Each site adds its own guardrails: no exploit help (BreachModal), anti-doxxing
  (IsSheReal), 18+ and responsible play (BetModal), forward-looking-figures disclaimers (Robomodal).

## Repository layout

```
worker/            Cloudflare Worker (TypeScript): API, AI, RAG, crawler, flows, realtime, cron
  public/widget.js       embeddable widget
  public/inbox/          shared inbox SPA
  migrations/            D1 schema
  test/                  vitest unit tests
mcp/               Python MCP server (stdio + Streamable HTTP), Dockerfile, fly.toml, tests
integrations/      cloudflare-injector, wordpress, shopify, nextjs, react, nuxt, html, supabase
sites/             presets for breachmodal, isshereal, betmodal, robomodal
scripts/           bootstrap.sh (Cloudflare setup + deploy), provision.py (create the sites' chatbots)
docs/              API reference and operations guide
prompts/           master prompt + sub-prompts to regenerate or extend the project
```
