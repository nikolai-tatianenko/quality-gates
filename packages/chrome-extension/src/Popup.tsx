import { useCallback, useEffect, useRef, useState } from 'react';
import { BridgeClient, BridgeError } from './client.js';
import { messages as t } from './messages.js';
import { watchJob, type ScanOutcome } from './scan.js';
import { isPort, loadSaved, saveSaved, type Saved } from './state.js';
import { checkTarget, type Target } from './target.js';
import type { ChromeApi, FetchLike, FindingSummary, GatesInfo, Job, Scores } from './types.js';

export const DASHBOARD_URL = 'http://127.0.0.1:4173/';
export type Phase = 'loading' | 'pair' | 'down' | 'ready' | 'scanning' | 'result';
/** Everything the view shows. The verdict inside `outcome` is the bridge's, copied unchanged. */
export interface Model {
  phase: Phase; port: number; busy: boolean; consent: boolean;
  notice?: { text: string };
  target?: Target; gates?: GatesInfo; job?: Job; scanUrl?: string; outcome?: ScanOutcome;
}
export interface Actions {
  onPair(code: string, port: string): void; onRetry(): void; onConsent(value: boolean): void;
  onScan(): void; onCancel(): void; onUnpair(): void; onNewScan(): void;
}
const CATEGORIES = ['performance', 'accessibility', 'seo', 'best-practices'] as const;

function Notice({ notice }: Pick<Model, 'notice'>) {
  return notice ? <p role="alert" className="notice error" data-test-id="notice">{notice.text}</p> : null;
}

function ScoreList({ scores, thresholds }: { scores: Scores; thresholds?: Scores }) {
  return <dl className="scores" data-test-id="scores">{CATEGORIES.map(key => {
    const min = thresholds?.[key];
    return <div key={key}><dt>{t.categories[key]}</dt><dd>{scores[key] ?? t.notMeasured}{min === undefined ? '' : <small> · {t.minimum(min)}</small>}</dd></div>;
  })}</dl>;
}

function Result({ model, actions }: { model: Model; actions: Actions }) {
  const outcome = model.outcome!;
  if (outcome.kind !== 'done') {
    const text = outcome.kind === 'cancelled' ? t.cancelled : t.failed(outcome.job.error ?? 'unknown error');
    return <><p role={outcome.kind === 'failed' ? 'alert' : 'status'} className={`notice ${outcome.kind === 'failed' ? 'error' : 'info'}`} data-test-id="outcome-note">{text}</p>
      <button type="button" onClick={actions.onNewScan} data-test-id="new-scan">{t.newScan}</button></>;
  }
  const { run, findings, artifacts } = outcome, audit = run.results[0];
  const problems = [...(audit?.violations ?? []), ...(audit?.errors ?? []), ...run.errors];
  return <>
    <section aria-labelledby="verdict-h"><h2 id="verdict-h">{t.verdict}</h2>
      <p className={`verdict ${run.decision.toLowerCase()}`} data-test-id="verdict">{run.decision} <small>{t.exitCode(run.exitCode)}</small></p></section>
    <section aria-labelledby="scores-h"><h2 id="scores-h">{t.scores}</h2><ScoreList scores={audit?.scores ?? {}} thresholds={run.thresholds}/></section>
    {problems.length > 0 && <section aria-labelledby="why-h"><h2 id="why-h">{t.violations}</h2><ul data-test-id="violations">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul></section>}
    <FindingList findings={findings}/>
    <Evidence runId={run.runId} artifacts={artifacts}/>
    <button type="button" onClick={actions.onNewScan} data-test-id="new-scan">{t.newScan}</button>
  </>;
}

function FindingList({ findings }: { findings: FindingSummary[] }) {
  return <section aria-labelledby="findings-h"><h2 id="findings-h">{t.findings}</h2>
    {findings.length === 0 ? <p className="muted">{t.noFindings}</p> : <ul data-test-id="findings">{findings.slice(0, 10).map((f, i) =>
      <li key={i}><span className={`sev ${f.severity}`}>{f.severity}</span> {f.message}{f.ruleId && <> <code>{f.ruleId}</code></>}{f.helpUrl && <> <a href={f.helpUrl} target="_blank" rel="noreferrer">docs</a></>}</li>)}</ul>}
    {findings.length > 10 && <p className="muted">+{findings.length - 10}</p>}</section>;
}

