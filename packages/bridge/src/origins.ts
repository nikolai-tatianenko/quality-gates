/** Origins that may talk to the bridge. Anything else is rejected before a token is even looked at. */
const EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
const TAURI = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
/** The web dashboard's default address (`pnpm dashboard`). */
export const DASHBOARD_ORIGIN = 'http://127.0.0.1:4173';

/** True for the origin shapes the bridge understands: a Chrome extension id, a Tauri webview or the loopback dashboard. */
export function isKnownOrigin(origin: string): boolean {
  const port = LOOPBACK.exec(origin)?.[1];
  if (port !== undefined) return Number(port) >= 1 && Number(port) <= 65535;
  return EXTENSION.test(origin) || TAURI.includes(origin);
}

/** Validates origins given on the command line. Wildcards, paths, `null` and unrelated sites are errors. */
export function parseOrigins(origins: string[]): string[] {
  for (const origin of origins) if (!isKnownOrigin(origin)) throw new Error(`Unsupported origin: ${origin}. Expected chrome-extension://<32 letters a-p>, a Tauri origin or http://127.0.0.1:<port>`);
  return [...new Set(origins)];
}

/**
 * Decides which origins may connect. The Tauri origins and the dashboard (and any `--origin` given) match exactly.
 * A Chrome extension id is not known in advance, so any well-formed id may attempt pairing unless an extension
 * was named up front; the token it receives is then pinned to that one id.
 */
export function originPolicy(extra: string[] = []): (origin: string | undefined) => boolean {
  const exact = new Set([...TAURI, DASHBOARD_ORIGIN, ...parseOrigins(extra)]);
  const pinned = [...exact].some(origin => EXTENSION.test(origin));
  return origin => !!origin && (exact.has(origin) || (!pinned && EXTENSION.test(origin)));
}
