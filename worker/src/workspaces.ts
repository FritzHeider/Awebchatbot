import type { Env, ProviderName, Workspace, WorkspaceRow, WorkspaceSettings } from './env';
import { randomToken } from './auth';
import { HttpError, newId, normalizeDomain, now, parseJson } from './util';

export const PROVIDERS: ProviderName[] = ['anthropic', 'gemini', 'xai', 'openai', 'workers-ai'];

export function defaultSettings(name: string): WorkspaceSettings {
  return {
    botName: `${name} Assistant`,
    brandColor: '#4f46e5',
    position: 'right',
    theme: 'auto',
    greeting: `Hi! I'm the ${name} assistant. Ask me anything, or type "human" to reach our team.`,
    placeholder: 'Type your message…',
    launcherText: 'Chat with us',
    logoUrl: '',
    persona: '',
    guardrails: [],
    disclaimer: '',
    quickReplies: [],
    provider: 'anthropic',
    model: '',
    fallbacks: ['gemini', 'xai', 'workers-ai'],
    temperature: 0.3,
    maxTokens: 700,
    handoffEnabled: true,
    handoffKeywords: ['human', 'agent', 'representative', 'real person', 'talk to someone', 'operator', 'support team'],
    offlineMessage:
      "Our team isn't online right now. Leave your email below and we'll get back to you as soon as possible.",
    handoffMessage: "I'm connecting you with a member of our team. They'll reply here shortly.",
    autoCloseHours: 24,
    emailTranscripts: false,
    turnstileSiteKey: '',
    renderJs: false,
    recrawlDaily: true,
    sitemapUrl: '',
    allowLocalhost: true,
    showSources: true,
    collectEmailBeforeChat: false,
    alertEmail: '',
  };
}

export function mergeSettings(base: WorkspaceSettings, patch: Partial<WorkspaceSettings>): WorkspaceSettings {
  const merged: WorkspaceSettings = { ...base };
  const keys = Object.keys(base) as (keyof WorkspaceSettings)[];
  for (const key of keys) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined || value === null) continue;
    const expected = typeof base[key];
    if (Array.isArray(base[key])) {
      if (Array.isArray(value)) (merged as unknown as Record<string, unknown>)[key] = value.map(String);
      continue;
    }
    if (typeof value === expected) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if (!PROVIDERS.includes(merged.provider)) merged.provider = 'anthropic';
  merged.fallbacks = merged.fallbacks.filter((p): p is ProviderName => PROVIDERS.includes(p as ProviderName));
  merged.temperature = Math.min(1, Math.max(0, merged.temperature));
  merged.maxTokens = Math.min(4000, Math.max(100, Math.trunc(merged.maxTokens)));
  merged.autoCloseHours = Math.min(24 * 30, Math.max(1, Math.trunc(merged.autoCloseHours)));
  if (!/^#[0-9a-fA-F]{3,8}$/.test(merged.brandColor)) merged.brandColor = base.brandColor;
  if (merged.position !== 'left' && merged.position !== 'right') merged.position = 'right';
  if (!['auto', 'light', 'dark'].includes(merged.theme)) merged.theme = 'auto';
  return merged;
}

export function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    publicKey: row.public_key,
    allowedOrigins: parseJson<string[]>(row.allowed_origins, []),
    settings: mergeSettings(defaultSettings(row.name), parseJson<Partial<WorkspaceSettings>>(row.settings, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CACHE_TTL = 60;

export async function getWorkspace(env: Env, id: string): Promise<Workspace> {
  const row = await env.DB.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first<WorkspaceRow>();
  if (!row) throw new HttpError(404, `Workspace ${id} not found`);
  return rowToWorkspace(row);
}

export async function getWorkspaceByKey(env: Env, publicKey: string): Promise<Workspace> {
  if (!publicKey || !/^pk_[a-z0-9]+$/.test(publicKey)) throw new HttpError(400, 'Invalid widget key');
  const cacheKey = `ws:key:${publicKey}`;
  try {
    const cached = await env.CACHE.get<WorkspaceRow>(cacheKey, 'json');
    if (cached) return rowToWorkspace(cached);
  } catch {
    // cache miss or KV unavailable: fall through to D1
  }
  const row = await env.DB.prepare('SELECT * FROM workspaces WHERE public_key = ?')
    .bind(publicKey)
    .first<WorkspaceRow>();
  if (!row) throw new HttpError(404, 'Unknown widget key');
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: CACHE_TTL });
  } catch {
    // ignore cache write failures
  }
  return rowToWorkspace(row);
}

