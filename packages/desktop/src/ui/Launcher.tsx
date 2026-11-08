import { useCallback, useEffect, useState } from 'react';
import type { HostEvent, Transport } from './transport.js';

export interface RecentView { path: string; name: string; lastOpened: string; available: boolean; reason?: string }
export interface SessionView { mode: 'launched' | 'attached'; name: string; path: string; port: number; dashboardUrl: string }
export interface HostState { recents: RecentView[]; prefs: { notifications: boolean }; recovered: boolean; session: SessionView | null }
export interface Prompt { promptId: string; mode: 'launch' | 'attach'; project: { path: string; name: string }; permissions: string[] }
export interface LastRun { runId: string; decision: string; exitCode: number }
export interface Model { state: HostState | null; prompt: Prompt | null; lastRun: LastRun | null; error: string | null; busy: boolean }
export interface Actions {
  choose(path: string, mode: 'launch' | 'attach'): void; browse(): void; accept(attach?: { port: number; code: string }): void; cancel(): void; stop(): void;
  forget(path: string): void; notifications(on: boolean): void; openFolder(kind: 'reports' | 'run', runId?: string): void; openDashboard(url: string): void;
}

function SessionPanel({ session, lastRun, actions }: { session: SessionView; lastRun: LastRun | null; actions: Actions }) {
  return (
    <section aria-label="Open project" data-test-id="desktop-session">
      <h2>Open project</h2>
      <p><strong>{session.name}</strong> <small className="muted">{session.mode === 'launched' ? 'bridge started by this app' : 'attached to an existing bridge'} on 127.0.0.1:{session.port}</small></p>
      <div className="row">
        <button type="button" data-test-id="desktop-open-dashboard" onClick={() => actions.openDashboard(session.dashboardUrl)}>Open dashboard</button>
        <button type="button" className="secondary" data-test-id="desktop-open-reports" onClick={() => actions.openFolder('reports')}>Open reports folder</button>
        <button type="button" className="secondary" data-test-id="desktop-stop" onClick={actions.stop}>Stop</button>
      </div>
      {lastRun && (
        <p data-test-id="desktop-last-run">Latest run <strong className={lastRun.exitCode === 0 ? 'pass' : 'block'}>{lastRun.decision}</strong> (exit {lastRun.exitCode}){' '}
          <button type="button" className="secondary" data-test-id="desktop-open-evidence" onClick={() => actions.openFolder('run', lastRun.runId)}>Open evidence folder</button></p>
      )}
    </section>
  );
}

function RecentList({ recents, busy, actions }: { recents: RecentView[]; busy: boolean; actions: Actions }) {
  if (!recents.length) return <p className="muted" data-test-id="desktop-no-recents">No projects yet. Choose a folder that contains a .qualitygate.yml.</p>;
  return (
    <ul className="list">
      {recents.map(item => (
        <li key={item.path} data-test-id="desktop-recent">
          <div><strong>{item.name}</strong><br /><code>{item.path}</code>{!item.available && <><br /><small className="error-text">{item.reason}</small></>}</div>
          <div className="row">
            <button type="button" disabled={!item.available || busy} data-test-id="desktop-recent-open" onClick={() => actions.choose(item.path, 'launch')}>Open</button>
            <button type="button" className="secondary" data-test-id="desktop-recent-forget" onClick={() => actions.forget(item.path)}>Forget</button>
          </div>
        </li>
      ))}
    </ul>
  );
}

interface Form { path: string; port: string; code: string }

function ChooseProject({ busy, form, setForm, actions }: { busy: boolean; form: Form; setForm(change: Partial<Form>): void; actions: Actions }) {
  const { path, port, code } = form;
  return (
    <section aria-label="Choose a project">
      <h2>Choose a project</h2>
      <label>Project folder<input type="text" value={path} onChange={event => setForm({ path: event.target.value })} placeholder="/path/to/project" data-test-id="desktop-path" /></label>
      <div className="row">
        <button type="button" className="secondary" data-test-id="desktop-browse" onClick={actions.browse}>Browse...</button>
        <button type="button" disabled={!path || busy} data-test-id="desktop-choose" onClick={() => actions.choose(path, 'launch')}>Start bridge</button>
      </div>
      <details>
        <summary>Attach to a bridge that is already running</summary>
        <label>Bridge port<input type="text" inputMode="numeric" value={port} onChange={event => setForm({ port: event.target.value })} data-test-id="desktop-port" /></label>
        <label>Pairing code<input type="text" value={code} onChange={event => setForm({ code: event.target.value })} placeholder="K7QM-4TXD" data-test-id="desktop-code" /></label>
        <button type="button" className="secondary" disabled={!path || !code || busy} data-test-id="desktop-attach" onClick={() => actions.choose(path, 'attach')}>Attach</button>
      </details>
    </section>
  );
}

