import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, text: string, readonly headers: Record<string, string> = {}) { super(text); }
}
/** File contents with a fixed, known content type (a screenshot); everything else binary stays an attachment. */
export class Image { constructor(readonly bytes: Buffer, readonly type = 'image/png') {} }
export type Reply = [number, unknown?];
export interface Context { req: IncomingMessage; url: URL; params: Record<string, string>; origin: string; tokenId?: string; body: string }
export interface Route { method: string; path: string[]; auth: boolean; handle: (c: Context) => Promise<Reply> }

const baseHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };

/** Validates input with a schema; a mismatch is the client's error (400) and names the offending field. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map(issue => issue.message).join('; '));
  return result.data;
}
export function parseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
/** One path segment, decoded. An encoded slash stays inside the segment, so it can never address another directory. */
export function decode(segment: string): string {
  try { return decodeURIComponent(segment); } catch { throw new HttpError(400, 'Invalid path encoding'); }
}
/** Finds the route for a method and path; an unknown path is 404 and a known path with another method is 405. */
export function matchRoute(routes: Route[], method: string, segments: string[]) {
  let pathMatched = false;
  for (const route of routes) {
    if (route.path.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const fits = route.path.every((part, i) => part.startsWith(':') ? !!(params[part.slice(1)] = segments[i]!) : part === segments[i]);
    if (!fits) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
}
/** JSON for objects, an image for screenshots, an attachment for other file contents. */
export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (body instanceof Image) { res.writeHead(status, { ...baseHeaders, ...headers, 'Content-Type': body.type }); res.end(body.bytes); return; }
  const raw = Buffer.isBuffer(body);
  res.writeHead(status, { ...baseHeaders, ...headers, 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...(raw ? { 'Content-Disposition': 'attachment' } : {}) });
  res.end(status === 204 ? undefined : raw ? body : JSON.stringify(body ?? {}));
}
