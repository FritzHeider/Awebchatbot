import { describe, expect, it } from 'vitest';
import { MarkerFilter, HANDOFF_MARKER } from '../src/ai/marker';
import { normalizeTurns } from '../src/ai/providers';
import { parseSse } from '../src/ai/sse';
import { wantsHuman } from '../src/chat';
import { normalizeLink } from '../src/crawler';
import { installCode, PLATFORMS } from '../src/install';
import { chunkText, extractiveAnswer, ftsQuery } from '../src/rag';
import { runFlow, validateFlow, type FlowStep } from '../src/scenario';
import { defaultSettings, mergeSettings, originAllowed } from '../src/workspaces';
import type { Workspace } from '../src/env';

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('Hello world, this is a short page about pricing.')).toHaveLength(1);
  });

  it('splits long text with overlap and respects the size budget', () => {
    const para = 'Sentence number one is here. '.repeat(80);
    const chunks = chunkText(`${para}\n\n${para}`, 500, 100);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(700);
  });

  it('ignores empty input', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});

describe('ftsQuery', () => {
  it('quotes terms and drops stopwords', () => {
    expect(ftsQuery('What is the price of the Pro plan?')).toBe('"price" OR "pro" OR "plan"');
  });
  it('returns null when nothing searchable remains', () => {
    expect(ftsQuery('is the a')).toBeNull();
  });
  it('neutralises FTS syntax characters', () => {
    expect(ftsQuery('foo" OR bar*')).toBe('"foo" OR "bar"');
  });
});

describe('MarkerFilter', () => {
  it('removes a marker split across deltas', () => {
    const f = new MarkerFilter(HANDOFF_MARKER);
    let out = '';
    for (const d of ['Let me get ', 'someone. [', '[HAND', 'OFF]', ']']) out += f.push(d);
    out += f.flush();
    expect(out).toBe('Let me get someone. ');
    expect(f.found).toBe(true);
  });

  it('passes through brackets that are not the marker', () => {
    const f = new MarkerFilter(HANDOFF_MARKER);
    let out = f.push('Array [[1, 2]] ok');
    out += f.flush();
    expect(out).toBe('Array [[1, 2]] ok');
    expect(f.found).toBe(false);
  });
});

describe('normalizeTurns', () => {
  it('merges same-role turns and drops leading assistant turns', () => {
    const turns = normalizeTurns([
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
    expect(turns).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
    ]);
  });
});

describe('parseSse', () => {
  it('parses events split across chunks', async () => {
    const enc = new TextEncoder();
    const parts = ['event: a\ndata: {"x":', '1}\n\n', 'data: [DONE]\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(enc.encode(p));
        controller.close();
      },
    });
    const events = [];
    for await (const e of parseSse(stream)) events.push(e);
    expect(events).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: undefined, data: '[DONE]' },
    ]);
  });
});

describe('wantsHuman', () => {
  const keywords = defaultSettings('X').handoffKeywords;
  it('detects short explicit requests', () => {
    expect(wantsHuman('human please', keywords)).toBe(true);
    expect(wantsHuman('Can I talk to a real person?', keywords)).toBe(true);
  });
  it('ignores incidental words in long questions', () => {
    expect(
      wantsHuman('How does your agent based detection work for instagram profiles with many followers and bots in them', keywords),
    ).toBe(false);
  });
  it('still catches long messages that clearly ask for a person', () => {
    expect(wantsHuman('I have tried everything on the site and nothing works so please let me speak to a human now', keywords)).toBe(true);
  });
});

describe('normalizeLink', () => {
  it('keeps same-site pages and strips tracking', () => {
    expect(normalizeLink('/pricing/?utm_source=x#top', 'https://example.com/', 'example.com')).toBe('https://example.com/pricing');
  });
  it('rejects other hosts, assets and auth pages', () => {
    expect(normalizeLink('https://other.com/a', 'https://example.com/', 'example.com')).toBeNull();
    expect(normalizeLink('/logo.png', 'https://example.com/', 'example.com')).toBeNull();
    expect(normalizeLink('/login', 'https://example.com/', 'example.com')).toBeNull();
    expect(normalizeLink('mailto:a@b.com', 'https://example.com/', 'example.com')).toBeNull();
  });
  it('treats www and apex as the same site', () => {
    expect(normalizeLink('https://www.example.com/docs', 'https://example.com/', 'example.com')).toBe('https://www.example.com/docs');
  });
});

function step(id: string, type: FlowStep['type'], content: string, config: FlowStep['config'] = {}): FlowStep {
  return { id, type, content, config, position: 0 };
}

