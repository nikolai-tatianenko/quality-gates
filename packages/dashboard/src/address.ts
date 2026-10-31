/** Only an explicitly configured local Portless origin is trusted; forwarded headers are ignored. */
export function portlessOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  const localName = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/i;
  if (!['http:', 'https:'].includes(url.protocol) || !localName.test(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('PORTLESS_URL must be an HTTP(S) named .localhost origin without credentials, query, fragment or path');
  }
  return url.origin;
}
export function dashboardHost(host: string | undefined, backendOrigin: string, publicOrigin: string): boolean {
  return host === new URL(backendOrigin).host || host === new URL(publicOrigin).host;
}
