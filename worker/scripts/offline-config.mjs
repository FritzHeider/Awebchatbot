// Generates .wrangler-offline.toml: the normal config minus the bindings that only work against
// Cloudflare's network (Workers AI, Vectorize). Lets `npm run dev:offline` run with no Cloudflare login.
// Retrieval falls back to D1 full-text search, and answers come from Claude/Gemini/Grok/OpenAI keys in
// .dev.vars (or from knowledge snippets when no key is set).
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const offline = source
  .replace(/\[\[vectorize\]\]\nbinding = "VECTORIZE"\nindex_name = "[^"]*"\n/, '')
  .replace(/\[ai\]\nbinding = "AI"\n/, '');
writeFileSync(new URL('../.wrangler-offline.toml', import.meta.url), offline);
console.log('Wrote .wrangler-offline.toml (no Workers AI / Vectorize bindings)');
