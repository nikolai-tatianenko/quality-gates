import type { FetchLike, FindingSummary, GatesInfo, Job, RunSummary } from './types.js';

export type ErrorKind = 'down' | 'unauthorized' | 'forbidden' | 'conflict' | 'rate-limited' | 'invalid' | 'not-found' | 'server';
/** A bridge failure with a kind the popup can act on. `unauthorized` means the token is gone: expired, revoked or never valid. */
export class BridgeError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly status = 0) { super(message); this.name = 'BridgeError'; }
}
export const DEFAULT_PORT = 4180;
const KINDS: Record<number, ErrorKind> = { 400: 'invalid', 413: 'invalid', 415: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not-found', 409: 'conflict', 429: 'rate-limited' };

/** Thin typed client for the local bridge (docs/BRIDGE.md). It only ever talks to 127.0.0.1 and never decides a verdict. */
export class BridgeClient {
  constructor(readonly port: number, private readonly token: string | undefined, private readonly doFetch: FetchLike) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.doFetch(`http://127.0.0.1:${this.port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new BridgeError('down', `The QualityGate bridge is not reachable on 127.0.0.1:${this.port}. Start it with: qualitygate bridge`); }
    let data: unknown;
    try { data = JSON.parse(await response.text()); } catch { data = undefined; }
    if (response.status >= 200 && response.status < 300) return data as T;
    const detail = typeof (data as { error?: unknown } | undefined)?.error === 'string' ? (data as { error: string }).error : `HTTP ${response.status}`;
    throw new BridgeError(KINDS[response.status] ?? 'server', detail, response.status);
  }

  async ping(): Promise<void> {
    const pong = await this.call<{ name?: string }>('GET', '/v1/ping');
    if (pong?.name !== 'qualitygate-bridge') throw new BridgeError('server', `Port ${this.port} does not answer like a QualityGate bridge.`);
  }
  async pair(code: string, label = 'Chrome extension'): Promise<string> {
    const paired = await this.call<{ token: string }>('POST', '/v1/pair', { code, label });
    return paired.token;
  }
  revoke() { return this.call<{ revoked: boolean }>('DELETE', '/v1/token'); }
  gates() { return this.call<GatesInfo>('GET', '/v1/gates'); }
  startScan(url: string) { return this.call<Job>('POST', '/v1/scans', { url }); }
  job(id: string) { return this.call<Job>('GET', `/v1/jobs/${encodeURIComponent(id)}`); }
  cancel(id: string) { return this.call<Job>('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {}); }
  run(id: string) { return this.call<RunSummary>('GET', `/v1/runs/${encodeURIComponent(id)}`); }
  async findings(id: string) { return (await this.call<{ findings: FindingSummary[] }>('GET', `/v1/runs/${encodeURIComponent(id)}/findings`)).findings; }
  async artifacts(id: string) { return (await this.call<{ artifacts: { kind: string; name: string }[] }>('GET', `/v1/runs/${encodeURIComponent(id)}/artifacts`)).artifacts; }
}
