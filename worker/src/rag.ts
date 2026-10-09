import type { Env } from './env';
import { sha256Hex } from './auth';
import { chunkArray, newId, now, truncate } from './util';

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  url: string;
  title: string;
  content: string;
  score: number;
}

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from has have how i in is it its me my no not of on or our so that the their them there these they this to was we what when where which who why will with you your yours about into than then also just any some'.split(
    ' ',
  ),
);

/** Split text into overlapping chunks on paragraph / sentence boundaries. */
export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const units: string[] = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) {
      units.push(p);
      continue;
    }
    const sentences = p.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$|\n/g) || [p];
    let buf = '';
    for (const sentence of sentences) {
      if ((buf + sentence).length > size && buf) {
        units.push(buf.trim());
        buf = '';
      }
      if (sentence.length > size) {
        for (let i = 0; i < sentence.length; i += size) units.push(sentence.slice(i, i + size).trim());
      } else {
        buf += sentence;
      }
    }
    if (buf.trim()) units.push(buf.trim());
  }

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + unit.length + 2 > size) {
      chunks.push(current);
      const tail = current.slice(Math.max(0, current.length - overlap));
      const cut = tail.indexOf(' ');
      current = (cut >= 0 ? tail.slice(cut + 1) : tail) + '\n\n' + unit;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length >= 20);
}

