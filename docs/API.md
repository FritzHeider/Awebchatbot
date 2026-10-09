# AWebChatbot HTTP API

Base URL: your Worker, e.g. `https://awebchatbot.<subdomain>.workers.dev`.

## Widget API (`/v1`) — public, called from websites

Origins are checked against the workspace domain, its subdomains, `allowedOrigins` and (optionally) localhost.
Conversation endpoints require the visitor token returned when the conversation starts
(`Authorization: Bearer <token>`).

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/v1/config?key=pk_…` | | Public widget config + `agentsOnline` |
| POST | `/v1/conversations` | `{key, visitorId, pageUrl, referrer, locale, turnstileToken?}` | `{conversation, visitorId, token, messages}` — runs the active flow or posts the greeting |
| GET | `/v1/conversations/:id/messages?after=<ms>` | | `{conversation, messages}` |
| POST | `/v1/conversations/:id/messages` | `{content, attachments?}` | **Server-sent events**: `message` (full message objects), `delta` (`{text}` AI streaming), `status` (`{typing}`, `{mode}`), `done` (`{conversation}`), `error` (`{status, message}`) |
| POST | `/v1/conversations/:id/identify` | `{name?, email?, phone?, attributes?}` | `{ok, customer}` |
| POST | `/v1/conversations/:id/rate` | `{rating: 1-5}` | `{ok}` |
| POST | `/v1/conversations/:id/handoff` | | `{messages}` |
| POST | `/v1/conversations/:id/upload` | multipart `file` (image/pdf/txt ≤ 5 MB) | `{url, name, type, size}` |
| GET | `/v1/files/<key>` | | File from R2 |
| GET (WS) | `/v1/ws/:id?token=` | | Live events: `hello`, `message`, `typing`, `status` |

### Widget JavaScript API

```js
window.AWebChatbot.open();  .close();  .toggle();
window.AWebChatbot.identify({ name, email, phone, attributes: { plan: 'pro' } });
window.AWebChatbot.sendMessage('I need help with billing');
window.AWebChatbot.reset();                       // start a fresh conversation next time
window.AWebChatbot.on('message', (m) => {});      // also: ready, open, close, conversation
window.addEventListener('awebchatbot:ready', () => {});
```

Script tag attributes: `data-key` (required), `data-base` (override API origin). URL `?chat=open` opens the chat.

## Admin API (`/admin`) — `Authorization: Bearer <ADMIN_TOKEN or agent token>`

### Account
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/me` | Who am I |
| GET | `/admin/providers` | Integration status |
| GET (WS) | `/admin/ws?workspace=&token=` | Inbox live events: `hello`, `presence`, `message`, `conversation.created`, `conversation.handoff`, `conversation.updated`, `customer.updated`, `conversation.rated`, `typing` |

### Workspaces
| Method | Path | Body |
| --- | --- | --- |
| GET | `/admin/workspaces` | |
| POST | `/admin/workspaces` | `{url, name?, settings?, allowedOrigins?, crawl?=true, maxPages?, flow?, knowledge?[]}` (admin) |
| GET / PATCH / DELETE | `/admin/workspaces/:ws` | PATCH `{name?, settings?, allowedOrigins?}` |
| GET | `/admin/workspaces/:ws/setup-status` | |
| GET | `/admin/workspaces/:ws/install-code?platform=html\|wordpress\|shopify\|nextjs\|react\|nuxt\|cloudflare\|gtm` | |
| POST | `/admin/workspaces/:ws/test-chat` | `{question}` |
| GET | `/admin/workspaces/:ws/stats?days=7` | |

