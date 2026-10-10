import type { CrawlMessage, Env, Workspace } from './env';
import { sha256Hex } from './auth';
import { indexDocument } from './rag';
import { chunkArray, clampInt, newId, now } from './util';

const USER_AGENT = 'AWebChatbotCrawler/1.0 (+knowledge indexing for site chat assistant)';
const SKIP_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|pdf|zip|gz|tar|rar|7z|mp3|mp4|mov|avi|webm|wav|ogg|woff2?|ttf|eot|otf|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|dmg|exe|apk)$/i;
const SKIP_PATHS = /\/(wp-admin|wp-login|login|logout|signin|signup|register|cart|checkout|account|admin|cdn-cgi)(\/|$)/i;

export interface ExtractedPage {
  title: string;
  description: string;
  text: string;
  links: string[];
  noindex: boolean;
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode HTML entities in one pass, so "&amp;lt;" becomes "&lt;" rather than "<". Handles decimal and hex. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : -1;
    if (code >= 0) return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    return NAMED_ENTITIES[name.toLowerCase()] ?? m;
  });
}

/** Extract readable text, title and links from HTML with the streaming HTMLRewriter. */
export async function extractPage(html: string | Response): Promise<ExtractedPage> {
  const parts: string[] = [];
  const links: string[] = [];
  let title = '';
  let description = '';
  let noindex = false;
  let skip = 0;

  const skipHandler = {
    element(el: Element) {
      skip++;
      try {
        el.onEndTag(() => {
          skip = Math.max(0, skip - 1);
        });
      } catch {
        skip = Math.max(0, skip - 1);
      }
    },
  };
  const blockHandler = {
    element(el: Element) {
      parts.push('\n');
      try {
        el.onEndTag(() => {
          parts.push('\n');
        });
      } catch {
        // void element (e.g. <br>) has no end tag
      }
    },
  };

  const rewriter = new HTMLRewriter()
    .on('script, style, noscript, svg, template, iframe, nav, footer, form, select, button, [aria-hidden="true"]', skipHandler)
    .on('p, div, ul, ol, li, h1, h2, h3, h4, h5, h6, br, tr, section, article, td, th, dd, dt, blockquote, pre, main, header', blockHandler)
    .on('li', {
      element() {
        parts.push('- ');
      },
    })
    .on('title', {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on('meta', {
      element(el) {
        const name = (el.getAttribute('name') || el.getAttribute('property') || '').toLowerCase();
        const content = el.getAttribute('content') || '';
        if ((name === 'description' || name === 'og:description') && !description) description = content;
        if (name === 'robots' && /noindex/i.test(content)) noindex = true;
      },
    })
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (href) links.push(href);
      },
    })
    .onDocument({
      text(chunk) {
        if (skip > 0) return;
        if (chunk.text) parts.push(chunk.text);
      },
    });

  const response = typeof html === 'string' ? new Response(html, { headers: { 'content-type': 'text/html' } }) : html;
  await rewriter.transform(response).arrayBuffer();

  // The <title> text also flows through the document text handler; drop it from the body text.
  const rawText = decodeEntities(parts.join(''));
  const titleText = decodeEntities(title).trim();
  let text = rawText
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
  if (titleText && text.startsWith(titleText)) text = text.slice(titleText.length).trim();
  text = text.replace(/^(- \n)+/gm, '').replace(/\n{3,}/g, '\n\n');

  return { title: titleText, description: decodeEntities(description).trim(), text, links, noindex };
}

export function normalizeLink(href: string, pageUrl: string, rootHost: string): string | null {
  if (/^(mailto|tel|javascript|data):/i.test(href) || href.startsWith('#')) return null;
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^www\./, '');
  if (host !== rootHost.replace(/^www\./, '')) return null;
  if (SKIP_EXTENSIONS.test(url.pathname) || SKIP_PATHS.test(url.pathname)) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$|mc_)/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

