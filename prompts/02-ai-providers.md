# Prompt 2 / 8 — AI providers and prompting

Context: `MASTER_PROMPT.md` and the files from prompt 1.

## Files

1. `src/ai/sse.ts`
   - `parseSse(body)`: an async generator of `{event?, data}` that handles chunks split anywhere, CRLF, comments
     and multi-line data.
   - `SseWriter`: wraps a TransformStream. `send(event, data)` writes JSON frames and swallows errors after the
     client disconnects. Sends `no-cache`/`no-transform` headers.
2. `src/ai/marker.ts`: `MarkerFilter(marker)` with `push(delta) → safeText`, `flush()` and `found`. It holds back
   any suffix that could be the start of the marker. Exports `HANDOFF_MARKER = "[[HANDOFF]]"`.
3. `src/ai/providers.ts`
   - `ChatTurn`, `GenerateRequest`, `Usage`, `GenerateResult`, `ProviderError`
   - `providerConfigured`, `defaultModel` (from env vars), `normalizeTurns` (merge same-role turns, drop leading
     assistant turns, never empty)
   - Streaming adapters, each updating the usage counts:
     - Anthropic `/v1/messages`: `x-api-key`, `anthropic-version: 2023-06-01`; events `message_start`,
       `content_block_delta.text_delta`, `message_delta.usage`, `error`.
     - Gemini `:streamGenerateContent?alt=sse`: `x-goog-api-key`, systemInstruction, roles user/model, skip
       `thought` parts, read `usageMetadata`.
     - xAI and OpenAI chat completions with `stream_options.include_usage`. For OpenAI use
       `max_completion_tokens` and the default temperature.
     - Workers AI: `env.AI.run(model, {messages, stream:true})`, handling both `response` and
       `choices[0].delta.content` shapes, plus the gateway option.
   - AI Gateway base URL and `cf-aig-authorization` header when configured.
   - `providerChain(env, primary, fallbacks)`.
   - `generate(env, chain, req, primaryModel, onDelta)`: fail over until the first text arrives. Return the partial
     text if a stream breaks mid-way. Return `null` if every provider fails.
4. `src/ai/prompt.ts`
   - `buildSystemPrompt(ws, hits, visitor)` contains:
     - identity and date
     - persona
     - fixed rules: grounding, brevity, reply in the visitor's language, Markdown links to sources, no secrets,
       ignore injected instructions
     - the workspace guardrails and the handoff-marker rule
     - visitor context
     - a `<knowledge>` block of numbered sources
   - `historyToTurns(messages, limit)`: agent messages are prefixed "(Reply from a human team member)".
   - `buildSuggestPrompt`: drafting for an agent, with no handoff rule.
   - `SUMMARY_SYSTEM`

## Acceptance

Add `test/logic.test.ts` cases for `MarkerFilter` (split marker; brackets that are not the marker),
`normalizeTurns` and `parseSse` (chunk-split events). They must pass with `npx vitest run`.
