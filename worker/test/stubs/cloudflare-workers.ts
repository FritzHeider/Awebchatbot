// Minimal stand-in for the `cloudflare:workers` module so pure logic can be unit-tested in Node.
export class DurableObject<E = unknown> {
  ctx: unknown;
  env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
