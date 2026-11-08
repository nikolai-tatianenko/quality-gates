import type { StorageArea } from './types.js';
import { DEFAULT_PORT } from './client.js';

/** What the popup remembers between openings. The token never leaves chrome.storage.local (not `sync`). */
export interface Saved { port: number; token?: string; lastJob?: { jobId: string; url: string } }
const KEY = 'qualitygate';

const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;

/** Reads saved state; anything malformed is ignored rather than trusted. */
export async function loadSaved(area: StorageArea): Promise<Saved> {
  const raw = (await area.get(KEY))[KEY] as Partial<Saved> | undefined;
  const saved: Saved = { port: isPort(raw?.port) ? raw.port : DEFAULT_PORT };
  if (typeof raw?.token === 'string' && raw.token) saved.token = raw.token;
  const job = raw?.lastJob;
  if (typeof job?.jobId === 'string' && typeof job.url === 'string') saved.lastJob = { jobId: job.jobId, url: job.url };
  return saved;
}
export const saveSaved = (area: StorageArea, saved: Saved) => area.set({ [KEY]: saved });
export { isPort };
