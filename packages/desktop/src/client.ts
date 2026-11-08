/** The origin the desktop shell presents to the bridge; docs/BRIDGE.md lists it as an allowed Tauri origin. */
export const DESKTOP_ORIGIN = 'tauri://localhost';
export type ErrorKind = 'down' | 'unauthorized' | 'forbidden' | 'invalid' | 'not-found' | 'server';
export class DesktopBridgeError extends Error {
  constructor(readonly kind: ErrorKind, message: string) { super(message); this.name = 'DesktopBridgeError'; }
}
export type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;
/** What the desktop app reads of a run. The bridge already strips gate output and absolute paths. */
export interface RunView { runId: string; decision: 'PASS' | 'BLOCK'; exitCode: number; execution?: string; gates?: { id: string; decision?: string }[] }

const KINDS: Record<number, ErrorKind> = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not-found', 413: 'invalid', 415: 'invalid' };

/** Small typed client for the local bridge. It only talks to 127.0.0.1 and has no call that changes a verdict. */
export class DesktopClient {
  constructor(readonly port: number, private token: string | undefined, private readonly doFetch: Fetch = fetch as Fetch) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Origin: DESKTOP_ORIGIN };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.doFetch(`http://127.0.0.1:${this.port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new DesktopBridgeError('down', `The QualityGate bridge is not reachable on 127.0.0.1:${this.port}.`); }
    let data: unknown;
    try { data = JSON.parse(await response.text()); } catch { data = undefined; }
    if (response.status >= 200 && response.status < 300) return data as T;
    const detail = (data as { error?: unknown } | undefined)?.error;
    throw new DesktopBridgeError(KINDS[response.status] ?? 'server', typeof detail === 'string' ? detail : `HTTP ${response.status}`);
  }

  async ping(): Promise<void> {
    const pong = await this.call<{ name?: string }>('GET', '/v1/ping');
    if (pong?.name !== 'qualitygate-bridge') throw new DesktopBridgeError('server', `Port ${this.port} does not answer like a QualityGate bridge.`);
  }
  async pair(code: string): Promise<void> {
    const paired = await this.call<{ token?: unknown }>('POST', '/v1/pair', { code, label: 'QualityGate Desktop' });
    if (typeof paired?.token !== 'string' || !paired.token) throw new DesktopBridgeError('server', 'The bridge did not return a token.');
    this.token = paired.token;
  }
  /** The newest stored run, or `undefined` while the project has none. */
  async latestRun(): Promise<RunView | undefined> {
    try { return await this.call<RunView>('GET', '/v1/runs/latest'); }
    catch (error) { if (error instanceof DesktopBridgeError && error.kind === 'not-found') return undefined; throw error; }
  }
  async revoke(): Promise<void> { if (this.token) { await this.call('DELETE', '/v1/token'); this.token = undefined; } }
}
