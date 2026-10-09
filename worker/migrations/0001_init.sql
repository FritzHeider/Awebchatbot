-- AWebChatbot schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_domain ON workspaces(domain);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'agent',          -- admin | agent
  workspace_ids TEXT NOT NULL DEFAULT '[]',    -- empty = all workspaces
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (workspace_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS idx_customers_ws_email ON customers(workspace_id, email);
CREATE INDEX IF NOT EXISTS idx_customers_ws_seen ON customers(workspace_id, last_seen_at);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',          -- open | closed
  mode TEXT NOT NULL DEFAULT 'bot',             -- flow | bot | human
  assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  subject TEXT,
  page_url TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL,
  last_message_preview TEXT,
  handoff_at INTEGER,
  first_response_at INTEGER,
  rating INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conv_ws_status ON conversations(workspace_id, status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_conv_ws_assignee ON conversations(workspace_id, assignee_id);
CREATE INDEX IF NOT EXISTS idx_conv_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conv_ws_created ON conversations(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,                           -- visitor | bot | agent | system
  author_id TEXT,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  buttons TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  workspace_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  source TEXT NOT NULL DEFAULT 'crawl',         -- crawl | manual
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | indexed | error
  chunk_count INTEGER NOT NULL DEFAULT 0,
  vector_indexed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, url)
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_ws ON kb_documents(workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  content,
  title,
  chunk_id UNINDEXED,
  workspace_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',       -- running | done | failed
  max_pages INTEGER NOT NULL,
  pages_queued INTEGER NOT NULL DEFAULT 0,
  pages_done INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crawl_ws ON crawl_jobs(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | active | inactive
  start_step_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenarios_ws ON scenarios(workspace_id, status);

CREATE TABLE IF NOT EXISTS scenario_steps (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                           -- message | question | buttons | collect_email | ai | handoff
  content TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_scenario ON scenario_steps(scenario_id, position);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                           -- slack | discord | generic
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["handoff","conversation.created"]',
  secret TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, provider, model)
);