function PermissionDialog({ prompt, attach, actions }: { prompt: Prompt; attach: { port: number; code: string }; actions: Actions }) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="permission-title" className="dialog" data-test-id="desktop-permission">
      <h2 id="permission-title">Allow QualityGate to use {prompt.project.name}?</h2>
      <ul>{prompt.permissions.map(line => <li key={line}>{line}</li>)}</ul>
      <div className="row">
        <button type="button" data-test-id="desktop-allow" onClick={() => actions.accept(prompt.mode === 'attach' ? attach : undefined)}>Allow</button>
        <button type="button" className="secondary" data-test-id="desktop-deny" onClick={actions.cancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Presentation only: everything it shows comes from the model and every button calls one action. */
export function LauncherView({ model, actions }: { model: Model; actions: Actions }) {
  const [form, setFormState] = useState<Form>({ path: '', port: '4180', code: '' });
  const setForm = (change: Partial<Form>) => setFormState(current => ({ ...current, ...change }));
  const { state, prompt } = model;
  return (
    <main>
      <header><h1>QualityGate</h1><span className="muted">Local projects</span></header>
      {model.error && <p role="alert" className="notice error" data-test-id="desktop-error">{model.error}</p>}
      {state?.recovered && <p className="notice info" data-test-id="desktop-recovered">The saved project list was damaged and has been reset.</p>}
      {state?.session ? <SessionPanel session={state.session} lastRun={model.lastRun} actions={actions} /> : (
        <>
          <section aria-label="Recent projects"><h2>Recent projects</h2><RecentList recents={state?.recents ?? []} busy={model.busy} actions={actions} /></section>
          <ChooseProject busy={model.busy} form={form} setForm={setForm} actions={actions} />
        </>
      )}
      <section aria-label="Notifications">
        <label className="consent"><input type="checkbox" checked={state?.prefs.notifications ?? false} onChange={event => actions.notifications(event.target.checked)} data-test-id="desktop-notifications" />
          <span>Show a desktop notification when a run finishes (PASS, BLOCK or error). Off by default.</span></label>
      </section>
      {prompt && <PermissionDialog prompt={prompt} attach={{ port: Number(form.port), code: form.code }} actions={actions} />}
    </main>
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Business logic: talks to the desktop host through the transport and keeps the model. `navigate` is injected for tests. */
export default function Launcher({ transport, navigate = (url: string) => window.location.assign(url) }: { transport: Transport; navigate?: (url: string) => void }) {
  const [model, setModel] = useState<Model>({ state: null, prompt: null, lastRun: null, error: null, busy: false });
  const patch = useCallback((change: Partial<Model>) => setModel(current => ({ ...current, ...change })), []);
  const call = useCallback(async <T,>(method: string, params?: unknown, then?: (result: T) => Partial<Model>) => {
    patch({ busy: true, error: null });
    try { const result = await transport.request<T>(method, params); patch({ busy: false, ...(then ? then(result) : {}) }); }
    catch (error) { patch({ busy: false, error: messageOf(error) }); }
  }, [transport, patch]);

  useEffect(() => {
    transport.onEvent((event: HostEvent) => {
      if (event.event === 'run') patch({ lastRun: { runId: String(event.runId), decision: String(event.decision), exitCode: Number(event.exitCode) } });
      if (event.event === 'session') {
        void transport.request<HostState>('state').then(state => patch({ state, lastRun: null, ...(typeof event.reason === 'string' ? { error: `Connection ended: ${event.reason}` } : {}) }), () => undefined);
      }
    });
    void call<HostState>('state', {}, state => ({ state }));
  }, [transport, call, patch]);

  const actions: Actions = {
    choose: (path, mode) => void call<Prompt>('project.prepare', { path, mode }, prompt => ({ prompt })),
    browse: () => void transport.pickFolder().then(chosen => { if (chosen) return call<Prompt>('project.prepare', { path: chosen, mode: 'launch' }, prompt => ({ prompt })); }, error => patch({ error: messageOf(error) })),
    accept: attach => {
      const prompt = model.prompt; if (!prompt) return;
      patch({ prompt: null });
      void call<HostState>('project.start', { promptId: prompt.promptId, accepted: true, ...attach }, state => ({ state, lastRun: null }));
    },
    cancel: () => patch({ prompt: null }),
    stop: () => void call<HostState>('project.stop', {}, state => ({ state, lastRun: null })),
    forget: path => void call<HostState>('workspace.forget', { path }, state => ({ state })),
    notifications: on => void call<HostState>('prefs.set', { notifications: on }, state => ({ state })),
    openFolder: (kind, runId) => void call('open.folder', { kind, ...(runId ? { runId } : {}) }),
    openDashboard: url => navigate(url),
  };
  return <LauncherView model={model} actions={actions} />;
}
