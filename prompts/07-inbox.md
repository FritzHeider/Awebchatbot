# Prompt 7 / 8 — Shared inbox web app

Context: `MASTER_PROMPT.md` and the `/admin` API in `docs/API.md`.

## Files: `worker/public/inbox/index.html`, `styles.css`, `app.js` (vanilla JS, no build)

### General
- A safe DOM helper `h(tag, attrs, ...children)`. `append(el, ...children)` must accept several children and
  nested arrays. Never use innerHTML with user data, except through `esc`/`linkify`.
- Login with a token stored in localStorage. A 401 logs you out.
- Boot loads `/me`, `/workspaces` and `/agents`, and asks for notification permission.
- With no workspaces, show an "add your first website" form.
- Hash router `#/<ws>[/c/<conv>|/stats|/kb|/flows|/settings|/team]`. The last workspace is remembered.
- Top bar: workspace select, tabs, presence ("N agents online" or offline), user name, sign out.
- Inbox WebSocket `/admin/ws`:
  - Reconnect with backoff; ping every 25 s.
  - Handle `hello` and `presence`, `message` (update the list preview and the open thread), and
    `conversation.*` (reload).
  - Handle `customer.updated` and visitor `typing`.
  - On a handoff or a visitor message in human mode, play a beep and show a desktop notification.

### Inbox layout (3 columns, responsive)
- **Conversation list**
  - Search runs full-text search on Enter.
  - Filter chips: Open, Needs human, Unassigned, Mine, Closed, All.
  - Items show the name or email, a mode or closed pill, relative time, a preview and the assignee. A red dot marks
    chats awaiting a first reply.
- **Thread**
  - Header: back button (mobile), title, mode pill, online pill, assignee select, Assign to me (agents),
    Return to bot, Close or Reopen.
  - Message bubbles by role. Internal notes are yellow. Messages show sources, attachments, button pills and times.
  - Typing indicator.
  - Composer: Ctrl/⌘+Enter sends; the agent typing ping is throttled to once per 3 s.
  - "✨ AI draft" calls suggest-reply, and an "Internal note" toggle switches the composer to notes.
- **Side panel**
  - Customer key/value grid, each value in its own `<div>`, including attributes.
  - AI summary with a Summarize button, the customer's other conversations and a Copy transcript button.

### Other pages
- **Stats:** day-range select, KPI cards, an SVG daily bar chart (handoffs overlaid), and top-pages and AI-usage
  tables.
- **Knowledge**
  - Search shows titles, scores and snippets; a test-chat box shows the answer, provider and handoff flag.
  - Crawl form and history table.
  - Manual document form.
  - Documents table with semantic/keyword status and a delete button that asks for confirmation.
- **Flows:**
  - List of flows; create.
  - Editor: rename, publish/unpublish, delete, the problems list.
  - Step cards: start marker, Make start, editable content, link summary, advanced JSON config, save and delete.
  - Add-step form: type, link-after, text, button options, variable.
- **Settings:**
  - Every settings field, grouped: Appearance, AI, Human handoff & lifecycle, Website/crawling/security,
    allowed origins.
  - Install code with a platform picker, copy button and steps.
  - Webhooks: add, list, remove. A generic webhook shows its signing secret once.
- **Team:** invite agent (token shown once), agent list with remove, integrations status table.

### Styles
CSS variables for light and dark themes, compact layout, pills, cards, tables, and full-height app (`#app`
100%). Breakpoints: side panel hidden under 1100 px, single column under 760 px.

## Acceptance

Playwright: log in, filter All, open a conversation, send a reply (it appears in the visitor widget), and visit
every tab without page errors. `node --check app.js` passes.
