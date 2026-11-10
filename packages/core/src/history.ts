import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { message, stepStatus, type RunResult, type StepStatus } from '../../protocol/src/index.js';

/** One gate of a recorded run. `inputsHash` exists only for gates that declare `inputs`. */
export interface HistoryGate { id: string; status: Exclude<StepStatus, 'not-run'>; durationMs: number; inputsHash?: string }
export interface HistoryRun { id: string; startedAt: string; finishedAt: string; execution: RunResult['execution']; decision: RunResult['decision']; durationMs: number; gates: HistoryGate[] }
export interface Comparison { current: string; previous: string; regressions: string[]; newFailures: string[]; fixed: string[]; slower: { id: string; previousMs: number; currentMs: number }[] }
export interface Trends {
  runs: number;
  weeks: { week: string; runs: number; blocked: number }[];
  failingGates: { id: string; failures: number; runs: number }[];
  flakyGates: { id: string; flips: number; runs: number }[];
}
/** A gate is flaky after this many PASS/BLOCK flips between two runs with an equal inputs hash; without a hash nothing proves the inputs did not change. */
const MIN_FLIPS = 2;
/** A gate is newly slow when it takes at least twice as long and at least this much longer than before. */
const SLOWER_BY_MS = 1000;
export const historyPath = (outputDir: string) => join(outputDir, 'history.sqlite');
const blocking = (status: string) => status === 'failed' || status === 'timeout' || status === 'error';
const passing = (status: string) => status === 'passed' || status === 'cached';
const executed = (status: string) => status === 'passed' || status === 'failed';

const isSqliteWarning = (warning: Error) => warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message);
let sqlite: Promise<typeof import('node:sqlite').DatabaseSync> | undefined;
/**
 * Loads `node:sqlite` on demand; its experimental-feature warning would otherwise reach every run's stderr.
 * `process.emitWarning` stays untouched: while the module loads, the 'warning' listeners are replaced by one that forwards every
 * warning except the SQLite one, and they are put back once the warning event has been dispatched (it fires on a later tick).
 */
function loadSqlite() {
  sqlite ??= (async () => {
    const listeners = process.listeners('warning');
    const forward = (warning: Error) => { if (!isSqliteWarning(warning)) for (const listener of listeners) listener.call(process, warning); };
    process.removeAllListeners('warning'); process.on('warning', forward);
    try {
      const { DatabaseSync } = await import('node:sqlite');
      await new Promise(done => setImmediate(done));
      return DatabaseSync;
    } finally { process.removeListener('warning', forward); for (const listener of listeners) process.on('warning', listener); }
  })();
  return sqlite;
}

