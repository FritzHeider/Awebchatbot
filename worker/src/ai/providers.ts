import type { Env, ProviderName } from '../env';
import { parseSse } from './sse';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ChatTurn[];
  model?: string;
  temperature: number;
  maxTokens: number;
}

export interface Usage {
  input: number;
  output: number;
}

export interface GenerateResult {
  text: string;
  provider: ProviderName | 'extractive';
  model: string;
  usage: Usage;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
  ) {
    super(`[${provider}] ${status}: ${message}`);
  }
}

const REQUEST_TIMEOUT_MS = 45_000;

export function providerConfigured(env: Env, provider: ProviderName): boolean {
  switch (provider) {
    case 'anthropic':
      return Boolean(env.ANTHROPIC_API_KEY);
    case 'gemini':
      return Boolean(env.GEMINI_API_KEY);
    case 'xai':
      return Boolean(env.XAI_API_KEY);
    case 'openai':
      return Boolean(env.OPENAI_API_KEY);
    case 'workers-ai':
      return Boolean(env.AI);
  }
}

export function defaultModel(env: Env, provider: ProviderName): string {
  switch (provider) {
    case 'anthropic':
      return env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
    case 'gemini':
      return env.GEMINI_MODEL || 'gemini-3.6-flash';
    case 'xai':
      return env.XAI_MODEL || 'grok-4.6';
    case 'openai':
      return env.OPENAI_MODEL || 'gpt-5-mini';
    case 'workers-ai':
      return env.WORKERS_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  }
}

/** Routes through Cloudflare AI Gateway (caching, logging, rate limits, analytics) when configured. */
function gatewayBase(env: Env, slug: string): string | null {
  if (env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${slug}`;
  }
  return null;
}

function gatewayHeaders(env: Env): Record<string, string> {
  return env.AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}` } : {};
}

async function postJson(provider: string, url: string, headers: Record<string, string>, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ProviderError(provider, 0, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw new ProviderError(provider, res.status, text.slice(0, 500));
  }
  // The timer is cleared when the caller finishes reading; long streams are bounded by the Worker itself.
  clearTimeout(timer);
  return res;
}