/** Build a safe FTS5 MATCH expression from free text. */
export function ftsQuery(text: string): string | null {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((t) => !STOPWORDS.has(t));
  const unique = [...new Set(tokens)].slice(0, 12);
  if (!unique.length) return null;
  return unique.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export async function embed(env: Env, texts: string[]): Promise<number[][] | null> {
  if (!env.AI || !texts.length) return null;
  const model = env.EMBEDDING_MODEL || '@cf/baai/bge-base-en-v1.5';
  const out: number[][] = [];
  try {
    for (const batch of chunkArray(texts, 50)) {
      const res = (await (env.AI as any).run(model, { text: batch })) as { data?: number[][] };
      if (!res?.data || res.data.length !== batch.length) return null;
      out.push(...res.data);
    }
    return out;
  } catch (err) {
    console.warn('embedding failed', err instanceof Error ? err.message : err);
    return null;
  }
}

async function deleteDocumentChunks(env: Env, documentId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id FROM kb_chunks WHERE document_id = ?')
    .bind(documentId)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (!ids.length) return;
  for (const batch of chunkArray(ids, 50)) {
    const placeholders = batch.map(() => '?').join(',');
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM kb_fts WHERE chunk_id IN (${placeholders})`).bind(...batch),
      env.DB.prepare(`DELETE FROM kb_chunks WHERE id IN (${placeholders})`).bind(...batch),
    ]);
    if (env.VECTORIZE) {
      try {
        await env.VECTORIZE.deleteByIds(batch);
      } catch (err) {
        console.warn('vectorize delete failed', err instanceof Error ? err.message : err);
      }
    }
  }
}

export interface IndexInput {
  url: string;
  title: string;
  content: string;
  source: 'crawl' | 'manual';
}

export interface IndexResult {
  documentId: string;
  status: 'indexed' | 'unchanged' | 'empty';
  chunks: number;
  vectorIndexed: boolean;
}

/** Index (or re-index) one document into D1 full-text search and Vectorize. */
export async function indexDocument(env: Env, workspaceId: string, input: IndexInput): Promise<IndexResult> {
  const content = input.content.trim();
  const hash = await sha256Hex(`${input.title}\n${content}`);
  const ts = now();
  const existing = await env.DB.prepare(
    'SELECT id, content_hash, status FROM kb_documents WHERE workspace_id = ? AND url = ?',
  )
    .bind(workspaceId, input.url)
    .first<{ id: string; content_hash: string | null; status: string }>();

  if (existing && existing.content_hash === hash && existing.status === 'indexed') {
    await env.DB.prepare('UPDATE kb_documents SET updated_at = ? WHERE id = ?').bind(ts, existing.id).run();
    return { documentId: existing.id, status: 'unchanged', chunks: 0, vectorIndexed: false };
  }

  const documentId = existing?.id || newId('doc');
  if (existing) await deleteDocumentChunks(env, documentId);
  else {
    await env.DB.prepare(
      'INSERT INTO kb_documents (id, workspace_id, url, title, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(documentId, workspaceId, input.url, truncate(input.title || input.url, 300), input.source, 'pending', ts, ts)
      .run();
  }

  const header = input.title ? `${input.title}\n\n` : '';
  const chunks = chunkText(content);
  if (!chunks.length) {
    await env.DB.prepare(
      "UPDATE kb_documents SET status = 'indexed', content_hash = ?, chunk_count = 0, title = ?, updated_at = ? WHERE id = ?",
    )
      .bind(hash, truncate(input.title || input.url, 300), ts, documentId)
      .run();
    return { documentId, status: 'empty', chunks: 0, vectorIndexed: false };
  }

  const rows = chunks.map((text, idx) => ({ id: newId('ck'), idx, text }));
  for (const batch of chunkArray(rows, 25)) {
    const statements: D1PreparedStatement[] = [];
    for (const row of batch) {
      statements.push(
        env.DB.prepare('INSERT INTO kb_chunks (id, document_id, workspace_id, idx, content) VALUES (?, ?, ?, ?, ?)').bind(
          row.id,
          documentId,
          workspaceId,
          row.idx,
          row.text,
        ),
        env.DB.prepare('INSERT INTO kb_fts (content, title, chunk_id, workspace_id) VALUES (?, ?, ?, ?)').bind(
          row.text,
          input.title || '',
          row.id,
          workspaceId,
        ),
      );
    }
    await env.DB.batch(statements);
  }

  let vectorIndexed = false;
  if (env.VECTORIZE) {
    const vectors = await embed(
      env,
      rows.map((r) => header + r.text),
    );
    if (vectors) {
      try {
        for (const batch of chunkArray(rows, 100)) {
          await env.VECTORIZE.upsert(
            batch.map((row) => ({
              id: row.id,
              values: vectors[row.idx],
              namespace: workspaceId,
              metadata: { documentId, url: truncate(input.url, 500), title: truncate(input.title || '', 200) },
            })),
          );
        }
        vectorIndexed = true;
      } catch (err) {
        console.warn('vectorize upsert failed', err instanceof Error ? err.message : err);
      }
    }
  }

  await env.DB.prepare(
    "UPDATE kb_documents SET status = 'indexed', content_hash = ?, chunk_count = ?, vector_indexed = ?, title = ?, error = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(hash, rows.length, vectorIndexed ? 1 : 0, truncate(input.title || input.url, 300), ts, documentId)
    .run();
  return { documentId, status: 'indexed', chunks: rows.length, vectorIndexed };
}

export async function deleteDocument(env: Env, workspaceId: string, documentId: string): Promise<boolean> {
  const doc = await env.DB.prepare('SELECT id FROM kb_documents WHERE id = ? AND workspace_id = ?')
    .bind(documentId, workspaceId)
    .first<{ id: string }>();
  if (!doc) return false;
  await deleteDocumentChunks(env, documentId);
  await env.DB.prepare('DELETE FROM kb_documents WHERE id = ?').bind(documentId).run();
  return true;
}

interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  url: string;
  title: string | null;
}

async function loadChunks(env: Env, ids: string[]): Promise<Map<string, ChunkRow>> {
  const map = new Map<string, ChunkRow>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.document_id, c.content, d.url, d.title FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id WHERE c.id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<ChunkRow>();
  for (const row of results) map.set(row.id, row);
  return map;
}

/** Hybrid retrieval: Vectorize semantic search + D1 FTS5 keyword search merged with reciprocal-rank fusion. */
export async function searchKnowledge(env: Env, workspaceId: string, query: string, topK = 6): Promise<KnowledgeHit[]> {
  const q = query.trim().slice(0, 1000);
  if (!q) return [];

  const semantic = (async (): Promise<string[]> => {
    if (!env.VECTORIZE) return [];
    const vectors = await embed(env, [q]);
    if (!vectors) return [];
    try {
      const res = await env.VECTORIZE.query(vectors[0], { topK: Math.min(20, topK * 2), namespace: workspaceId });
      return res.matches.filter((m) => m.score > 0.35).map((m) => m.id);
    } catch (err) {
      console.warn('vectorize query failed', err instanceof Error ? err.message : err);
      return [];
    }
  })();

  const keyword = (async (): Promise<string[]> => {
    const match = ftsQuery(q);
    if (!match) return [];
    try {
      const { results } = await env.DB.prepare(
        'SELECT chunk_id FROM kb_fts WHERE kb_fts MATCH ?1 AND workspace_id = ?2 ORDER BY bm25(kb_fts) LIMIT ?3',
      )
        .bind(match, workspaceId, topK * 2)
        .all<{ chunk_id: string }>();
      return results.map((r) => r.chunk_id);
    } catch (err) {
      console.warn('fts query failed', err instanceof Error ? err.message : err);
      return [];
    }
  })();

  const [semIds, kwIds] = await Promise.all([semantic, keyword]);
  const scores = new Map<string, number>();
  const k = 60;
  semIds.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (k + rank)));
  kwIds.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (k + rank)));
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  const chunks = await loadChunks(
    env,
    ranked.map(([id]) => id),
  );
  const hits: KnowledgeHit[] = [];
  for (const [id, score] of ranked) {
    const row = chunks.get(id);
    if (!row) continue;
    hits.push({
      chunkId: id,
      documentId: row.document_id,
      url: row.url,
      title: row.title || row.url,
      content: row.content,
      score: Math.round(score * 10000) / 10000,
    });
  }
  return hits;
}

/** Used when no AI provider is reachable: answer with the best matching snippet. */
export function extractiveAnswer(hits: KnowledgeHit[], handoffEnabled: boolean): string {
  if (!hits.length) {
    return handoffEnabled
      ? "I couldn't find an answer to that. Would you like me to connect you with our team? Just type **human**."
      : "I couldn't find an answer to that in our help content.";
  }
  const best = hits[0];
  const snippet = truncate(best.content.replace(/\s+/g, ' '), 450);
  return `Here's what I found:\n\n> ${snippet}\n\nSource: [${best.title}](${best.url})`;
}
