import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopClient, RunView } from '../packages/desktop/src/client.js';
import { createHost, HOST_METHODS, permissionsFor, type HostDeps } from '../packages/desktop/src/host.js';
import type { Session } from '../packages/desktop/src/launcher.js';
import type { WatchEvents } from '../packages/desktop/src/notify.js';
import { CONFIG_NAME, WorkspaceStore } from '../packages/desktop/src/workspace.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const temp = () => mkdtemp(join(tmpdir(), 'qg-desktop-host-'));
async function project(name = 'app') {
  const dir = join(await temp(), name);
  await mkdir(join(dir, 'out', RUN_ID), { recursive: true });
  await writeFile(join(dir, CONFIG_NAME), JSON.stringify({ schemaVersion: 1, outputDir: 'out', gates: [{ id: 'ok', run: 'true' }] }));
  return dir;
}

function setup(overrides: Partial<HostDeps> = {}) {
  const log = { events: [] as Record<string, unknown>[], launched: [] as unknown[], attached: [] as unknown[], stopped: [] as string[], dashboards: 0, closed: 0, opened: [] as string[],
    watchers: [] as { events: WatchEvents; signal: AbortSignal }[] };
  let n = 0;
  const makeSession = (mode: 'launched' | 'attached', port: number): Session => ({ mode, port, client: {} as DesktopClient, stop: async () => { log.stopped.push(`${mode}:${port}`); } });
  const deps: HostDeps = {
    store: new WorkspaceStore(''), cli: { command: 'node', args: ['cli.mjs'] }, assets: '/assets', emit: event => log.events.push(event),
    startDashboard: async () => { log.dashboards++; return { url: `http://127.0.0.1:${5000 + log.dashboards}/`, close: async () => { log.closed++; } }; },
    openFolder: async path => { log.opened.push(path); },
    launch: async options => { log.launched.push(options); return makeSession('launched', 4100 + log.launched.length); },
    attach: async (port, code) => { log.attached.push([port, code]); return makeSession('attached', port); },
    watch: async (_client, events, signal) => { log.watchers.push({ events, signal }); },
    newId: () => `prompt-${++n}`, ...overrides,
  };
  return { log, deps };
}
async function ready(overrides: Partial<HostDeps> = {}) {
  const dataDir = await temp();
  const parts = setup({ store: new WorkspaceStore(join(dataDir, 'workspaces.json')), ...overrides });
  return { ...parts, host: createHost(parts.deps), dir: await project() };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 5)); };
const start = async (host: ReturnType<typeof createHost>, dir: string, mode: 'launch' | 'attach' = 'launch', extra: object = {}) => {
  const prompt = await host.handle('project.prepare', { path: dir, mode }) as { promptId: string };
  return host.handle('project.start', { promptId: prompt.promptId, accepted: true, ...extra }) as Promise<{ session: { name: string; port: number; mode: string; dashboardUrl: string } | null; recents: { path: string; available: boolean; reason?: string }[] }>;
};

test('nothing starts without a prepared prompt that was accepted; a prompt is single use', async () => {
  const { host, log, dir } = await ready();
  const prompt = await host.handle('project.prepare', { path: dir, mode: 'launch' }) as { promptId: string; permissions: string[]; project: { name: string } };
  assert.equal(prompt.project.name, 'app'); assert.equal(prompt.permissions.length, 3);
  assert.match(prompt.permissions[0]!, /127\.0\.0\.1 only/);
  await assert.rejects(host.handle('project.start', { promptId: prompt.promptId }), /Invalid arguments/);
  await assert.rejects(host.handle('project.start', { promptId: prompt.promptId, accepted: false }), /Invalid arguments/);
  await assert.rejects(host.handle('project.start', { promptId: 'forged', accepted: true }), /no longer valid/);
  assert.equal(log.launched.length, 0);
  const state = await host.handle('project.start', { promptId: prompt.promptId, accepted: true }) as { session: { name: string } };
  assert.equal(state.session.name, 'app');
  await assert.rejects(host.handle('project.start', { promptId: prompt.promptId, accepted: true }), /no longer valid/);
  assert.equal(log.launched.length, 1);
});

