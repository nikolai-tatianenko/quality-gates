/** The few Tauri globals the launcher uses (`withGlobalTauri`). Typed here so no `@tauri-apps/api` dependency is needed. */
export interface TauriGlobal {
  core: { invoke(command: string, args: Record<string, unknown>): Promise<unknown> };
  event: { listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void> };
  dialog?: { open(options: { directory: boolean; multiple: boolean; title: string }): Promise<string | string[] | null> };
}
export type HostEvent = { event: string; [key: string]: unknown };
export interface Transport {
  request<T>(method: string, params?: unknown): Promise<T>;
  onEvent(handler: (event: HostEvent) => void): void;
  pickFolder(): Promise<string | null>;
}

/** Request/response over the Rust shell: lines go out through `host_send`, replies and events come back as `host-message`. */
export function tauriTransport(tauri: TauriGlobal, timeoutMs = 120000): Transport {
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const handlers: ((event: HostEvent) => void)[] = [];
  let next = 1;
  void tauri.event.listen('host-message', ({ payload }) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(String(payload)) as Record<string, unknown>; } catch { return; }
    if (typeof message.event === 'string') { for (const handler of handlers) handler(message as HostEvent); return; }
    const entry = typeof message.id === 'number' ? waiting.get(message.id) : undefined;
    if (!entry) return;
    waiting.delete(message.id as number);
    if (message.ok === true) entry.resolve(message.result); else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'Request failed.'));
  });
  return {
    request<T>(method: string, params: unknown = {}) {
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('The desktop host did not answer in time.')); }, timeoutMs);
        waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
        tauri.core.invoke('host_send', { line: JSON.stringify({ id, method, params }) }).catch((error: unknown) => {
          clearTimeout(timer); waiting.delete(id); reject(new Error(error instanceof Error ? error.message : String(error)));
        });
      });
    },
    onEvent(handler) { handlers.push(handler); },
    async pickFolder() {
      const chosen = await tauri.dialog?.open({ directory: true, multiple: false, title: 'Choose a project folder' });
      return typeof chosen === 'string' ? chosen : null;
    },
  };
}
