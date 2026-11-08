import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { attachBridge, launchBridge, type CliCommand, type Session } from './launcher.js';
import { notificationFor, watchRuns } from './notify.js';
import { resolveFolder } from './open.js';
import { validateWorkspace, type Recent, type Validation, type WorkspaceStore } from './workspace.js';
import type { RunningDashboard } from './dashboard.js';
import type { RunView } from './client.js';

/** Every request the webview may send. `src-tauri/src/main.rs` forwards only these names; a test keeps both lists equal. */
export const HOST_METHODS = ['state', 'project.prepare', 'project.start', 'project.stop', 'prefs.set', 'workspace.forget', 'open.folder'] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

export interface HostDeps {
  store: WorkspaceStore;
  cli: CliCommand;
  assets: string;
  emit(event: Record<string, unknown>): void;
  startDashboard(configPath: string, assets: string): Promise<RunningDashboard>;
  openFolder(path: string): Promise<void>;
  launch?: typeof launchBridge;
  attach?: typeof attachBridge;
  validate?: (path: string) => Promise<Validation>;
  watch?: typeof watchRuns;
  newId?: () => string;
  /** Milliseconds between checks for a new run. */
  pollMs?: number;
}

const path = z.string().min(1).max(4096);
const schemas = {
  state: z.object({}).strict(),
  'project.prepare': z.object({ path, mode: z.enum(['launch', 'attach']) }).strict(),
  'project.start': z.object({ promptId: z.string().min(1).max(64), accepted: z.literal(true), port: z.number().int().min(1).max(65535).optional(), code: z.string().min(1).max(32).optional() }).strict(),
  'project.stop': z.object({}).strict(),
  'prefs.set': z.object({ notifications: z.boolean() }).strict(),
  'workspace.forget': z.object({ path }).strict(),
  'open.folder': z.object({ kind: z.enum(['reports', 'run']), runId: z.string().max(64).optional() }).strict(),
} satisfies Record<HostMethod, z.ZodType>;

interface Pending { mode: 'launch' | 'attach'; project: { path: string; name: string; configPath: string } }
interface Active { project: Pending['project']; session: Session; dashboard: RunningDashboard; stopWatching: AbortController }

/** What the person is asked to approve. Listed in full so the prompt matches what the app will really do. */
export function permissionsFor(mode: 'launch' | 'attach', project: { path: string }): string[] {
  const connect = mode === 'launch'
    ? `Start the QualityGate bridge for ${project.path} on 127.0.0.1 only (random port). This app reads its one-time pairing code itself.`
    : 'Connect to the bridge already running on 127.0.0.1 with the pairing code you enter. This app cannot check which project that bridge serves.';
  return [connect,
    `Serve the dashboard for ${project.path} on 127.0.0.1 so this window can show it. Runs started there execute only the gates already listed in its .qualitygate.yml, as your user.`,
    'Read run verdicts and gate names to show notifications (only when you turn them on). Gate output is never read or shown.'];
}

