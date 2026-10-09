# Prompt 8 / 8 — MCP server, integrations, site presets, scripts, docs

Context: `MASTER_PROMPT.md` and the complete Worker from prompts 1–7.

## 1. MCP server (`mcp/`, Python ≥ 3.10, `mcp>=2.3,<3`, httpx, uvicorn)

- `client.py`: `AWebChatbotClient(base_url, token, transport=None)` reading `AWEBCHATBOT_URL` and
  `AWEBCHATBOT_TOKEN`. It drops empty params, raises `AWebChatbotError(status, message)`, and has `seg()` for path
  encoding.
- `server.py`
  - `MCPServer("awebchatbot", instructions=…)` with every tool listed in the master prompt.
  - Docstrings explain the arguments. Annotations: READ, WRITE, CUSTOMER_FACING (openWorld) and DESTRUCTIVE.
  - `reply_to_conversation` returns a preview unless `confirmed=True`.
  - `get_client()`/`set_client()` for test injection.
  - Prompts: `triage_inbox`, `improve_chatbot`, `setup_website`.
- `__main__.py`
  - stdio by default.
  - `--http` serves `mcp.streamable_http_app(host="0.0.0.0", stateless_http=True)` wrapped in an ASGI
    bearer-auth middleware. It requires `MCP_AUTH_TOKEN` of 24+ characters, and `/health` stays open.
- `pyproject.toml` (script `awebchatbot-mcp`), `Dockerfile` (non-root user, healthcheck), `fly.toml` (auto-stop,
  `/health` check), `.dockerignore`, `README.md` (Claude Desktop, Claude Code, Fly).
- `tests/test_server.py` uses `httpx.MockTransport` and covers:
  - every tool registered, with a description and annotations
  - output shaping, the confirmation gate, param filtering, step config building
  - error mapping, path encoding (check `raw_path`), the middleware
  - an optional live round-trip when `AWEBCHATBOT_LIVE_URL` is set

## 2. Integrations (`integrations/`)

- `cloudflare-injector/`: a Worker that adds the script before `</body>` with HTMLRewriter (`EndTag.before`). It
  skips non-HTML responses, excluded paths and pages that already contain the widget. It has `[env.<site>]` blocks
  for the 4 sites.
- `wordpress/awebchatbot/awebchatbot.php`: a settings page (URL, key, identify users, hide for admins),
  `wp_footer` injection and logged-in user identify.
- `shopify/awebchatbot.liquid` (customer and cart identify), `nextjs/ChatWidget.tsx` (next/script, env vars,
  typed `window.AWebChatbot`), `react/ChatWidget.tsx`, `nuxt/awebchatbot.client.ts` (provides `$chat`),
  `html/snippet.html`.
- `supabase/migrations/0001_awebchatbot_mirror.sql`:
  - `awc_customers`, `awc_conversations`, `awc_messages` (with a GIN full-text index)
  - a synced_at trigger and RLS enabled
  - views `awc_daily_stats` and `awc_leads`, and function `awc_search_messages(q, ws)`

## 3. Site presets (`sites/*.json`)

Write one preset for each of breachmodal, isshereal, betmodal and robomodal. Each contains:
- `url`, `name`, `maxPages`
- settings: botName, brandColor, theme, launcherText, greeting, quickReplies, persona (only facts published on the
  site), guardrails, disclaimer, handoffKeywords, temperature, maxTokens
- an active `flow` definition, and seed `knowledge`

Required guardrails:
- BreachModal: no exploit help; active incidents escalate to a human.
- IsSheReal: scores are signals, not proof; no doxxing or stalking; scam-victim guidance.
- BetModal: 18+ only, no guaranteed winnings or trading advice, no purchase necessary, responsible-play support
  (ncpgambling.org).
- Robomodal: all figures are forward-looking targets; no investment advice; investor and venue leads go to a human.

## 4. Scripts

- `scripts/bootstrap.sh`:
  - `set -euo pipefail`; npm install, then check `wrangler whoami`.
  - Create D1, KV, R2, Vectorize (768/cosine) and the queues, idempotently. Read the ids back with
    `d1 list --json` and `kv namespace list`, and write them into `wrangler.toml` along with the account id.
  - Generate ADMIN_TOKEN and SIGNING_SECRET into `.awebchatbot-secrets` (umask 077).
  - Ask for optional keys, or read them from the environment when `NONINTERACTIVE` is set.
  - Run the remote migrations, deploy, write PUBLIC_BASE_URL and redeploy.
- `scripts/provision.py` (standard library only):
  - Create workspaces from the presets, or update existing ones without duplicating flows.
  - Options: `--webhook`, `--no-crawl`, `--dry-run`.
  - Write `install/<site>.html`, and write the widget URL and keys into the injector's `[env.<site>]` blocks.
- `worker/scripts/offline-config.mjs`: generates a config without AI and Vectorize for `npm run dev:offline`.

## 5. Docs

`README.md` (architecture diagram, quick start, local dev, Claude setup, providers, Cloudflare feature table,
optional services, security, layout), `docs/API.md`, `docs/OPERATIONS.md`, `CLAUDE.md`, `.gitignore`, `Makefile`.

## Acceptance

- `pytest` passes; HTTP mode returns all tools and returns 401 without the token.
- `provision.py` run against `dev:offline` creates 4 workspaces with active flows, and fills the injector keys.
- `bash -n scripts/bootstrap.sh` passes.