test('a launch uses the validated config, starts the shared dashboard, remembers the project and watches for runs', async () => {
  const { host, log, dir } = await ready();
  const state = await start(host, dir);
  assert.equal(state.session?.mode, 'launched'); assert.equal(state.session?.dashboardUrl, 'http://127.0.0.1:5001/');
  const options = log.launched[0] as { cli: object; configPath: string; cwd: string };
  assert.ok(options.configPath.endsWith(CONFIG_NAME)); assert.equal(options.cwd, options.configPath.slice(0, -CONFIG_NAME.length - 1));
  assert.equal(state.recents.length, 1); assert.equal(state.recents[0]!.available, true);
  assert.equal(log.watchers.length, 1);
  assert.equal(((await host.handle('state', {})) as { session: unknown }).session !== null, true);
});

test('attaching needs a port and a code and is prompted like a launch', async () => {
  const { host, log, dir } = await ready();
  const prompt = await host.handle('project.prepare', { path: dir, mode: 'attach' }) as { promptId: string; permissions: string[] };
  assert.match(prompt.permissions[0]!, /cannot check which project/);
  await assert.rejects(host.handle('project.start', { promptId: prompt.promptId, accepted: true }), /needs the bridge port and its pairing code/);
  const state = await start(host, dir, 'attach', { port: 4180, code: 'K7QM-4TXD' });
  assert.deepEqual(log.attached, [[4180, 'K7QM-4TXD']]); assert.equal(state.session?.mode, 'attached'); assert.equal(log.launched.length, 0);
});

test('the folder is checked again when the prompt is accepted', async () => {
  const { host, log, dir } = await ready();
  const prompt = await host.handle('project.prepare', { path: dir, mode: 'launch' }) as { promptId: string };
  await rm(join(dir, CONFIG_NAME));
  await assert.rejects(host.handle('project.start', { promptId: prompt.promptId, accepted: true }), /No \.qualitygate\.yml/);
  await assert.rejects(host.handle('project.prepare', { path: dir, mode: 'launch' }), /No \.qualitygate\.yml/);
  assert.equal(log.launched.length, 0);
});

test('when the dashboard cannot start, the bridge it needed is stopped again', async () => {
  const { host, log, dir } = await ready({ startDashboard: async () => { throw new Error('port busy'); } });
  await assert.rejects(start(host, dir), /port busy/);
  assert.deepEqual(log.stopped, ['launched:4101']);
  assert.equal(((await host.handle('state', {})) as { session: unknown }).session, null);
});

test('notifications are opt-in; run events are always sent to the window', async () => {
  const { host, log, dir } = await ready();
  await start(host, dir);
  const run: RunView = { runId: RUN_ID, decision: 'BLOCK', exitCode: 1, gates: [{ id: 'lint', decision: 'BLOCK' }] };
  const watcher = log.watchers[0]!;
  watcher.events.onRun(run);
  await until(() => log.events.length > 0); await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(log.events.map(e => e.event), ['run']);
  await host.handle('prefs.set', { notifications: true });
  watcher.events.onRun(run);
  await until(() => log.events.some(e => e.event === 'notify'));
  const notify = log.events.find(e => e.event === 'notify');
  assert.deepEqual(notify, { event: 'notify', kind: 'block', runId: RUN_ID, title: 'app: BLOCK', body: 'Blocked by lint.' });
  log.events.length = 0;
  watcher.events.onRun({ runId: RUN_ID, decision: 'BLOCK', exitCode: 130 });
  await until(() => log.events.length > 0); await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(log.events.map(e => e.event), ['run'], 'an interrupted run is shown but not announced');
});

test('a lost bridge ends the session with a reason; a stale watcher of a replaced session is ignored', async () => {
  const { host, log, dir } = await ready();
  await start(host, dir);
  log.watchers[0]!.events.onStop('down', 'gone');
  await until(() => log.events.some(e => e.event === 'session'));
  assert.deepEqual(log.events.at(-1), { event: 'session', state: 'stopped', reason: 'down: gone' });
  assert.equal(log.closed, 1); assert.equal(log.watchers[0]!.signal.aborted, true);
  await start(host, dir);
  const second = await project('other');
  await start(host, second);
  assert.equal(log.stopped.length, 2, 'starting a project stops the previous one');
  log.events.length = 0;
  log.watchers[1]!.events.onStop('down', 'late');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(log.events.length, 0);
});