### Conversations
| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/admin/workspaces/:ws/conversations` | `status=open\|closed\|all`, `assignee=unassigned\|me\|<id>`, `mode=human\|bot\|flow`, `q`, `customer_id`, `limit`, `before` |
| GET | `/admin/conversations/:id` | |
| GET | `/admin/conversations/:id/transcript` | Markdown |
| POST | `/admin/conversations/:id/reply` | `{content, attachments?}` |
| POST | `/admin/conversations/:id/note` | `{content}` (internal) |
| POST | `/admin/conversations/:id/assign` | `{agent_id}` or `{me: true}` |
| POST | `/admin/conversations/:id/close` · `/reopen` · `/return-to-bot` · `/typing` | |
| POST | `/admin/conversations/:id/suggest-reply` | `{instructions?}` |
| POST | `/admin/conversations/:id/summarize` | |

### Customers
| Method | Path |
| --- | --- |
| GET | `/admin/workspaces/:ws/customers?q=&limit=` |
| GET / PATCH | `/admin/customers/:id` |

### Knowledge base
| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/admin/workspaces/:ws/kb/search?q=&limit=` | |
| GET | `/admin/workspaces/:ws/kb/documents?limit=&offset=` | |
| POST | `/admin/workspaces/:ws/kb/documents` | `{title, content, url?}` |
| DELETE | `/admin/workspaces/:ws/kb/documents/:doc` | |
| POST / GET | `/admin/workspaces/:ws/crawl` | `{url?, maxPages?, maxDepth?}` |

### Flows (scenarios)
| Method | Path | Body |
| --- | --- | --- |
| GET / POST | `/admin/workspaces/:ws/scenarios` | POST `{name}` or `{definition: {name, start, activate?, steps:[{key,type,content,next,variable,validation,fallback,options:[{label,value,next}]}]}}` |
| GET / PATCH / DELETE | `/admin/workspaces/:ws/scenarios/:sc` | PATCH `{name}`; GET also returns `problems` |
| POST | `/admin/workspaces/:ws/scenarios/:sc/steps` | `{type, content, config, previous_step_id?}` |
| PATCH / DELETE | `/admin/workspaces/:ws/scenarios/:sc/steps/:step` | `{type?, content?, config?}` |
| POST | `/admin/workspaces/:ws/scenarios/:sc/start` | `{step_id}` |
| POST | `/admin/workspaces/:ws/scenarios/:sc/activate` · `/deactivate` | |

Step types: `message`, `question`, `buttons`, `collect_email`, `ai`, `handoff`.
Config: `next_step_id`, `options[{label, value?, next_step_id?}]`, `variable`, `validation (text|email|phone)`,
`error_message`, `fallback (ai|repeat)` for unmatched button input. Variables `name`, `email`, `phone` update the
customer record; others are stored as customer attributes.

### Team & webhooks
| Method | Path | Body |
| --- | --- | --- |
| GET / POST | `/admin/agents` | POST `{name, email, role: agent\|admin, workspace_ids?}` → returns token once |
| DELETE | `/admin/agents/:id` | |
| GET / POST | `/admin/workspaces/:ws/webhooks` | POST `{kind: slack\|discord\|generic, url, events?}` |
| DELETE | `/admin/workspaces/:ws/webhooks/:id` | |

Webhook events: `conversation.created`, `handoff`, `message.visitor`, `conversation.closed`, `lead.captured`.
Generic webhooks send JSON with header `X-AWebChatbot-Signature: sha256=<hex HMAC of body with signing secret>`.

## Workspace settings reference

| Key | Type | Default |
| --- | --- | --- |
| botName, greeting, placeholder, launcherText, logoUrl, disclaimer | string | sensible defaults |
| brandColor | hex | `#4f46e5` |
| position | right \| left | right |
| theme | auto \| light \| dark | auto |
| quickReplies | string[] | [] |
| persona | string | "" — facts + tone injected into every prompt |
| guardrails | string[] | [] — extra rules |
| provider | anthropic \| gemini \| xai \| openai \| workers-ai | anthropic |
| model | string | "" (provider default) |
| fallbacks | provider[] | gemini, xai, workers-ai |
| temperature | 0–1 | 0.3 |
| maxTokens | 100–4000 | 700 |
| handoffEnabled | bool | true |
| handoffKeywords | string[] | human, agent, … |
| handoffMessage, offlineMessage | string | |
| alertEmail | string | "" |
| autoCloseHours | 1–720 | 24 |
| emailTranscripts, collectEmailBeforeChat, showSources | bool | false, false, true |
| turnstileSiteKey | string | "" |
| renderJs, recrawlDaily, allowLocalhost | bool | false, true, true |
| sitemapUrl | string | "" |