/** Links the browser result to the stored run: its id, the files it produced and the dashboard. Files are named, not uploaded. */
function Evidence({ runId, artifacts }: { runId: string; artifacts: string[] }) {
  return <section aria-labelledby="evidence-h"><h2 id="evidence-h">{t.evidence}</h2>
    <p>{t.runId}: <code data-test-id="run-id">{runId}</code></p>
    {artifacts.length > 0 && <ul>{artifacts.map(name => <li key={name}><code>{name}</code></li>)}</ul>}
    <p className="muted">{t.evidenceHelp}</p>
    <p><a className="button-outline" href={DASHBOARD_URL} target="_blank" rel="noreferrer" data-test-id="open-dashboard">{t.dashboard}</a></p>
    <p className="muted">{t.dashboardHelp}</p></section>;
}

function Ready({ model, actions }: { model: Model; actions: Actions }) {
  const { target, gates } = model;
  return <section aria-labelledby="page-h"><h2 id="page-h">{t.pageHeading}</h2>
    {target?.ok === false && <p className="notice info" role="status" data-test-id="target-refused">{target.reason}</p>}
    {target?.ok && <>
      <p className="target" data-test-id="target-url">{target.url}</p>
      {target.notes.map(note => <p key={note} className="muted">{note}</p>)}
      {gates?.scan.available === false ? <p className="notice info" role="status" data-test-id="no-scan">{t.noScan}</p> : <>
        <label className="consent"><input type="checkbox" checked={model.consent} onChange={e => actions.onConsent(e.target.checked)} data-test-id="consent"/> {t.consentLabel(target.origin)}</label>
        <p className="muted">{t.consentHelp}</p>
        <button type="button" disabled={!model.consent || model.busy} onClick={actions.onScan} data-test-id="scan">{t.scanButton}</button></>}</>}
  </section>;
}

