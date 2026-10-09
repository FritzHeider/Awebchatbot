import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

interface SocketInfo {
  role: 'visitor' | 'agent';
  who: string;
  name: string;
}

/**
 * One Durable Object instance per room. Rooms are named:
 *   conv:<conversationId>  - the visitor's widget and any agent watching the thread
 *   inbox:<workspaceId>    - every agent with the inbox open for that workspace (presence + live updates)
 * Uses the WebSocket Hibernation API so idle connections cost nothing.
 */
export class Room extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/connect':
        return this.handleConnect(request);
      case '/broadcast':
        return this.broadcast(request);
      case '/presence':
        return Response.json(this.presence());
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private handleConnect(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    const role = request.headers.get('X-Room-Role') === 'agent' ? 'agent' : 'visitor';
    const who = request.headers.get('X-Room-Who') || 'anonymous';
    const name = request.headers.get('X-Room-Name') || (role === 'agent' ? 'Agent' : 'Visitor');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role, who]);
    const info: SocketInfo = { role, who, name };
    server.serializeAttachment(info);
    server.send(JSON.stringify({ type: 'hello', presence: this.presence() }));
    if (role === 'agent') this.send({ type: 'presence', presence: this.presence() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(request: Request): Promise<Response> {
    const body = await request.text();
    const target = new URL(request.url).searchParams.get('to'); // visitor | agent | null (all)
    let sent = 0;
    for (const ws of this.ctx.getWebSockets(target || undefined)) {
      try {
        ws.send(body);
        sent++;
      } catch {
        // socket already closed
      }
    }
    return Response.json({ sent });
  }

  private presence() {
    const agents = new Map<string, string>();
    let visitors = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment() as SocketInfo | null;
      if (!info) continue;
      if (info.role === 'agent') agents.set(info.who, info.name);
      else visitors++;
    }
    return { agents: [...agents.entries()].map(([id, name]) => ({ id, name })), visitors };
  }

  private send(payload: unknown, except?: WebSocket) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // ignore
      }
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 2000) return;
    let data: { type?: string };
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    } else if (data.type === 'typing' && info) {
      this.send({ type: 'typing', role: info.role, name: info.name }, ws);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (info?.role === 'agent') this.send({ type: 'presence', presence: this.presence() }, ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // ignore
    }
  }
}

function roomStub(env: Env, name: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(name));
}

export async function broadcast(env: Env, room: string, payload: unknown, to?: 'visitor' | 'agent'): Promise<void> {
  try {
    await roomStub(env, room).fetch(`https://room/broadcast${to ? `?to=${to}` : ''}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('broadcast failed', room, err instanceof Error ? err.message : err);
  }
}

export async function presence(env: Env, room: string): Promise<{ agents: { id: string; name: string }[]; visitors: number }> {
  try {
    const res = await roomStub(env, room).fetch('https://room/presence');
    return (await res.json()) as { agents: { id: string; name: string }[]; visitors: number };
  } catch {
    return { agents: [], visitors: 0 };
  }
}

export async function connectToRoom(
  env: Env,
  room: string,
  request: Request,
  role: 'visitor' | 'agent',
  who: string,
  name: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('X-Room-Role', role);
  headers.set('X-Room-Who', who);
  headers.set('X-Room-Name', name);
  return roomStub(env, room).fetch(new Request('https://room/connect', { headers }));
}