/** Schema migrations; entry `n` upgrades the database to version `n + 1`. The version is kept in `PRAGMA user_version`. A database from before versioning has version 0 and the layout of version 1. */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, execution TEXT NOT NULL, decision TEXT NOT NULL, duration_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gates (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, position INTEGER NOT NULL, gate_id TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, inputs_hash TEXT, PRIMARY KEY (run_id, position));`,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const versionOf = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
/** Refuses a database written by a newer QualityGate: reading or changing it with an older layout could lose data. */
function assertSupported(db: DatabaseSync): number {
  const version = versionOf(db);
  if (version > SCHEMA_VERSION) throw new Error(`run history was written by a newer QualityGate (schema ${version}, this version supports ${SCHEMA_VERSION}); upgrade QualityGate or move history.sqlite aside`);
  return version;
}
/** Applies the missing migrations in one transaction, so a failed upgrade leaves the old database as it was. */
function migrate(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const from = assertSupported(db);
    for (let n = from; n < SCHEMA_VERSION; n++) db.exec(MIGRATIONS[n]!);
    if (from < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Opens the history database; a read never creates or upgrades it and returns undefined when none exists. */
async function open(outputDir: string, create: boolean): Promise<DatabaseSync | undefined> {
  if (create) await mkdir(outputDir, { recursive: true }); else if (!existsSync(historyPath(outputDir))) return undefined;
  const Database = await loadSqlite();
  const db = new Database(historyPath(outputDir));
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON');
    if (create) migrate(db); else assertSupported(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** The history record of a finished run. `hashes` maps gate id to the hash of its input files. */
export function toHistoryRun(result: RunResult, hashes: Record<string, string>): HistoryRun {
  return { id: result.runId, startedAt: result.startedAt, finishedAt: result.finishedAt, execution: result.execution, decision: result.decision,
    durationMs: Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)),
    gates: result.gates.map(g => ({ id: g.id, status: stepStatus(g) as HistoryGate['status'], durationMs: g.durationMs, ...(hashes[g.id] ? { inputsHash: hashes[g.id] } : {}) })) };
}

/** Stores one run (replacing the same run id). Throws when the database cannot be written. */
export async function recordRun(outputDir: string, run: HistoryRun): Promise<void> {
  const db = (await open(outputDir, true))!;
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
    db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run(run.id, run.startedAt, run.finishedAt, run.execution, run.decision, run.durationMs);
    const insert = db.prepare('INSERT INTO gates VALUES (?, ?, ?, ?, ?, ?)');
    for (const [position, g] of run.gates.entries()) insert.run(run.id, position, g.id, g.status, g.durationMs, g.inputsHash ?? null);
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** Narrows which runs are read. `since` is an ISO timestamp, `gates` keeps only those gates in each run (and only runs that have one of them). */
export interface HistoryFilter { since?: string; decision?: RunResult['decision']; gates?: string[] }

function runsFrom(db: DatabaseSync, rows: Record<string, string | number>[], gateIds?: string[]): HistoryRun[] {
  const gates = db.prepare('SELECT * FROM gates WHERE run_id = ? ORDER BY position');
  return rows.map(row => ({ id: String(row.id), startedAt: String(row.started_at), finishedAt: String(row.finished_at),
    execution: row.execution as HistoryRun['execution'], decision: row.decision as HistoryRun['decision'], durationMs: Number(row.duration_ms),
    gates: (gates.all(String(row.id)) as Record<string, string | number | null>[]).filter(g => !gateIds || gateIds.includes(String(g.gate_id))).map(g => ({ id: String(g.gate_id), status: g.status as HistoryGate['status'],
      durationMs: Number(g.duration_ms), ...(g.inputs_hash ? { inputsHash: String(g.inputs_hash) } : {}) })) }));
}

/** The most recent runs matching the filter, newest first. Throws when the database is unreadable or newer than this version. */
export async function readRuns(outputDir: string, limit: number, filter: HistoryFilter = {}): Promise<HistoryRun[]> {
  const db = await open(outputDir, false);
  if (!db) return [];
  try {
    const where: string[] = []; const params: (string | number)[] = [];
    if (filter.since) { where.push('started_at >= ?'); params.push(filter.since); }
    if (filter.decision) { where.push('decision = ?'); params.push(filter.decision); }
    if (filter.gates?.length) { where.push(`EXISTS (SELECT 1 FROM gates WHERE gates.run_id = runs.id AND gate_id IN (${filter.gates.map(() => '?').join(', ')}))`); params.push(...filter.gates); }
    const rows = db.prepare(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(...params, limit) as Record<string, string | number>[];
    return runsFrom(db, rows, filter.gates?.length ? filter.gates : undefined);
  } finally { db.close(); }
}

/** One run by id, or undefined when there is none. `gates` keeps only those gates. */
export async function readRun(outputDir: string, id: string, gates?: string[]): Promise<HistoryRun | undefined> {
  const db = await open(outputDir, false);
  if (!db) return undefined;
  try {
    return runsFrom(db, db.prepare('SELECT * FROM runs WHERE id = ?').all(id) as Record<string, string | number>[], gates?.length ? gates : undefined)[0];
  } finally { db.close(); }
}

/** A regression is a gate that passed in the previous run and blocks now; a new failure is any gate that blocks now and did not block before. */
export function compareRuns(current: HistoryRun, previous: HistoryRun): Comparison {
  const before = new Map(previous.gates.map(g => [g.id, g]));
  const diff: Comparison = { current: current.id, previous: previous.id, regressions: [], newFailures: [], fixed: [], slower: [] };
  for (const g of current.gates) {
    const was = before.get(g.id);
    if (blocking(g.status) && !(was && blocking(was.status))) {
      diff.newFailures.push(g.id);
      if (was && passing(was.status)) diff.regressions.push(g.id);
    }
    if (passing(g.status) && was && blocking(was.status)) diff.fixed.push(g.id);
    if (was && executed(g.status) && executed(was.status) && g.durationMs >= was.durationMs * 2 && g.durationMs - was.durationMs >= SLOWER_BY_MS) {
      diff.slower.push({ id: g.id, previousMs: was.durationMs, currentMs: g.durationMs });
    }
  }
  return diff;
}

/** Monday (UTC) of the week a timestamp falls in. */
function weekOf(timestamp: string): string {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

/** Trends over recorded runs given newest first. Skipped, interrupted and cached outcomes say nothing about a gate and are ignored. */
export function trends(newestFirst: HistoryRun[]): Trends {
  const weeks = new Map<string, { runs: number; blocked: number }>();
  const outcomes = new Map<string, { blocked: boolean; hash?: string }[]>();
  for (const run of [...newestFirst].reverse()) {
    const week = weeks.get(weekOf(run.startedAt)) ?? { runs: 0, blocked: 0 };
    week.runs++; if (run.decision === 'BLOCK') week.blocked++;
    weeks.set(weekOf(run.startedAt), week);
    for (const g of run.gates) {
      if (!blocking(g.status) && g.status !== 'passed') continue;
      outcomes.set(g.id, [...outcomes.get(g.id) ?? [], { blocked: blocking(g.status), hash: g.inputsHash }]);
    }
  }
  const failingGates: Trends['failingGates'] = []; const flakyGates: Trends['flakyGates'] = [];
  for (const [id, list] of outcomes) {
    const failures = list.filter(o => o.blocked).length;
    if (failures) failingGates.push({ id, failures, runs: list.length });
    const flips = list.filter((o, i) => i > 0 && o.blocked !== list[i - 1]!.blocked && o.hash !== undefined && o.hash === list[i - 1]!.hash).length;
    if (flips >= MIN_FLIPS) flakyGates.push({ id, flips, runs: list.length });
  }
  const byName = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return { runs: newestFirst.length, weeks: [...weeks].map(([week, w]) => ({ week, ...w })).sort((a, b) => a.week.localeCompare(b.week)),
    failingGates: failingGates.sort((a, b) => b.failures - a.failures || byName(a, b)), flakyGates: flakyGates.sort((a, b) => b.flips - a.flips || byName(a, b)) };
}

/** Trends over the last `limit` runs, or undefined when there is no history. An unreadable database is reported through `warn`, never thrown. */
export async function readTrends(outputDir: string, limit: number, warn: (text: string) => void): Promise<Trends | undefined> {
  try {
    const runs = await readRuns(outputDir, limit);
    return runs.length ? trends(runs) : undefined;
  } catch (error) { warn(`run history unreadable (${message(error)}); trends omitted`); return undefined; }
}
