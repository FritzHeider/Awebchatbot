# Prompt 1 / 8 — Worker foundation

Read `MASTER_PROMPT.md` first; it is the contract for everything below.

## Task

Create the Cloudflare Worker skeleton in `worker/`:

1. `package.json`: dependency `hono`. Dev dependencies: `wrangler@^4`, `@cloudflare/workers-types` (the major
   version must satisfy wrangler's peer dependency), `typescript`, `vitest`. Scripts: `dev`, `dev:offline`,
   `deploy`, `typecheck`, `test`, `db:migrate:local`, `db:migrate`, `tail`.
2. `tsconfig.json`: strict, bundler resolution, workers types, `noImplicitOverride`.
3. `wrangler.toml` with these bindings:
   - DB (D1 `awebchatbot`, migrations dir), CACHE (KV), FILES (R2 `awebchatbot-files`), VECTORIZE (`awebchatbot-kb`)
   - AI, CRAWL_QUEUE producer and consumer (batch 5, retries 3, DLQ `awebchatbot-crawl-dlq`)
   - ROOMS Durable Object `Room` (sqlite migration v1), ANALYTICS (Analytics Engine)
   - RATE_LIMITER (`[[ratelimits]]`, 20 per 60 s), ASSETS (`./public`), crons `*/15 * * * *` and `0 9 * * *`
   - vars: PUBLIC_BASE_URL, DEFAULT_PROVIDER, FALLBACK_PROVIDERS, the model per provider, EMBEDDING_MODEL,
     CF_ACCOUNT_ID, AI_GATEWAY_ID, AUTO_CLOSE_HOURS, MAX_CRAWL_PAGES
4. `.dev.vars.example` listing every secret with a comment. Required: ADMIN_TOKEN and SIGNING_SECRET. Optional:
   ANTHROPIC/GEMINI/XAI/OPENAI keys, AI_GATEWAY_TOKEN, CF_API_TOKEN, TURNSTILE_SECRET, SUPABASE_URL,
   SUPABASE_SERVICE_KEY, RESEND_API_KEY, RESEND_FROM, ALERT_EMAIL.
5. `migrations/0001_init.sql`: every table, index and FTS5 virtual table from the master data model.
6. `src/env.ts`: the `Env` interface (optional bindings typed optional), `WorkspaceSettings` with every key in
   `docs/API.md`, row types, `AuthContext`, `AppEnv`.
7. `src/util.ts`:
   - prefixed random ids (`ws_`, `conv_`, …)
   - `parseJson`, `truncate`, `normalizeDomain`, `toRootUrl`, `isEmail`, `isPhone`, `clampInt`, `chunkArray`
   - `escapeHtml`, `HttpError`, `baseUrl`
8. `src/auth.ts`:
   - HMAC helpers, SHA-256 hex, `randomToken`, constant-time compare, `sanitizeVisitorId`
   - visitor token sign/verify, bearer parsing
   - `authenticateAdmin` (owner token or agent hash lookup), `assertWorkspaceAccess`, `assertAdmin`
9. `src/workspaces.ts`:
   - `defaultSettings(name)` and `mergeSettings` (type-checked keys and clamps)
   - row mapping; `getWorkspace` and `getWorkspaceByKey`, with a 60 s KV cache
   - `createWorkspace` (domain normalisation; origins https://domain and https://www.domain)
   - `updateWorkspace`, `originAllowed`, `publicConfig`

## Acceptance

- `npx tsc --noEmit` passes. That needs a stub `src/index.ts` exporting a Hono app and the `Room` class. Prompt 5
  replaces both.
- `npx wrangler d1 migrations apply awebchatbot --local` applies cleanly.
