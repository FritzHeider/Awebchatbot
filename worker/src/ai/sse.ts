export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse a server-sent-events byte stream into events. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const flush = function* (raw: string): Generator<SseEvent> {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length) yield { event, data: dataLines.join('\n') };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/)) && match.index !== undefined) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        yield* flush(raw);
      }
    }
    if (buffer.trim()) yield* flush(buffer);
  } finally {
    reader.releaseLock();
  }
}

/** Write helper for streaming SSE responses to the widget. */
export class SseWriter {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private closed = false;
  readonly response: Response;

  constructor(headers: Record<string, string> = {}) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.writer = writable.getWriter();
    this.response = new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        ...headers,
      },
    });
  }

  async send(event: string, data: unknown): Promise<void> {
    if (this.closed) return;
    try {
      await this.writer.write(this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      this.closed = true;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer.close();
    } catch {
      // client went away
    }
  }
}