/** Presentation only: renders a Model and reports user intent through Actions. */
export function PopupView({ model, actions }: { model: Model; actions: Actions }) {
  const [code, setCode] = useState(''), [port, setPort] = useState(String(model.port));
  const paired = ['down', 'ready', 'scanning', 'result'].includes(model.phase);
  return <main>
    <header><h1>{t.title}</h1>{paired && <button type="button" className="secondary" onClick={actions.onUnpair} data-test-id="unpair">{t.unpair}</button>}</header>
    <Notice notice={model.notice}/>
    {model.phase === 'loading' && <p role="status">{t.loading}</p>}
    {model.phase === 'pair' && <form onSubmit={e => { e.preventDefault(); actions.onPair(code, port); }} aria-labelledby="pair-h">
      <h2 id="pair-h">{t.pairHeading}</h2><p className="muted">{t.pairHelp}</p>
      <label>{t.codeLabel}<input value={code} onChange={e => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="K7QM-4TXD" data-test-id="code"/></label>
      <label>{t.portLabel}<input value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" data-test-id="port"/></label>
      <button type="submit" disabled={model.busy} data-test-id="pair">{model.busy ? t.pairing : t.pairButton}</button></form>}
    {model.phase === 'down' && <section aria-labelledby="down-h"><h2 id="down-h">{t.downHeading}</h2>
      <button type="button" onClick={actions.onRetry} data-test-id="retry">{t.retry}</button></section>}
    {model.phase === 'ready' && <Ready model={model} actions={actions}/>}
    {model.phase === 'scanning' && <section aria-live="polite"><p data-test-id="scanning">{t.scanning(model.scanUrl ?? '')}</p><p className="muted">{t.scanningHelp}</p>
      <button type="button" className="secondary" onClick={actions.onCancel} data-test-id="cancel">{t.cancel}</button></section>}
    {model.phase === 'result' && model.outcome && <Result model={model} actions={actions}/>}
  </main>;
}

const fail = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Business logic: pairing, consent, scan lifecycle and persistence. `chromeApi` and `fetchImpl` are injectable for tests. */
export default function Popup({ chromeApi, fetchImpl, intervalMs = 1000 }: { chromeApi: ChromeApi; fetchImpl?: FetchLike; intervalMs?: number }) {
  const [model, setModel] = useState<Model>({ phase: 'loading', port: 4180, busy: false, consent: false });
  const abort = useRef<AbortController | undefined>(undefined);
  const doFetch = useCallback<FetchLike>((url, init) => (fetchImpl ?? ((u, i) => fetch(u, i)))(url, init), [fetchImpl]);
  const patch = useCallback((change: Partial<Model>) => setModel(m => ({ ...m, ...change })), []);
  const storage = chromeApi.storage.local;

  /** Turns a bridge failure into the phase the person can act on. A rejected token is dropped so the pairing screen appears. */
  const handle = useCallback(async (error: unknown, saved: Saved, fallback: Phase) => {
    if (error instanceof BridgeError && error.kind === 'unauthorized') {
      await saveSaved(storage, { port: saved.port });
      patch({ phase: 'pair', busy: false, outcome: undefined, notice: { text: t.revoked } });
    } else patch({ phase: error instanceof BridgeError && error.kind === 'down' ? 'down' : fallback, busy: false, notice: { text: fail(error) } });
  }, [patch, storage]);

  const follow = useCallback(async (client: BridgeClient, saved: Saved, job: Job, url: string) => {
    abort.current = new AbortController();
    patch({ phase: 'scanning', job, scanUrl: url, busy: false });
    try {
      const outcome = await watchJob(client, job, { signal: abort.current.signal, intervalMs });
      patch({ phase: 'result', outcome, job: outcome.job, notice: undefined });
    } catch (error) { await handle(error, saved, 'ready'); }
  }, [handle, intervalMs, patch]);

  const connect = useCallback(async () => {
    const saved = await loadSaved(storage);
    patch({ phase: 'loading', port: saved.port, notice: undefined, outcome: undefined });
    const client = new BridgeClient(saved.port, saved.token, doFetch);
    try {
      // Unpaired: show the pairing form at once, whether or not a bridge answers on the default port; the port can be changed there.
      if (!saved.token) { patch({ phase: 'pair' }); return; }
      await client.ping();
      const gates = await client.gates();
      const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
      patch({ gates, target: checkTarget(tab?.url), consent: false });
      if (saved.lastJob) {
        try { await follow(client, saved, await client.job(saved.lastJob.jobId), saved.lastJob.url); return; }
        catch (error) { if (!(error instanceof BridgeError && error.kind === 'not-found')) throw error; await saveSaved(storage, { port: saved.port, token: saved.token }); }
      }
      patch({ phase: 'ready' });
    } catch (error) { await handle(error, saved, 'down'); }
  }, [chromeApi, doFetch, follow, handle, patch, storage]);

  useEffect(() => { void connect(); }, [connect]);

  const actions: Actions = {
    onRetry: () => { void connect(); },
    onConsent: consent => patch({ consent }),
    onPair: (code, portText) => { void (async () => {
      const port = Number(portText.trim());
      if (!isPort(port)) { patch({ notice: { text: `${t.portLabel}: 1-65535` } }); return; }
      if (!code.trim()) { patch({ notice: { text: `${t.codeLabel}?` } }); return; }
      patch({ busy: true, notice: undefined });
      try {
        const token = await new BridgeClient(port, undefined, doFetch).pair(code.trim(), 'Chrome extension');
        await saveSaved(storage, { port, token });
        patch({ busy: false }); await connect();
      } catch (error) { patch({ phase: 'pair', busy: false, port, notice: { text: fail(error) } }); } // a 401 here means a wrong code, not a revoked token
    })(); },
    onScan: () => { void (async () => {
      const { target, consent, port } = model;
      if (!consent || !target?.ok) return;
      const saved = await loadSaved(storage), client = new BridgeClient(port, saved.token, doFetch);
      patch({ busy: true, notice: undefined });
      try {
        const job = await client.startScan(target.url);
        await saveSaved(storage, { ...saved, lastJob: { jobId: job.jobId, url: target.url } });
        await follow(client, saved, job, target.url);
      } catch (error) { await handle(error, saved, 'ready'); }
    })(); },
    onCancel: () => abort.current?.abort(),
    onNewScan: () => { void (async () => {
      const saved = await loadSaved(storage); delete saved.lastJob;
      await saveSaved(storage, saved);
      patch({ phase: 'ready', outcome: undefined, job: undefined, consent: false });
    })(); },
    onUnpair: () => { void (async () => {
      const saved = await loadSaved(storage);
      // Revoke on the bridge first; if the bridge is down the local token is still removed.
      await new BridgeClient(saved.port, saved.token, doFetch).revoke().catch(() => undefined);
      await saveSaved(storage, { port: saved.port });
      patch({ phase: 'pair', outcome: undefined, notice: undefined, consent: false });
    })(); },
  };
  return <PopupView model={model} actions={actions}/>;
}
