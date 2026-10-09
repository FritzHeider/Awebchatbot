# Prompt 3 / 8 — Knowledge base and crawler

Context: `MASTER_PROMPT.md`, prompts 1–2.

## `src/rag.ts`

- `chunkText(text, size=900, overlap=150)`:
  - Normalise whitespace.
  - Split paragraphs, then split long paragraphs into sentences; hard-split sentences longer than `size`.
  - Pack units into chunks and carry the overlap from a word boundary.
  - Drop chunks shorter than 20 characters.
- `ftsQuery(text)`: lowercase unicode word tokens of 2+ characters, minus stopwords, deduplicated, at most 12.
  Return each quoted, joined by ` OR `, or `null` when nothing is left.
- `embed(env, texts)`: batches of 50; return `null` on any failure.
- `indexDocument(env, wsId, {url, title, content, source})`:
  - Skip when `sha256(title+content)` is unchanged and the document is already indexed.
  - Otherwise delete the old chunks from D1, FTS and Vectorize, then insert chunks into `kb_chunks` and `kb_fts`.
  - Upsert vectors with `namespace = wsId` and metadata `{documentId, url, title}`. A failed upsert is not fatal:
    keyword-only search still works.
  - Record `chunk_count` and `vector_indexed`.
- `deleteDocument`.
- `searchKnowledge(env, wsId, query, topK)`:
  - Run Vectorize (score > 0.35) and FTS (`bm25` order) in parallel; merge with RRF (k = 60).
  - Join chunk rows to documents and return hits `{chunkId, documentId, url, title, content, score}`.
- `extractiveAnswer(hits, handoffEnabled)`.

## `src/crawler.ts`

- `extractPage(html)` with HTMLRewriter:
  - Skip script, style, noscript, svg, template, iframe, nav, footer, form, select, button and `[aria-hidden=true]`
    using a depth counter. Use `onEndTag` inside a try block, because void elements have no end tag.
  - Add newlines around block elements and a `- ` prefix for list items.
  - Collect the title, meta description/og:description, robots `noindex` and `a[href]` links.
  - Decode entities, strip the duplicated title, and collapse blank lines.
- `normalizeLink(href, pageUrl, rootHost)`:
  - Accept http(s) on the same site only; www and the apex domain count as the same site.
  - Drop the hash and tracking parameters (utm_, fbclid, gclid, ref, mc_) and any trailing slash.
  - Skip asset extensions and login/cart/admin paths.
- `discoverSitemapUrls(root, explicit, limit)`: read robots.txt `Sitemap:` lines, `/sitemap.xml`,
  `/sitemap_index.xml` and nested indexes (at most 20 sitemaps).
- `fetchHtml(env, url, renderJs)`:
  - When `renderJs` is on and `CF_API_TOKEN` and `CF_ACCOUNT_ID` are set, POST to the Browser Rendering REST
    endpoint `/accounts/{id}/browser-rendering/content`.
  - Otherwise fetch with a crawler User-Agent and a 15 s timeout, accept HTML only and cap the body at 3 MB.
- `claimUrl(env, jobId, url) → 'ok' | 'seen' | 'budget'`:
  - Use a KV dedup key with a 1-day TTL.
  - Then an atomic `UPDATE crawl_jobs SET pages_queued = pages_queued + 1 WHERE … AND pages_queued < max_pages RETURNING`.
- `startCrawl(env, ws, rootUrl, {maxPages, maxDepth})`: create the job, seed the root and sitemap URLs, and send
  queue batches of 50.
- `processCrawlMessage(env, msg, renderJs)`:
  - Index pages with more than 80 characters of text that are not marked noindex.
  - Enqueue new links while `depth < maxDepth`, and stop as soon as the page budget runs out.
  - Increment `pages_done` or `pages_failed`, then mark the job done when all queued pages are processed.
- `latestCrawl`.

## Acceptance

- Unit tests for `chunkText`, `ftsQuery` (stopwords and syntax neutralisation), `normalizeLink` and
  `extractiveAnswer`.
- With `dev:offline` and a local static site (`python3 -m http.server`), a crawl of 2 linked pages finishes as
  `done 2/2`, and knowledge search finds text from the linked page.