describe('runFlow', () => {
  const steps = new Map<string, FlowStep>([
    ['s1', step('s1', 'message', 'Welcome!', { next_step_id: 's2' })],
    [
      's2',
      step('s2', 'buttons', 'What brings you here?', {
        variable: 'intent',
        options: [
          { label: 'Sales', next_step_id: 's3' },
          { label: 'Support', next_step_id: 's5' },
        ],
      }),
    ],
    ['s3', step('s3', 'collect_email', "What's your email, {{name}}?", { next_step_id: 's4' })],
    ['s4', step('s4', 'handoff', 'Thanks {{email}}, connecting you to sales.')],
    ['s5', step('s5', 'ai', 'Ask me anything!')],
  ]);

  it('runs from the start until the first wait', () => {
    const r = runFlow(steps, 's1', null, 'scn');
    expect(r.messages.map((m) => m.content)).toEqual(['Welcome!', 'What brings you here?']);
    expect(r.messages[1].buttons).toEqual(['Sales', 'Support']);
    expect(r.action).toBe('wait');
    expect(r.state.waitingStepId).toBe('s2');
  });

  it('follows a button, validates email and hands off', () => {
    const start = runFlow(steps, 's1', null, 'scn');
    const afterButton = runFlow(steps, null, start.state, 'scn', 'sales');
    expect(afterButton.state.vars.intent).toBe('Sales');
    expect(afterButton.state.waitingStepId).toBe('s3');
    const bad = runFlow(steps, null, afterButton.state, 'scn', 'not-an-email');
    expect(bad.action).toBe('wait');
    expect(bad.messages[0].content).toMatch(/valid email/);
    const good = runFlow(steps, null, bad.state, 'scn', 'a@b.co');
    expect(good.action).toBe('handoff');
    expect(good.messages[0].content).toBe('Thanks a@b.co, connecting you to sales.');
    expect(good.state.vars.email).toBe('a@b.co');
  });

  it('accepts numeric option choice', () => {
    const start = runFlow(steps, 's1', null, 'scn');
    const r = runFlow(steps, null, start.state, 'scn', '2');
    expect(r.action).toBe('ai');
    expect(r.passthrough).toBe(false);
  });

  it('passes unmatched free text to the AI by default', () => {
    const start = runFlow(steps, 's1', null, 'scn');
    const r = runFlow(steps, null, start.state, 'scn', 'How much does it cost?');
    expect(r.action).toBe('ai');
    expect(r.passthrough).toBe(true);
  });

  it('validates graphs', () => {
    expect(validateFlow([...steps.values()], 's1')).toEqual([]);
    expect(validateFlow([step('x', 'buttons', 'Pick')], 'x')[0]).toMatch(/no options/);
    expect(validateFlow([], null).length).toBe(2);
  });
});

describe('workspace settings and origins', () => {
  const ws: Workspace = {
    id: 'ws_1',
    name: 'Example',
    domain: 'example.com',
    publicKey: 'pk_x',
    allowedOrigins: ['https://partner.io', '*.preview.dev'],
    settings: { ...defaultSettings('Example'), allowLocalhost: false },
    createdAt: 0,
    updatedAt: 0,
  };
  it('allows own domain, subdomains and listed origins', () => {
    expect(originAllowed(ws, 'https://example.com')).toBe(true);
    expect(originAllowed(ws, 'https://shop.example.com')).toBe(true);
    expect(originAllowed(ws, 'https://partner.io')).toBe(true);
    expect(originAllowed(ws, 'https://a.preview.dev')).toBe(true);
    expect(originAllowed(ws, null)).toBe(true);
  });
  it('blocks other origins and localhost when disabled', () => {
    expect(originAllowed(ws, 'https://evil.com')).toBe(false);
    expect(originAllowed(ws, 'https://example.com.evil.com')).toBe(false);
    expect(originAllowed(ws, 'http://localhost:3000')).toBe(false);
  });
  it('merges settings with type checks and clamps', () => {
    const merged = mergeSettings(defaultSettings('X'), {
      temperature: 5,
      brandColor: 'red',
      provider: 'nope' as never,
      guardrails: ['a'],
      maxTokens: 10,
    });
    expect(merged.temperature).toBe(1);
    expect(merged.brandColor).toBe('#4f46e5');
    expect(merged.provider).toBe('anthropic');
    expect(merged.guardrails).toEqual(['a']);
    expect(merged.maxTokens).toBe(100);
  });
});

describe('install code', () => {
  it('produces a snippet for every platform containing the key', () => {
    for (const p of PLATFORMS) {
      const code = installCode('https://chat.example.com', 'pk_abc', p);
      expect(code.snippet).toContain('pk_abc');
      expect(code.steps.length).toBeGreaterThan(0);
    }
  });
});

describe('extractiveAnswer', () => {
  it('quotes the best hit with its source', () => {
    const text = extractiveAnswer([{ chunkId: 'c', documentId: 'd', url: 'https://x.com/a', title: 'A', content: 'Our plan costs $10.', score: 1 }], true);
    expect(text).toContain('Our plan costs $10.');
    expect(text).toContain('[A](https://x.com/a)');
  });
});