test('stop, forget, preferences and the recent list with a vanished project', async () => {
  const { host, log, dir } = await ready();
  const other = await project('other');
  await start(host, dir); await start(host, other);
  assert.deepEqual((await host.handle('project.stop', {}) as { session: unknown }).session, null);
  await host.handle('project.stop', {});
  assert.equal(log.events.filter(e => e.event === 'session').length >= 2, true);
  await rm(join(dir, CONFIG_NAME));
  const state = await host.handle('state', {}) as { recents: { path: string; name: string; available: boolean; reason?: string }[]; prefs: { notifications: boolean } };
  assert.deepEqual(state.recents.map(r => [r.name, r.available]), [['other', true], ['app', false]]);
  assert.match(state.recents[1]!.reason!, /No \.qualitygate\.yml/);
  assert.equal((await host.handle('prefs.set', { notifications: true }) as typeof state).prefs.notifications, true);
  assert.equal((await host.handle('workspace.forget', { path: state.recents[1]!.path }) as typeof state).recents.length, 1);
  await host.stop();
});

test('evidence and report folders open only for the open project and only through the safe resolver', async () => {
  const { host, log, dir } = await ready();
  await assert.rejects(host.handle('open.folder', { kind: 'reports' }), /No project is open/);
  await start(host, dir);
  await host.handle('open.folder', { kind: 'reports' });
  await host.handle('open.folder', { kind: 'run', runId: RUN_ID });
  assert.equal(log.opened.length, 2); assert.ok(log.opened[1]!.endsWith(`out/${RUN_ID}`) || log.opened[1]!.endsWith(`out\\${RUN_ID}`));
  await assert.rejects(host.handle('open.folder', { kind: 'run', runId: '../..' }), /Invalid run id/);
  await assert.rejects(host.handle('open.folder', { kind: 'run', path: '/etc' }), /Invalid arguments/);
  assert.equal(log.opened.length, 2);
});

test('requests are validated: unknown methods, extra fields and wrong types are errors', async () => {
  const { host } = await ready();
  for (const method of [undefined, 5, 'shell.exec', 'constructor', '__proto__']) await assert.rejects(host.handle(method, {}), /Unknown method/);
  await assert.rejects(host.handle('state', { extra: 1 }), /Invalid arguments/);
  await assert.rejects(host.handle('project.prepare', { path: '/x', mode: 'run' }), /Invalid arguments/);
  await assert.rejects(host.handle('project.start', { promptId: 'p', accepted: true, port: 70000 }), /Invalid arguments/);
  await assert.rejects(host.handle('prefs.set', { notifications: 'yes' }), /Invalid arguments/);
  assert.deepEqual([...HOST_METHODS], ['state', 'project.prepare', 'project.start', 'project.stop', 'prefs.set', 'workspace.forget', 'open.folder']);
  assert.ok(await host.handle('state', undefined));
});

test('old prompts are dropped so the table cannot grow without bound', async () => {
  const { host, dir } = await ready();
  const first = await host.handle('project.prepare', { path: dir, mode: 'launch' }) as { promptId: string };
  for (let i = 0; i < 20; i++) await host.handle('project.prepare', { path: dir, mode: 'launch' });
  await assert.rejects(host.handle('project.start', { promptId: first.promptId, accepted: true }), /no longer valid/);
  assert.match(permissionsFor('launch', { path: '/p' })[1]!, /\/p/);
});

test('the default launcher, watcher, validator and id source are used when none are injected', async () => {
  const dataDir = await temp();
  const { deps } = setup({ store: new WorkspaceStore(join(dataDir, 'w.json')) });
  const { launch, attach, watch, newId, ...rest } = deps;
  void launch; void attach; void watch; void newId;
  const host = createHost(rest);
  const dir = await project();
  const prompt = await host.handle('project.prepare', { path: dir, mode: 'launch' }) as { promptId: string };
  assert.match(prompt.promptId, /^[0-9a-f-]{36}$/);
  await assert.rejects(host.handle('project.start', { promptId: prompt.promptId, accepted: true }), /could not be started|exited before|not reachable|ENOENT/);
});
