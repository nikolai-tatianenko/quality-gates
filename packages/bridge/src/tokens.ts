import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const recordSchema = z.object({ id: z.string(), hash: z.string(), origin: z.string(), label: z.string().optional(), createdAt: z.number(), expiresAt: z.number() }).strict();
const fileSchema = z.object({ schemaVersion: z.literal(1), tokens: z.array(recordSchema) }).strict();
export type TokenRecord = z.infer<typeof recordSchema>;
export interface TokenOptions { now?: () => number; tokenTtlMs?: number; pairingTtlMs?: number; maxPairAttempts?: number }
export const tokenFile = (outputDir: string) => join(outputDir, 'bridge-tokens.json');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** A short code that is easy to read aloud and type: two groups of four. 30^8 combinations, and at most five guesses. */
function newCode(): string {
  const letters = [...randomBytes(8)].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/**
 * Pairing codes and bearer tokens. A code works once, expires and dies after a few wrong guesses. A token is random,
 * bound to the one origin that paired, expires and can be revoked. Only the SHA-256 of a token is stored, in a
 * file readable by its owner alone, so the file cannot be replayed as a credential.
 */
export class TokenStore {
  private tokens = new Map<string, TokenRecord>();
  private code?: { hash: string; expiresAt: number; attempts: number };
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tokenTtlMs: number; private readonly pairingTtlMs: number; private readonly maxAttempts: number;
  constructor(readonly file: string, options: TokenOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenTtlMs = options.tokenTtlMs ?? 30 * 24 * 3600_000;
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60_000;
    this.maxAttempts = options.maxPairAttempts ?? 5;
  }
  /** Reads the token file if there is one. An unreadable or malformed file is an error, never silently an empty store. */
  async load(): Promise<void> {
    const text = await readFile(this.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) return;
    this.tokens = new Map(fileSchema.parse(JSON.parse(text)).tokens.filter(record => record.expiresAt > this.now()).map(record => [record.id, record]));
    await chmod(this.file, 0o600);
  }
  /** Starts a new pairing window; an earlier unused code stops working. */
  issueCode(): string {
    const code = newCode();
    this.code = { hash: sha256(code), expiresAt: this.now() + this.pairingTtlMs, attempts: 0 };
    return code;
  }
  /** Exchanges a valid code for a token bound to `origin`. A wrong guess counts; the code is spent on success. */
  async pair(code: string, origin: string, label?: string): Promise<{ token: string; record: TokenRecord } | undefined> {
    const current = this.code;
    if (!current || this.now() >= current.expiresAt) return undefined;
    if (!same(sha256(code.trim().toUpperCase()), current.hash)) {
      if (++current.attempts >= this.maxAttempts) this.code = undefined;
      return undefined;
    }
    this.code = undefined;
    const token = randomBytes(32).toString('base64url');
    const record: TokenRecord = { id: randomUUID(), hash: sha256(token), origin, ...(label ? { label } : {}), createdAt: this.now(), expiresAt: this.now() + this.tokenTtlMs };
    this.tokens.set(record.id, record);
    await this.save();
    return { token, record };
  }
  /** The record of a live token presented from its own origin, otherwise undefined. */
  verify(token: string, origin: string): TokenRecord | undefined {
    const hash = sha256(token);
    for (const record of this.tokens.values()) if (same(record.hash, hash)) return record.origin === origin && this.now() < record.expiresAt ? record : undefined;
    return undefined;
  }
  list(): TokenRecord[] { return [...this.tokens.values()]; }
  async revoke(id: string): Promise<boolean> {
    if (!this.tokens.delete(id)) return false;
    await this.save();
    return true;
  }
  async revokeAll(): Promise<number> {
    const count = this.tokens.size;
    this.tokens.clear();
    if (count) await this.save();
    return count;
  }
  /** Writes are queued so two pairings cannot interleave; the file is replaced atomically and is 0600 from the first byte. */
  private save(): Promise<void> {
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, tokens: this.list() }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }
}