export async function invalidateWorkspaceCache(env: Env, ws: Workspace): Promise<void> {
  try {
    await env.CACHE.delete(`ws:key:${ws.publicKey}`);
  } catch {
    // ignore
  }
}

export async function listWorkspaces(env: Env, ids: string[]): Promise<Workspace[]> {
  const { results } = await env.DB.prepare('SELECT * FROM workspaces ORDER BY created_at ASC').all<WorkspaceRow>();
  return results.map(rowToWorkspace).filter((w) => ids.length === 0 || ids.includes(w.id));
}

export async function createWorkspace(
  env: Env,
  input: { name?: string; url: string; settings?: Partial<WorkspaceSettings>; allowedOrigins?: string[] },
): Promise<Workspace> {
  const domain = normalizeDomain(input.url);
  const name = (input.name || domain.split('.')[0]).trim();
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  const settings = mergeSettings(defaultSettings(displayName), input.settings || {});
  const origins = new Set<string>([`https://${domain}`, `https://www.${domain}`, ...(input.allowedOrigins || [])]);
  const id = newId('ws');
  const publicKey = `pk_${randomToken(18).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO workspaces (id, name, domain, public_key, allowed_origins, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, displayName, domain, publicKey, JSON.stringify([...origins]), JSON.stringify(settings), ts, ts)
    .run();
  return getWorkspace(env, id);
}

export async function updateWorkspace(
  env: Env,
  ws: Workspace,
  patch: { name?: string; settings?: Partial<WorkspaceSettings>; allowedOrigins?: string[] },
): Promise<Workspace> {
  const name = patch.name?.trim() || ws.name;
  const settings = mergeSettings(ws.settings, patch.settings || {});
  const origins = patch.allowedOrigins ? patch.allowedOrigins.map((o) => o.trim()).filter(Boolean) : ws.allowedOrigins;
  await env.DB.prepare('UPDATE workspaces SET name = ?, settings = ?, allowed_origins = ?, updated_at = ? WHERE id = ?')
    .bind(name, JSON.stringify(settings), JSON.stringify(origins), now(), ws.id)
    .run();
  await invalidateWorkspaceCache(env, ws);
  return getWorkspace(env, ws.id);
}

/** Origin check for the public widget API. Requests without an Origin header (server-side, curl) are allowed. */
export function originAllowed(ws: Workspace, origin: string | null): boolean {
  if (!origin || origin === 'null') return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (ws.settings.allowLocalhost && (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost'))) {
    return true;
  }
  if (host === ws.domain || host.endsWith(`.${ws.domain}`)) return true;
  for (const allowed of ws.allowedOrigins) {
    if (allowed === '*') return true;
    try {
      const allowedHost = new URL(allowed.includes('://') ? allowed : `https://${allowed}`).hostname.toLowerCase();
      if (allowedHost.startsWith('*.')) {
        if (host.endsWith(allowedHost.slice(1))) return true;
      } else if (host === allowedHost) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/** Settings that are safe to expose to the browser widget. */
export function publicConfig(ws: Workspace) {
  const s = ws.settings;
  return {
    name: ws.name,
    botName: s.botName,
    brandColor: s.brandColor,
    position: s.position,
    theme: s.theme,
    greeting: s.greeting,
    placeholder: s.placeholder,
    launcherText: s.launcherText,
    logoUrl: s.logoUrl,
    disclaimer: s.disclaimer,
    quickReplies: s.quickReplies,
    handoffEnabled: s.handoffEnabled,
    turnstileSiteKey: s.turnstileSiteKey,
    showSources: s.showSources,
    collectEmailBeforeChat: s.collectEmailBeforeChat,
  };
}
