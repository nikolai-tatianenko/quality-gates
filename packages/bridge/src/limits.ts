/** Fixed-window request counter. Returns the seconds to wait when the key is over its limit, otherwise 0. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  hit(key: string): number {
    const now = this.now();
    for (const [name, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(name);
    const window = this.windows.get(key) ?? { start: now, count: 0 };
    this.windows.set(key, window);
    window.count++;
    return window.count > this.limit ? Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)) : 0;
  }
}

/** Reads a request body up to `limit` bytes. Resolves undefined when the body is larger. */
export async function readBody(stream: AsyncIterable<Buffer | string>, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
