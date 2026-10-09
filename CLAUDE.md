# AWebChatbot — notes for Claude

- Backend: `worker/` (Cloudflare Worker, TypeScript, Hono). Run `npm run typecheck && npm test` after every change.
- The widget (`worker/public/widget.js`) and inbox (`worker/public/inbox/app.js`) are hand-written ES5-style
  vanilla JS with no build step. Keep them dependency-free, and check them with `node --check`.
- Contracts: `docs/API.md` is the source of truth for every HTTP route. Update it in the same change as the code.
- MCP server: `mcp/` (Python, `mcp` SDK v2 `MCPServer`). Run `pytest` after changes. Never let a tool message a
  customer without `confirmed=True`.
- Local end-to-end: `cd worker && npm run dev:offline`, then use `scripts/provision.py` with
  `AWEBCHATBOT_URL=http://127.0.0.1:8787` and the ADMIN_TOKEN from `.dev.vars`.
- Site presets live in `sites/*.json`. Personas must only state facts published on each site.
- The rebuild plan is `prompts/MASTER_PROMPT.md` followed by the sub-prompts `01`–`08`.
