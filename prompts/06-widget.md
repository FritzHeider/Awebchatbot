# Prompt 6 / 8 — Embeddable chat widget

Context: `MASTER_PROMPT.md` and the `/v1` API in `docs/API.md`.

## File: `worker/public/widget.js` (ES5-compatible vanilla JS, no build step)

### Setup and storage
- Find its own `<script>` tag. Read `data-key`, and take `data-base` or the script's origin as the base URL.
- Guard against double loading.
- Keep the visitor id, conversation id and token in localStorage under `awc:<key>`, with an in-memory fallback.

### Rendering and theme
- Render inside a Shadow DOM so site CSS cannot leak in.
- Brand color from config, plus light, dark and auto themes (follows `prefers-color-scheme` live).
- Launcher (icon + optional text) with an unread badge.
- Panel 380×600, full screen under 480 px.
- Header: logo, bot name, status line ("AI assistant · team online", "Our team is here", "Team will reply soon"),
  a menu (Talk to a human, Email me the reply, Start a new conversation) and a close button.

### Messages
- Safe Markdown-lite rendering: escape first, then bold, italics, code, links with a URL allowlist, auto-links,
  bullet and numbered lists, quotes and headings.
- Bot messages show source chips. Images render inline; other attachments show as links.
- Button menus appear on the last bot message only; clicking one sends its label.
- Typing indicator dots.
- An inline email form appears when a message has `meta.askEmail`.
- Optional pre-chat name/email form (`collectEmailBeforeChat`); the input stays disabled until it is submitted.
- A star rating appears when the conversation closes.

### Sending and streaming
- Show the pending visitor bubble right away.
- `fetch` the POST and read the SSE stream manually:
  - `delta` updates a streaming bubble.
  - `message` upserts by id.
  - `status`, `done` and `error` update the UI.
- While a send is in flight, ignore bot messages arriving over the WebSocket (the SSE stream delivers them).

### WebSocket
- Ping every 25 s and reconnect with exponential backoff.
- Show agent typing.
- On a status event, update the mode, and show the rating when the conversation closes.
- An incoming agent message marks the team as online.

### Turnstile
When `turnstileSiteKey` is set, lazy-load the API, render with `interaction-only` in the light DOM, and pass the
token when the conversation starts.

### Public API
- `window.AWebChatbot`: `open`, `close`, `toggle`, `identify` (queued until a conversation exists), `sendMessage`,
  `reset`, `on`, `ready`.
- Dispatches `awebchatbot:<event>` window events.
- `?chat=open` in the URL opens the chat.
- Escape closes the panel; the controls have ARIA labels.

## Acceptance

Check with Playwright against `dev:offline` and a test page on another port:
- The launcher opens the chat, and the flow buttons render and work.
- Typing a question streams a reply.
- An agent reply sent through the admin API appears live.
- Take screenshots at 1200 px and 390 px.
- `node --check widget.js` passes.
