/** What the person is asked to consent to: the page the active tab shows, or the reason it cannot be scanned. */
export type Target = { ok: true; url: string; origin: string; notes: string[] } | { ok: false; reason: string };

const LOCAL = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2})$/;
const STORE_HOSTS = ['chromewebstore.google.com'];

/**
 * Decides whether a tab URL may be offered for a scan. Only plain http(s) pages qualify: browser-internal, file, data,
 * blob and extension pages, pages with credentials in the URL and the Chrome Web Store are refused. The fragment is
 * dropped. Nothing here approves a scan; the person still has to consent to the URL it returns.
 */
export function checkTarget(raw: string | undefined): Target {
  if (!raw) return { ok: false, reason: 'No page is available. Click the QualityGate toolbar icon while the page you want to scan is the active tab.' };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'The active tab has no valid address.' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `Pages that start with ${url.protocol} cannot be scanned. Only http and https pages can.` };
  if (url.username || url.password) return { ok: false, reason: 'The address contains a username or password. Open the page without credentials in the address.' };
  if (STORE_HOSTS.includes(url.hostname) || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) return { ok: false, reason: 'Chrome Web Store pages cannot be scanned.' };
  url.hash = '';
  const notes: string[] = [];
  if (LOCAL.test(url.hostname)) notes.push('This is a local or private-network address. It is opened from this machine.');
  else if (url.protocol === 'http:') notes.push('This page is not served over HTTPS.');
  if (url.search) notes.push('The address has a query string. It is sent to your local bridge and opened by the scan.');
  return { ok: true, url: url.href, origin: url.origin, notes };
}