async function fetchHtml(env: Env, url: string, renderJs: boolean): Promise<{ html: string; finalUrl: string } | null> {
  if (renderJs && env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
    // Cloudflare Browser Rendering REST API: returns fully rendered HTML for JavaScript-heavy sites.
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 } }),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { success?: boolean; result?: string };
      if (data.success && typeof data.result === 'string') return { html: data.result, finalUrl: url };
    }
    console.warn('browser rendering failed, falling back to fetch', res.status);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 15_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return null;
    const finalUrl = res.url || url;
    const fromHost = new URL(url).hostname.replace(/^www\./, '');
    const toHost = new URL(finalUrl).hostname.replace(/^www\./, '');
    if (fromHost !== toHost && !toHost.endsWith(`.${fromHost}`)) return null;
    const html = await res.text();
    return { html: html.slice(0, 3_000_000), finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Read sitemap(s): robots.txt Sitemap entries, /sitemap.xml and nested sitemap indexes. */
export async function discoverSitemapUrls(rootUrl: string, explicitSitemap: string, limit: number): Promise<string[]> {
  const root = new URL(rootUrl);
  const candidates = new Set<string>();
  if (explicitSitemap) candidates.add(explicitSitemap);
  const robots = await fetchText(`${root.origin}/robots.txt`);
  if (robots) {
    for (const line of robots.split('\n')) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) candidates.add(m[1]);
    }
  }
  candidates.add(`${root.origin}/sitemap.xml`);
  candidates.add(`${root.origin}/sitemap_index.xml`);

  const rootHost = root.hostname.replace(/^www\./, '');
  const sameSite = (u: string) => {
    try {
      const h = new URL(u).hostname.replace(/^www\./, '');
      return h === rootHost || h.endsWith(`.${rootHost}`);
    } catch {
      return false;
    }
  };
  const pages = new Set<string>();
  const visited = new Set<string>();
  const queue = [...candidates];
  while (queue.length && pages.size < limit && visited.size < 20) {
    const sitemap = queue.shift()!;
    if (visited.has(sitemap) || !sameSite(sitemap)) continue;
    visited.add(sitemap);
    const xml = await fetchText(sitemap);
    if (!xml || !xml.includes('<')) continue;
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]);
    const isIndex = /<sitemapindex/i.test(xml);
    for (const loc of locs) {
      if (isIndex || /\.xml(\.gz)?$/i.test(loc)) queue.push(loc);
      else {
        const normalized = normalizeLink(loc, rootUrl, root.hostname);
        if (normalized) pages.add(normalized);
      }
      if (pages.size >= limit) break;
    }
  }
  return [...pages];
}

type Claim = 'ok' | 'seen' | 'budget';

async function claimUrl(env: Env, jobId: string, url: string): Promise<Claim> {
  const key = `crawl:${jobId}:${(await sha256Hex(url)).slice(0, 32)}`;
  try {
    if (await env.CACHE.get(key)) return 'seen';
    await env.CACHE.put(key, '1', { expirationTtl: 60 * 60 * 24 });
  } catch {
    // KV unavailable: rely on the page budget only
  }
  const row = await env.DB.prepare(
    'UPDATE crawl_jobs SET pages_queued = pages_queued + 1, updated_at = ? WHERE id = ? AND pages_queued < max_pages RETURNING pages_queued',
  )
    .bind(now(), jobId)
    .first<{ pages_queued: number }>();
  return row ? 'ok' : 'budget';
}

async function enqueue(env: Env, messages: CrawlMessage[]): Promise<void> {
  for (const batch of chunkArray(messages, 50)) {
    await env.CRAWL_QUEUE.sendBatch(batch.map((body) => ({ body })));
  }
}

export interface CrawlJob {
  id: string;
  workspace_id: string;
  root_url: string;
  status: string;
  max_pages: number;
  pages_queued: number;
  pages_done: number;
  pages_failed: number;
  created_at: number;
  updated_at: number;
}

