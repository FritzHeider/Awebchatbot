import type { AgentRow, AuthContext, Env } from './env';
import { HttpError, parseJson } from './util';

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(sig);
}

export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toBase64Url(arr);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function sanitizeVisitorId(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return clean.length >= 8 ? clean : `v_${randomToken(12)}`;
}

/** Visitor token: base64url(convId:visitorId).signature — proves the browser owns the conversation. */
export async function signVisitorToken(env: Env, conversationId: string, visitorId: string): Promise<string> {
  const payload = toBase64Url(encoder.encode(`${conversationId}:${visitorId}`));
  const sig = await hmacSign(env.SIGNING_SECRET, `visitor:${payload}`);
  return `${payload}.${sig}`;
}

export async function verifyVisitorToken(
  env: Env,
  token: string | null | undefined,
): Promise<{ conversationId: string; visitorId: string } | null> {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const key = await hmacKey(env.SIGNING_SECRET);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), encoder.encode(`visitor:${payload}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  const decoded = new TextDecoder().decode(fromBase64Url(payload));
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { conversationId: decoded.slice(0, idx), visitorId: decoded.slice(idx + 1) };
}

export function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function authenticateAdmin(env: Env, token: string | null): Promise<AuthContext> {
  if (!token) throw new HttpError(401, 'Missing bearer token');
  if (!env.ADMIN_TOKEN) throw new HttpError(500, 'ADMIN_TOKEN secret is not configured');
  if (safeEqual(token, env.ADMIN_TOKEN)) {
    return { kind: 'owner', agentId: null, agentName: 'Owner', role: 'admin', workspaceIds: [] };
  }
  const hash = await sha256Hex(token);
  const agent = await env.DB.prepare('SELECT * FROM agents WHERE token_hash = ?').bind(hash).first<AgentRow>();
  if (!agent) throw new HttpError(401, 'Invalid token');
  await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').bind(Date.now(), agent.id).run();
  return {
    kind: 'agent',
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    workspaceIds: parseJson<string[]>(agent.workspace_ids, []),
  };
}

export function canAccessWorkspace(auth: AuthContext, workspaceId: string): boolean {
  return auth.workspaceIds.length === 0 || auth.workspaceIds.includes(workspaceId);
}

export function assertWorkspaceAccess(auth: AuthContext, workspaceId: string): void {
  if (!canAccessWorkspace(auth, workspaceId)) throw new HttpError(403, 'No access to this workspace');
}

export function assertAdmin(auth: AuthContext): void {
  if (auth.role !== 'admin') throw new HttpError(403, 'Admin role required');
}
