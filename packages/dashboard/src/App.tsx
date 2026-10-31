import { useEffect, useState } from 'react';
import type { RunResult } from '../../protocol/src/index.js';
interface Project { configPath: string; gates: { id: string; type: string; run: string }[]; urls: string[] }
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
  useEffect(() => {
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
    finally { setRunning(false); }
  }
  async function cancel() {
    try { await request('/api/cancel', 'POST'); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="shell">
    <aside><a className="brand" href="#overview"><span className="logo">Q</span>QualityGate</a>
      <span className="nav-label">WORKSPACE</span><a className="nav active" href="#overview">Overview <span>↗</span></a>
      <a className="nav" href="#findings">Findings <span>{run?.findings.length ?? 0}</span></a>
      <div className="local"><span className="dot"/> LOCAL WORKSPACE<p>Your checks. Your machine.</p></div>
    </aside>
    <main id="overview"><header><span>Workspace / <strong>Quality overview</strong></span><span className="tag">LOCAL</span></header>
      <section className="heading"><div><p className="eyebrow">QUALITY, WITH EVIDENCE</p><h1>Know what’s ready.</h1>
        <p className="muted">One verdict across your tools, your CI and your agents.</p></div>
        <div className="actions">{running && <button className="secondary" onClick={() => void cancel()}>Cancel run</button>}
          <button disabled={!project || running} onClick={() => void start()}>{running ? 'Running checks…' : 'Run quality gates ↗'}</button></div>
      </section>
      {error && <div role="alert" className="error">{error}</div>}
      <Metrics project={project} run={run}/>
      <Checks project={project} run={run} running={running}/>
      <section className="panel" id="findings"><div className="section-title"><h2>Findings & evidence</h2><span>{run ? run.runId.slice(0, 8) : 'AWAITING FIRST RUN'}</span></div>
        {!run && <div className="empty">Your next step, clearly explained.<p>Run the project’s gates to see findings and saved evidence here.</p></div>}
        {run && <RunDetails run={run}/>}
      </section>
      <footer>QualityGate · Commands run with your local permissions and are not sandboxed.</footer>
    </main>
  </div>;
}
function RunDetails({ run }: { run: RunResult }) {
  const failures = [...run.errors, ...run.gates.flatMap(g => g.errors), ...run.results.flatMap(r => [...r.errors, ...r.violations])];
  return <div className="details">
    {run.findings.map((finding, index) => <article className="finding" key={index}><span className="pill block">{finding.severity}</span><div><strong>{finding.message}</strong>
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
  return (<div className="metrics"><article><span>Latest verdict</span><strong className={run?.decision.toLowerCase()}>{run?.decision ?? 'NO RUN'}</strong><small>{run?.execution ?? 'Run checks to get a verdict'}</small></article>
        <article><span>Configured checks</span><strong>{project ? project.gates.length + project.urls.length : '—'}</strong><small>Commands + URL audits</small></article>
        <article><span>Findings</span><strong>{run?.findings.length ?? '—'}</strong><small>Locations, rules and evidence</small></article></div>);
}

function Checks({ project, run, running }: { project?: Project; run: RunResult | null; running: boolean }) {
  return (<section className="panel"><div className="section-title"><h2>Project checks</h2><span>{running ? 'IN PROGRESS' : 'DECLARED IN CONFIG'}</span></div>
        <p className="config-path">{project?.configPath ?? 'Loading project…'}</p>
        <table><thead><tr><th>CHECK</th><th>TOOL / COMMAND</th><th>RESULT</th></tr></thead><tbody>
          {project?.gates.map(gate => { const result = run?.gates.find(g => g.id === gate.id); return <tr key={gate.id}><td><strong>{gate.id}</strong><small>{gate.type}</small></td>
            <td><code className="command-inline">{gate.run}</code><details className="command-details"><summary>Show command</summary><code>{gate.run}</code></details></td><td><span className={`pill ${result?.decision.toLowerCase() ?? ''}`}>{result?.decision ?? 'PENDING'}</span>{result && <small>{result.execution} · {result.durationMs} ms</small>}</td></tr>; })}
          {project?.urls.map(url => { const result = run?.results.find(r => r.url === url); return <tr key={url}><td>Lighthouse</td><td><code>{url}</code></td><td>{result?.decision ?? 'PENDING'}</td></tr>; })}
        </tbody></table>
      </section>);
}
