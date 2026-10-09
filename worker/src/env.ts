import type { Room } from './realtime';

export interface Env {
  // Bindings
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  CRAWL_QUEUE: Queue<CrawlMessage>;
  ROOMS: DurableObjectNamespace<Room>;
  ANALYTICS?: AnalyticsEngineDataset;
  RATE_LIMITER?: RateLimit;
  ASSETS: Fetcher;

  // Vars
  PUBLIC_BASE_URL?: string;
  DEFAULT_PROVIDER?: string;
  FALLBACK_PROVIDERS?: string;
  ANTHROPIC_MODEL?: string;
  GEMINI_MODEL?: string;
  XAI_MODEL?: string;
  OPENAI_MODEL?: string;
  WORKERS_AI_MODEL?: string;
  EMBEDDING_MODEL?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AUTO_CLOSE_HOURS?: string;
  MAX_CRAWL_PAGES?: string;

  // Secrets
  ADMIN_TOKEN: string;
  SIGNING_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  CF_API_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ALERT_EMAIL?: string;
}

export type CrawlMessage = {
  type: 'page';
  jobId: string;
  workspaceId: string;
  url: string;
  depth: number;
  maxDepth: number;
};

export type ProviderName = 'anthropic' | 'gemini' | 'xai' | 'openai' | 'workers-ai';

export interface FlowOption {
  label: string;
  value?: string;
  next_step_id?: string;
}

export interface WorkspaceSettings {
  botName: string;
  brandColor: string;
  position: 'right' | 'left';
  theme: 'auto' | 'light' | 'dark';
  greeting: string;
  placeholder: string;
  launcherText: string;
  logoUrl: string;
  persona: string;
  guardrails: string[];
  disclaimer: string;
  quickReplies: string[];
  provider: ProviderName;
  model: string;
  fallbacks: ProviderName[];
  temperature: number;
  maxTokens: number;
  handoffEnabled: boolean;
  handoffKeywords: string[];
  offlineMessage: string;
  handoffMessage: string;
  autoCloseHours: number;
  emailTranscripts: boolean;
  turnstileSiteKey: string;
  renderJs: boolean;
  recrawlDaily: boolean;
  sitemapUrl: string;
  allowLocalhost: boolean;
  showSources: boolean;
  collectEmailBeforeChat: boolean;
  alertEmail: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  domain: string;
  public_key: string;
  allowed_origins: string;
  settings: string;
  created_at: number;
  updated_at: number;
}

export interface Workspace {
  id: string;
  name: string;
  domain: string;
  publicKey: string;
  allowedOrigins: string[];
  settings: WorkspaceSettings;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  status: 'open' | 'closed';
  mode: 'flow' | 'bot' | 'human';
  assignee_id: string | null;
  subject: string | null;
  page_url: string | null;
  meta: string;
  message_count: number;
  last_message_at: number;
  last_message_preview: string | null;
  handoff_at: number | null;
  first_response_at: number | null;
  rating: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: 'visitor' | 'bot' | 'agent' | 'system';
  author_id: string | null;
  content: string;
  attachments: string;
  buttons: string;
  meta: string;
  created_at: number;
}

export interface CustomerRow {
  id: string;
  workspace_id: string;
  visitor_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  attributes: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface AgentRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  workspace_ids: string;
  token_hash: string;
  last_seen_at: number | null;
  created_at: number;
}

export interface AuthContext {
  kind: 'owner' | 'agent';
  agentId: string | null;
  agentName: string;
  role: 'admin' | 'agent';
  workspaceIds: string[]; // empty = all
}

export type AppEnv = {
  Bindings: Env;
  Variables: { auth: AuthContext };
};