/** Start a crawl: seeds the root URL plus every sitemap URL, then link-follows up to maxDepth. */
export async function startCrawl(
  env: Env,
  ws: Workspace,
  rootUrl: string,
  options: { maxPages?: number; maxDepth?: number } = {},
): Promise<CrawlJob> {
  const envMax = clampInt(env.MAX_CRAWL_PAGES, 1, 5000, 150);
  const maxPages = clampInt(options.maxPages, 1, envMax, envMax);
  const maxDepth = clampInt(options.maxDepth, 0, 5, 3);
  const id = newId('crawl');
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO crawl_jobs (id, workspace_id, root_url, status, max_pages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, ws.id, rootUrl, 'running', maxPages, ts, ts)
    .run();

  const root = new URL(rootUrl);
  const seeds = [normalizeLink(rootUrl, rootUrl, root.hostname) || rootUrl];
  try {
    seeds.push(...(await discoverSitemapUrls(rootUrl, ws.settings.sitemapUrl, maxPages)));
  } catch (err) {
    console.warn('sitemap discovery failed', err instanceof Error ? err.message : err);
  }
  const messages: CrawlMessage[] = [];
  for (const url of [...new Set(seeds)]) {
    const claim = await claimUrl(env, id, url);
    if (claim === 'budget') break;
    if (claim === 'ok') {
      messages.push({ type: 'page', jobId: id, workspaceId: ws.id, url, depth: url === seeds[0] ? 0 : 1, maxDepth });
    }
  }
  await enqueue(env, messages);
  return (await env.DB.prepare('SELECT * FROM crawl_jobs WHERE id = ?').bind(id).first<CrawlJob>())!;
}

async function finishIfComplete(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE crawl_jobs SET status = 'done', updated_at = ? WHERE id = ? AND status = 'running' AND pages_done + pages_failed >= pages_queued",
  )
    .bind(now(), jobId)
    .run();
}

/** Queue consumer for one page. */
export async function processCrawlMessage(env: Env, msg: CrawlMessage, renderJs: boolean): Promise<void> {
  let ok = false;
  try {
    const page = await fetchHtml(env, msg.url, renderJs);
    if (page) {
      const extracted = await extractPage(page.html);
      if (!extracted.noindex && extracted.text.length > 80) {
        const body = extracted.description ? `${extracted.description}\n\n${extracted.text}` : extracted.text;
        await indexDocument(env, msg.workspaceId, {
          url: msg.url,
          title: extracted.title || msg.url,
          content: body,
          source: 'crawl',
        });
      }
      ok = true;
      if (msg.depth < msg.maxDepth) {
        const rootHost = new URL(msg.url).hostname;
        const next: CrawlMessage[] = [];
        const unique = new Set<string>();
        for (const href of extracted.links) {
          const link = normalizeLink(href, page.finalUrl, rootHost);
          if (link && !unique.has(link)) unique.add(link);
        }
        for (const link of unique) {
          const claim = await claimUrl(env, msg.jobId, link);
          if (claim === 'budget') break;
          if (claim === 'ok') next.push({ ...msg, url: link, depth: msg.depth + 1 });
        }
        try {
          await enqueue(env, next);
        } catch (err) {
          // Release the claimed budget so the job can still complete.
          await env.DB.prepare('UPDATE crawl_jobs SET pages_queued = MAX(0, pages_queued - ?) WHERE id = ?')
            .bind(next.length, msg.jobId)
            .run();
          console.warn('enqueue failed', err instanceof Error ? err.message : err);
        }
      }
    }
  } catch (err) {
    console.warn('crawl page failed', msg.url, err instanceof Error ? err.message : err);
    ok = false;
  }
  await env.DB.prepare(
    `UPDATE crawl_jobs SET ${ok ? 'pages_done = pages_done + 1' : 'pages_failed = pages_failed + 1'}, updated_at = ? WHERE id = ?`,
  )
    .bind(now(), msg.jobId)
    .run();
  await finishIfComplete(env, msg.jobId);
}

export async function latestCrawl(env: Env, workspaceId: string): Promise<CrawlJob | null> {
  return env.DB.prepare('SELECT * FROM crawl_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(workspaceId)
    .first<CrawlJob>();
}