/** Merge consecutive same-role turns and make sure the conversation starts with the user. */
export function normalizeTurns(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const turn of turns) {
    const content = turn.content.trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content += `\n\n${content}`;
    else out.push({ role: turn.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length) out.push({ role: 'user', content: 'Hello' });
  return out;
}

async function* streamAnthropic(env: Env, req: GenerateRequest, model: string, usage: Usage): AsyncGenerator<string> {
  const base = gatewayBase(env, 'anthropic') || 'https://api.anthropic.com';
  const res = await postJson(
    'anthropic',
    `${base}/v1/messages`,
    { 'x-api-key': env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', ...gatewayHeaders(env) },
    {
      model,
      system: req.system,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
    },
  );
  for await (const evt of parseSse(res.body!)) {
    let data: any;
    try {
      data = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (data.type === 'message_start') usage.input = data.message?.usage?.input_tokens ?? usage.input;
    else if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') yield data.delta.text as string;
    else if (data.type === 'message_delta') usage.output = data.usage?.output_tokens ?? usage.output;
    else if (data.type === 'error') throw new ProviderError('anthropic', 500, data.error?.message || 'stream error');
  }
}

async function* streamGemini(env: Env, req: GenerateRequest, model: string, usage: Usage): AsyncGenerator<string> {
  const base = gatewayBase(env, 'google-ai-studio') || 'https://generativelanguage.googleapis.com';
  const res = await postJson(
    'gemini',
    `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    { 'x-goog-api-key': env.GEMINI_API_KEY || '', ...gatewayHeaders(env) },
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: req.temperature, maxOutputTokens: Math.max(req.maxTokens, 1024) },
    },
  );
  for await (const evt of parseSse(res.body!)) {
    let data: any;
    try {
      data = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (data.error) throw new ProviderError('gemini', data.error.code || 500, data.error.message || 'stream error');
    const parts = data.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (typeof part.text === 'string' && !part.thought) yield part.text;
    }
    if (data.usageMetadata) {
      usage.input = data.usageMetadata.promptTokenCount ?? usage.input;
      usage.output = data.usageMetadata.candidatesTokenCount ?? usage.output;
    }
  }
}

async function* streamOpenAiCompatible(
  env: Env,
  provider: 'xai' | 'openai',
  req: GenerateRequest,
  model: string,
  usage: Usage,
): AsyncGenerator<string> {
  const isXai = provider === 'xai';
  const gateway = gatewayBase(env, isXai ? 'grok' : 'openai');
  const url = isXai
    ? `${gateway || 'https://api.x.ai'}/v1/chat/completions`
    : gateway
      ? `${gateway}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
  const key = isXai ? env.XAI_API_KEY : env.OPENAI_API_KEY;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (isXai) {
    body.max_tokens = req.maxTokens;
    body.temperature = req.temperature;
  } else {
    // Current OpenAI reasoning models only accept max_completion_tokens and the default temperature.
    body.max_completion_tokens = Math.max(req.maxTokens, 1024);
  }
  const res = await postJson(provider, url, { Authorization: `Bearer ${key || ''}`, ...gatewayHeaders(env) }, body);
  for await (const evt of parseSse(res.body!)) {
    if (evt.data === '[DONE]') break;
    let data: any;
    try {
      data = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (data.error) throw new ProviderError(provider, 500, data.error.message || 'stream error');
    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) yield delta;
    if (data.usage) {
      usage.input = data.usage.prompt_tokens ?? usage.input;
      usage.output = data.usage.completion_tokens ?? usage.output;
    }
  }
}

async function* streamWorkersAi(env: Env, req: GenerateRequest, model: string, usage: Usage): AsyncGenerator<string> {
  if (!env.AI) throw new ProviderError('workers-ai', 0, 'AI binding missing');
  let stream: unknown;
  try {
    stream = await (env.AI as any).run(
      model,
      {
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        stream: true,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      },
      env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined,
    );
  } catch (err) {
    throw new ProviderError('workers-ai', 0, err instanceof Error ? err.message : String(err));
  }
  if (!(stream instanceof ReadableStream)) {
    const text = (stream as any)?.response;
    if (typeof text === 'string') yield text;
    return;
  }
  for await (const evt of parseSse(stream as ReadableStream<Uint8Array>)) {
    if (evt.data === '[DONE]') break;
    let data: any;
    try {
      data = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (typeof data.response === 'string' && data.response) yield data.response;
    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) yield delta;
    if (data.usage) {
      usage.input = data.usage.prompt_tokens ?? usage.input;
      usage.output = data.usage.completion_tokens ?? usage.output;
    }
  }
}

export function streamProvider(
  env: Env,
  provider: ProviderName,
  req: GenerateRequest,
  model: string,
  usage: Usage,
): AsyncGenerator<string> {
  const request = { ...req, messages: normalizeTurns(req.messages) };
  switch (provider) {
    case 'anthropic':
      return streamAnthropic(env, request, model, usage);
    case 'gemini':
      return streamGemini(env, request, model, usage);
    case 'xai':
      return streamOpenAiCompatible(env, 'xai', request, model, usage);
    case 'openai':
      return streamOpenAiCompatible(env, 'openai', request, model, usage);
    case 'workers-ai':
      return streamWorkersAi(env, request, model, usage);
  }
}

export function providerChain(env: Env, primary: ProviderName, fallbacks: ProviderName[]): ProviderName[] {
  const envFallbacks = (env.FALLBACK_PROVIDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ProviderName[];
  const ordered = [primary, ...fallbacks, ...envFallbacks];
  const seen = new Set<ProviderName>();
  const chain: ProviderName[] = [];
  for (const p of ordered) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (providerConfigured(env, p)) chain.push(p);
  }
  return chain;
}

/**
 * Generate with automatic failover: if a provider fails before emitting any text the next one in the
 * chain is tried. Returns null when no provider could answer (caller falls back to extractive answers).
 */
export async function generate(
  env: Env,
  chain: ProviderName[],
  req: GenerateRequest,
  primaryModel: string | undefined,
  onDelta?: (text: string) => Promise<void> | void,
  primaryProvider?: ProviderName,
): Promise<GenerateResult | null> {
  const errors: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const model = primaryModel && provider === primaryProvider ? primaryModel : defaultModel(env, provider);
    const usage: Usage = { input: 0, output: 0 };
    let text = '';
    try {
      for await (const delta of streamProvider(env, provider, req, model, usage)) {
        text += delta;
        if (onDelta) await onDelta(delta);
      }
      if (!text.trim()) throw new ProviderError(provider, 204, 'empty response');
      if (!usage.output) usage.output = Math.ceil(text.length / 4);
      return { text, provider, model, usage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      console.warn('provider failed', provider, message);
      if (text) {
        // Partial answer already streamed: keep it rather than switching voices mid-reply.
        return { text, provider, model, usage };
      }
    }
  }
  if (errors.length) console.error('all providers failed', errors.join(' | '));
  return null;
}
