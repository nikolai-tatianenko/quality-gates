import { useEffect, useState } from 'react';
import type { RunResult } from '../../protocol/src/index.js';
import { ThemeSwitcher } from './theme.js';
import { Icon } from './Icon.js';
import { TeamView, type Team } from './Team.js';
interface Project { configPath: string; gates: { id: string; type: string; run: string }[]; urls: string[]; readOnly?: boolean }
export async function request<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(path, { method, ...(method === 'POST' ? { headers: { 'X-QualityGate-Request': '1' } } : {}) });
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body;
}
export function App() {
  const [project, setProject] = useState<Project>();
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [team, setTeam] = useState<Team>();
  const [teamError, setTeamError] = useState('');
  async function loadTeam() {
    try { setTeam(await request<Team>('/api/team')); setTeamError(''); }
    catch (error) { setTeamError(error instanceof Error ? error.message : String(error)); }
  }
  useEffect(() => {
    void loadTeam();
    let mounted = true;
    void Promise.all([request<Project>('/api/project'), request<RunResult | null>('/api/run')])
      .then(([project, run]) => { if (mounted) { setProject(project); setRun(run); } })
      .catch(error => { if (mounted) setError(String(error.message)); });
    return () => { mounted = false; };
  }, []);
  async function start() {
    setRunning(true); setError('');
    try { setRun(await request<RunResult>('/api/run', 'POST')); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setRunning(false); void loadTeam(); }
  }
  async function cancel() {
    try { await request('/api/cancel', 'POST'); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="shell">
    <aside><a className="brand" href="#overview" aria-label="QualityGate home"><span className="logo"><Icon name="shield"/></span><span className="brand-name">QualityGate<span className="brand-caption">Developer workspace</span></span></a>
      <span className="nav-label">Workspace</span><nav className="sidebar-nav" aria-label="Workspace">
        <a className="nav active" href="#overview" aria-current="page"><Icon name="overview"/>Overview</a>
        <a className="nav" href="#team"><Icon name="team"/>Team</a>
        <a className="nav" href="#engineer"><Icon name="terminal"/>Engineer</a>
        <a className="nav" href="#checks"><Icon name="checks"/>Checks</a>
        <a className="nav" href="#findings"><Icon name="findings"/>Findings <span className="nav-count">{run?.findings.length ?? 0}</span></a>
      </nav>
      <div className="local"><Icon name="terminal"/><div>Local execution<p>Your checks. Your machine.</p></div><span className="dot"/></div>
    </aside>
    <main id="overview"><header><span className="breadcrumb">Workspace <span>/</span> <strong>Overview</strong></span><div className="header-actions"><span className="tag"><span className="dot"/>Local workspace</span><ThemeSwitcher/></div></header>
      <div className="content"><section className="heading"><div><p className="eyebrow">WORKSPACE OVERVIEW</p><h1>Quality overview</h1>
        <p className="muted">Your checks, findings and release evidence, in one place.</p></div>
        <div className="actions"><a className="button-outline" href="#findings">View evidence</a>{running && <button className="secondary" onClick={() => void cancel()}>Cancel run</button>}
          {!project?.readOnly && <button className="run-checks" disabled={!project || running} onClick={() => void start()}><Icon name="play"/>{running ? 'Running checks…' : 'Run quality gates'}</button>}</div>
      </section>
      {error && <div role="alert" className="error">{error}</div>}
      <Metrics project={project} run={run}/>
      <nav className="section-nav" aria-label="Report sections"><a href="#team">Summary</a><a href="#trends">Trends</a><a href="#history">History</a><a href="#engineer">Engineer</a><a href="#checks">Checks <span>{project ? project.gates.length + project.urls.length : '—'}</span></a><a href="#findings">Findings <span>{run?.findings.length ?? 0}</span></a></nav>
      <TeamView team={team} error={teamError}/>
      <Checks project={project} run={run} running={running}/>
      <section className="panel" id="findings"><div className="section-title"><div><h2>Findings & evidence</h2><p className="section-description">The reasons behind your latest verdict.</p></div><span>{run ? run.runId.slice(0, 8) : 'AWAITING FIRST RUN'}</span></div>
        {!run && <div className="empty"><span className="empty-icon"><Icon name="findings"/></span>No findings yet.<p>Run the project’s gates to see findings and saved evidence here.</p></div>}
        {run && <RunDetails run={run}/>}
      </section>
      <footer><span>QualityGate workspace</span><span>Commands run locally and are not sandboxed.</span></footer></div>
    </main>
  </div>;
}
function RunDetails({ run }: { run: RunResult }) {
  const failures = [...run.errors, ...run.gates.flatMap(g => g.errors), ...run.results.flatMap(r => [...r.errors, ...r.violations])];
  return <div className="details">
    {run.findings.map((finding, index) => <article className="finding" key={index}><span className={`pill severity-${finding.severity}`}>{finding.severity}</span><div><strong>{finding.message}</strong>
      <p><code>{finding.file ?? finding.gateId}{finding.line ? `:${finding.line}` : ''}</code> · {finding.ruleId ?? 'tool finding'}</p>
      {finding.evidencePath && <small>Evidence: {finding.evidencePath}</small>}</div></article>)}
    {failures.map((error, index) => <pre className="error" key={index}>{error}</pre>)}
    {run.gates.filter(g => g.decision === 'BLOCK' && g.outputTail).map(g => <details key={g.id}><summary>{g.id} output</summary><pre>{g.outputTail}</pre></details>)}
    {!run.findings.length && !failures.length && <p>{run.decision === 'PASS' ? 'All configured gates passed.' : 'A gate blocked this run. Read its output for details.'}</p>}
    <div className="report"><span>Saved report</span><code>{run.reportPath ?? 'Report could not be saved'}</code>
      <a download={`qualitygate-${run.runId}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(run, null, 2))}`}>Download JSON ↗</a></div>
  </div>;
}

function Metrics({ project, run }: { project?: Project; run: RunResult | null }) {
  const verdict = run && run.execution !== 'completed' ? run.execution.toUpperCase() : run?.decision ?? 'NO RUN';
  const duration = run ? `${(Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)}s` : '—';
  return (<div className="metrics"><article><span>Latest verdict<Icon name="shield"/></span><strong className={`verdict-${verdict.toLowerCase().replaceAll(' ', '-')}`}>{verdict}</strong><small>{run?.execution ?? 'Awaiting first run'}</small></article>
        <article><span>Configured checks<Icon name="checks"/></span><strong>{project ? project.gates.length + project.urls.length : '—'}</strong><small>Commands + URL audits</small></article>
        <article><span>Findings<Icon name="findings"/></span><strong>{run?.findings.length ?? '—'}</strong><small>Locations, rules and evidence</small></article>
        <article><span>Run duration<Icon name="clock"/></span><strong>{duration}</strong><small>Latest recorded execution</small></article></div>);
}

function Checks({ project, run, running }: { project?: Project; run: RunResult | null; running: boolean }) {
  return (<section className="panel" id="checks"><div className="section-title"><div><h2>Project checks</h2><p className="section-description">Every check contributes to the same quality gate.</p></div><span>{running ? 'IN PROGRESS' : 'DECLARED IN CONFIG'}</span></div>
        <p className="config-path">{project?.configPath ?? 'Loading project…'}</p>
        <table><thead><tr><th>Check</th><th>Tool / command</th><th>Result</th></tr></thead><tbody>
          {project?.gates.map(gate => { const result = run?.gates.find(g => g.id === gate.id); return <tr key={gate.id}><td><strong>{gate.id}</strong><small>{gate.type}</small></td>
            <td><code className="command-inline">{gate.run}</code><details className="command-details"><summary>Show command</summary><code>{gate.run}</code></details></td><td><span className={`pill ${result?.decision.toLowerCase() ?? ''}`}>{result?.decision ?? 'PENDING'}</span>{result && <small>{result.execution} · {result.durationMs} ms</small>}</td></tr>; })}
          {project?.urls.map(url => { const result = run?.results.find(r => r.url === url); return <tr key={url}><td>Lighthouse</td><td><code>{url}</code></td><td>{result?.decision ?? 'PENDING'}</td></tr>; })}
        </tbody></table>
      </section>);
}
