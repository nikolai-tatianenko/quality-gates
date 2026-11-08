import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectedGateSchema, message, type DetectedGate } from '../../protocol/src/index.js';

type Entry = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const gateId = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/** Accepts `[...]`, `{ gates: [...] }`, `{ id: "command" }` or `{ gates: { id: { command } } }` (a results ledger). */
function entries(data: unknown): Entry[] {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' && 'gates' in data ? (data as { gates: unknown }).gates : undefined;
  if (list && typeof list === 'object' && !Array.isArray(list) && Object.values(list).every(value => value && typeof value === 'object'))
    return Object.entries(list).map(([id, value]) => ({ id, ...(value as Entry) }));
  if (Array.isArray(list)) return list.filter((item): item is Entry => !!item && typeof item === 'object');
  if (data && typeof data === 'object' && !Array.isArray(data) && Object.values(data).every(value => typeof value === 'string'))
    return Object.entries(data).map(([id, run]) => ({ id, run }));
  throw new Error('expected a list of gates, { gates: [...] } or { id: "command" }');
}

function toGate(entry: Entry): DetectedGate {
  const command = Array.isArray(entry['command']) ? entry['command'].join(' ') : (entry['command'] ?? entry['cmd']);
  const id = text(entry['id']) ?? text(entry['name']);
  const run = text(entry['run']) ?? text(command);
  if (!id || !run) throw new Error('every gate needs an id (or name) and a run (or command)');
  return detectedGateSchema.parse({ id: gateId(id), run, ...(typeof entry['timeoutMs'] === 'number' ? { timeoutMs: entry['timeoutMs'] } : {}),
    ...(entry['report'] ? { report: entry['report'] } : {}), ...(entry['artifacts'] ? { artifacts: entry['artifacts'] } : {}), ...(text(entry['fix']) ? { fix: text(entry['fix']) } : {}) });
}

/**
 * Reads gates from the project's own gate list so it is not maintained twice: a JSON file, or an ES module
 * exporting `gates` (or a default export). A module is imported, so it runs with your permissions.
 */
export async function readGatesFile(path: string): Promise<DetectedGate[]> {
  try {
    const file = resolve(path);
    const data: unknown = ['.mjs', '.js', '.cjs'].includes(extname(file))
      ? ((m: Record<string, unknown>) => m['gates'] ?? m['default'])(await import(pathToFileURL(file).href) as Record<string, unknown>)
      : JSON.parse(await readFile(file, 'utf8'));
    const gates = entries(data).map(toGate);
    if (!gates.length) throw new Error('no gates found');
    return gates;
  } catch (error) { throw new Error(`Cannot read gates from ${path}: ${message(error)}`); }
}