/** The desktop host: all project-owned logic behind a small request/response API, with the OS-facing parts injected. */
export function createHost(deps: HostDeps) {
  const launch = deps.launch ?? launchBridge; const attach = deps.attach ?? attachBridge;
  const validate = deps.validate ?? validateWorkspace; const watch = deps.watch ?? watchRuns;
  const newId = deps.newId ?? randomUUID;
  const prompts = new Map<string, Pending>();
  let active: Active | undefined;

  async function stop(reason?: string): Promise<void> {
    const current = active; active = undefined;
    if (!current) return;
    current.stopWatching.abort();
    await current.session.stop().catch(() => undefined);
    await current.dashboard.close().catch(() => undefined);
    deps.emit({ event: 'session', state: 'stopped', ...(reason ? { reason } : {}) });
  }

  async function onRun(project: Pending['project'], run: RunView): Promise<void> {
    deps.emit({ event: 'run', runId: run.runId, decision: run.decision, exitCode: run.exitCode });
    const { prefs } = await deps.store.load();
    const note = prefs.notifications ? notificationFor(project.name, run) : undefined;
    if (note) deps.emit({ event: 'notify', ...note });
  }

  async function state() {
    const loaded = await deps.store.load();
    const recents = await Promise.all(loaded.recents.map(async (item: Recent) => {
      const check = await validate(item.path);
      return { ...item, available: check.ok, ...(check.ok ? {} : { reason: check.reason }) };
    }));
    return { recents, prefs: loaded.prefs, recovered: loaded.recovered,
      session: active ? { mode: active.session.mode, name: active.project.name, path: active.project.path, port: active.session.port, dashboardUrl: active.dashboard.url } : null };
  }

  async function prepare(args: z.infer<(typeof schemas)['project.prepare']>) {
    const check = await validate(args.path);
    if (!check.ok) throw new Error(check.reason);
    const promptId = newId();
    prompts.set(promptId, { mode: args.mode, project: { path: check.path, name: check.name, configPath: check.configPath } });
    if (prompts.size > 20) prompts.delete(prompts.keys().next().value as string);
    return { promptId, mode: args.mode, project: { path: check.path, name: check.name }, permissions: permissionsFor(args.mode, check) };
  }

  async function start(args: z.infer<(typeof schemas)['project.start']>) {
    const pending = prompts.get(args.promptId);
    prompts.delete(args.promptId);
    if (!pending) throw new Error('This permission prompt is no longer valid. Choose the project again.');
    // The folder is checked again at launch: it may have changed since the prompt was shown.
    const check = await validate(pending.project.path);
    if (!check.ok) throw new Error(check.reason);
    if (pending.mode === 'attach' && (args.port === undefined || !args.code)) throw new Error('Attaching needs the bridge port and its pairing code.');
    await stop();
    const project = { path: check.path, name: check.name, configPath: check.configPath };
    const session = pending.mode === 'launch'
      ? await launch({ cli: deps.cli, configPath: check.configPath, cwd: check.path })
      : await attach(args.port as number, args.code as string);
    let dashboard: RunningDashboard;
    try { dashboard = await deps.startDashboard(check.configPath, deps.assets); } catch (error) { await session.stop().catch(() => undefined); throw error; }
    const stopWatching = new AbortController();
    active = { project, session, dashboard, stopWatching };
    await deps.store.remember(project);
    void watch(session.client, { onRun: run => void onRun(project, run), onStop: (why, text) => { if (active?.session === session) void stop(`${why}: ${text}`); } }, stopWatching.signal, { intervalMs: deps.pollMs });
    return state();
  }

  const handlers: { [M in HostMethod]: (args: z.infer<(typeof schemas)[M]>) => Promise<unknown> } = {
    state,
    'project.prepare': prepare,
    'project.start': start,
    'project.stop': async () => { await stop(); return state(); },
    'prefs.set': async args => { await deps.store.setPrefs(args); return state(); },
    'workspace.forget': async args => { await deps.store.forget(args.path); return state(); },
    'open.folder': async args => {
      if (!active) throw new Error('No project is open.');
      await deps.openFolder(await resolveFolder(active.project.configPath, args.kind, args.runId));
      return { opened: true };
    },
  };

  /** Runs one request. Unknown methods and malformed arguments are errors; nothing is evaluated or passed to a shell. */
  async function handle(method: unknown, params: unknown): Promise<unknown> {
    if (typeof method !== 'string' || !(HOST_METHODS as readonly string[]).includes(method)) throw new Error('Unknown method.');
    const name = method as HostMethod;
    const args = schemas[name].safeParse(params ?? {});
    if (!args.success) throw new Error('Invalid arguments.');
    return (handlers[name] as (a: unknown) => Promise<unknown>)(args.data);
  }
  return { handle, stop: () => stop() };
}
