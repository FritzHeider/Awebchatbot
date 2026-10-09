import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, CrawlMessage, Env } from './env';
import adminRoutes from './routes/admin';
import widgetRoutes from './routes/widget';
import { closeConversation } from './chat';
import { processCrawlMessage, startCrawl } from './crawler';
import { getWorkspace, listWorkspaces } from './workspaces';
import { HttpError, clampInt } from './util';

export { Room } from './realtime';

const app = new Hono<AppEnv>();

// The widget API is called cross-origin from customer websites; origins are checked per workspace in the routes.
app.use(
  '/v1/*',
  cors({
    origin: (origin) => origin || '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);
app.use(
  '/admin/*',
  cors({
    origin: (origin) => origin || '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);

app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
});

app.get('/health', (c) => c.json({ ok: true, service: 'awebchatbot', time: new Date().toISOString() }));
app.get('/', (c) => c.redirect('/inbox/'));

app.route('/v1', widgetRoutes);
app.route('/admin', adminRoutes);

app.notFound(async (c) => {
  // Fall back to static assets (widget.js, inbox) for anything that is not an API route.
  if (!c.req.path.startsWith('/v1/') && !c.req.path.startsWith('/admin/')) {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404) return res;
  }
  return c.json({ error: 'Not found' }, 404);
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error('unhandled error', err);
  return c.json({ error: 'Internal error' }, 500);
});

async function autoCloseIdle(env: Env, ctx: ExecutionContext): Promise<number> {
  const workspaces = await listWorkspaces(env, []);
  const defaultHours = clampInt(env.AUTO_CLOSE_HOURS, 1, 720, 24);
  let closed = 0;
  const { results: raw } = await env.DB.prepare('SELECT id, settings FROM workspaces').all<{ id: string; settings: string }>();
  const explicit = new Map(raw.map((r) => [r.id, (JSON.parse(r.settings || '{}') as { autoCloseHours?: number }).autoCloseHours]));
  for (const ws of workspaces) {
    // A per-site value wins; otherwise the AUTO_CLOSE_HOURS var applies.
    const hours = typeof explicit.get(ws.id) === 'number' ? ws.settings.autoCloseHours : defaultHours;
    const cutoff = Date.now() - hours * 3_600_000;
    const { results } = await env.DB.prepare(
      "SELECT id FROM conversations WHERE workspace_id = ? AND status = 'open' AND last_message_at < ? LIMIT 200",
    )
      .bind(ws.id, cutoff)
      .all<{ id: string }>();
    for (const row of results) {
      await closeConversation(env, (p) => ctx.waitUntil(p), ws, row.id, 'auto-close (inactive)');
      closed++;
    }
  }
  return closed;
}

async function dailyRecrawl(env: Env): Promise<void> {
  const workspaces = await listWorkspaces(env, []);
  for (const ws of workspaces) {
    if (!ws.settings.recrawlDaily) continue;
    try {
      await startCrawl(env, ws, `https://${ws.domain}/`);
    } catch (err) {
      console.error('recrawl failed', ws.id, err);
    }
  }
}

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<CrawlMessage>, env: Env): Promise<void> {
    const renderCache = new Map<string, boolean>();
    for (const message of batch.messages) {
      const body = message.body;
      try {
        let renderJs = renderCache.get(body.workspaceId);
        if (renderJs === undefined) {
          renderJs = (await getWorkspace(env, body.workspaceId)).settings.renderJs;
          renderCache.set(body.workspaceId, renderJs);
        }
        await processCrawlMessage(env, body, renderJs);
        message.ack();
      } catch (err) {
        console.error('crawl message failed', body.url, err);
        message.retry({ delaySeconds: 30 });
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '0 9 * * *') {
      ctx.waitUntil(dailyRecrawl(env));
    } else {
      ctx.waitUntil(
        autoCloseIdle(env, ctx).then((n) => {
          if (n) console.log(`auto-closed ${n} idle conversations`);
        }),
      );
    }
  },
} satisfies ExportedHandler<Env, CrawlMessage>;
