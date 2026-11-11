import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CopyButton } from './Team.js';

export type VisualStatus = 'match' | 'changed' | 'new' | 'missing';
/** One screenshot of the latest run, as `GET /api/run/visual` lists it. */
export interface VisualItem {
  name: string; status: VisualStatus; width: number; height: number; diffPixels: number; diffRatio: number; threshold: number;
  images: { approved: boolean; current: boolean; diff: boolean };
}
export interface Visual { enabled: boolean; runId?: string; gateId?: string; baselineDir?: string; items: VisualItem[]; warning?: string }
type Mode = 'slider' | 'side' | 'diff' | 'onion';
const MODES: [Mode, string][] = [['slider', 'Slider'], ['side', 'Side by side'], ['diff', 'Diff'], ['onion', 'Onion']];
const LABELS: Record<VisualStatus, string> = { changed: 'Changed', new: 'New', missing: 'Missing', match: 'Match' };
const ORDER: VisualStatus[] = ['changed', 'new', 'missing', 'match'];

export const imageUrl = (runId: string, name: string, kind: 'approved' | 'current' | 'diff') => `/api/run/visual?run=${runId}&name=${encodeURIComponent(name)}&image=${kind}`;
/** Diff ratio as a percentage; a tiny non-zero ratio never reads as 0. */
export const percent = (ratio: number) => ratio > 0 && ratio < 0.0001 ? '<0.01%' : `${(ratio * 100).toFixed(2)}%`;
/** Blocking items first (changed, new, missing), then matches; by name inside a group. */
export const sortItems = (items: VisualItem[]) => [...items].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
/**
 * Divider position (0 to 100) after a key press, or undefined for a key the slider ignores.
 * Arrows move 1, Shift+arrow and Page keys 10, Home and End jump to the ends.
 */
export function moveSlider(key: string, shift: boolean, position: number): number | undefined {
  const step = shift ? 10 : 1;
  const next: Record<string, number> = { ArrowRight: position + step, ArrowUp: position + step, ArrowLeft: position - step, ArrowDown: position - step,
    PageUp: position + 10, PageDown: position - 10, Home: 0, End: 100 };
  return key in next ? Math.min(100, Math.max(0, next[key]!)) : undefined;
}

/**
 * The "Visual" section: every screenshot of the latest run with its status, and a viewer for the selected one.
 * It only reads. Approving a baseline is a command the person runs, so the dashboard shows it and never runs it.
 * @param visual the answer of `/api/run/visual`; nothing is rendered unless it lists items (the plugin is optional) or carries a
 * warning, which is shown as a notice so a broken visual.json is never mistaken for "no visual regression".
 */
export function VisualSection({ visual }: { visual?: Visual }) {
  if (visual?.items.length) return <VisualPanel visual={visual}/>;
  return visual?.warning ? <VisualWarning warning={visual.warning}/> : null;
}
/** The "Visual" link of the section navigation, with the number of screenshots. */
export function VisualLink({ visual }: { visual?: Visual }) {
  if (visual?.items.length) return <a href="#visual">Visual <span>{visual.items.length}</span></a>;
  return visual?.warning ? <a href="#visual">Visual</a> : null;
}
/** The reader refused the plugin's evidence: say so, as text. */
function VisualWarning({ warning }: { warning: string }) {
  return <section className="panel" id="visual" data-test-id="visual-section" aria-labelledby="visual-title">
    <div className="section-title"><div><h2 id="visual-title">Visual regression</h2><p className="section-description">The screenshots of the latest run could not be shown.</p></div></div>
    <p role="note" className="visual-notice" data-test-id="visual-warning">{warning}</p>
  </section>;
}
function VisualPanel({ visual }: { visual: Visual }) {
  const items = sortItems(visual.items);
  const [selected, setSelected] = useState<string>();
  const item = items.find(candidate => candidate.name === selected) ?? items[0]!;
  const counts = ORDER.map(status => [status, items.filter(candidate => candidate.status === status).length] as const).filter(([, count]) => count);
  const pending = items.filter(candidate => candidate.status === 'changed' || candidate.status === 'new').length;
  return <section className="panel" id="visual" data-test-id="visual-section" aria-labelledby="visual-title">
    <div className="section-title"><div><h2 id="visual-title">Visual regression</h2><p className="section-description">Screenshots of the latest run against their approved baselines.</p></div>
      <span>{visual.runId?.slice(0, 8)}</span></div>
    <div className="visual">
      <p className="visual-summary" data-test-id="visual-summary">{counts.map(([status, count]) => <span key={status} className={`pill visual-chip visual-${status}`}>{count} {LABELS[status].toLowerCase()}</span>)}</p>
      <div className="visual-layout">
        <ul className="visual-list" aria-label="Screenshots">
          {items.map(candidate => <li key={candidate.name}><button type="button" className="secondary visual-item" aria-pressed={candidate === item} data-test-id={`visual-item-${candidate.name}`} onClick={() => setSelected(candidate.name)}>
            <span className="visual-name">{candidate.name}</span>
            <span className={`pill visual-chip visual-${candidate.status}`} data-test-id={`visual-status-${candidate.name}`}>{LABELS[candidate.status]}</span>
            <span className="visual-ratio">{candidate.status === 'changed' || candidate.status === 'match' ? `${percent(candidate.diffRatio)} differs` : 'no diff'}</span></button></li>)}
        </ul>
        <Viewer key={item.name} runId={visual.runId!} item={item} baselineDir={visual.baselineDir}/>
      </div>
      <p className="muted visual-note">The dashboard never approves anything. Review the screenshots, then run the command in your project and commit the new baseline.{pending > 1 && <> <code data-test-id="visual-approve-all-command">qualitygate visual approve --all</code> approves all {pending} at once.</>}</p>
    </div>
  </section>;
}

/** What to tell the person when only one of the two images exists. */
function notice(item: VisualItem, baselineDir?: string) {
  if (item.status === 'new') return 'No approved baseline. This screenshot is new, and a missing baseline blocks the run until it is approved.';
  if (item.status === 'missing') return `No current screenshot. An approved baseline exists${baselineDir ? ` in ${baselineDir}` : ''}, but the latest run did not produce this screenshot, which blocks the run. Restore the test that takes it, or delete its baseline file.`;
  return 'Only one of the two images is stored for this item.';
}

interface View { mode: Mode; fit: boolean; onion: number }
function Viewer({ runId, item, baselineDir }: { runId: string; item: VisualItem; baselineDir?: string }) {
  const [view, setView] = useState<View>({ mode: 'slider', fit: true, onion: 50 });
  const both = item.images.approved && item.images.current;
  const change = (patch: Partial<View>) => setView({ ...view, ...patch });
  return <div className="visual-viewer" data-test-id="visual-viewer">
    <Toolbar view={view} both={both} change={change}/>
    {!both && <p role="note" className="visual-notice" data-test-id={item.status === 'new' ? 'visual-no-baseline' : 'visual-incomplete'}>{notice(item, baselineDir)}</p>}
    <div className={`visual-scroll${view.fit ? '' : ' actual'}`} tabIndex={0} role="region" aria-label={`Screenshot ${item.name}`} data-test-id="visual-scroll">
      {both ? <Comparison runId={runId} item={item} view={view}/> : <Single runId={runId} item={item} fit={view.fit}/>}
    </div>
    <p className="muted visual-facts" data-test-id="visual-facts">{item.width}×{item.height}px · {item.diffPixels} differing pixels ({percent(item.diffRatio)}) · pixel threshold {item.threshold}</p>
    {(item.status === 'changed' || item.status === 'new') && <div className="visual-approve"><span>Approve this screenshot as the new baseline, in your project:</span>
      <code data-test-id="visual-approve-command">qualitygate visual approve {item.name}</code>
      <CopyButton text={`qualitygate visual approve ${item.name}`} label="Copy approve command" testId="copy-visual-approve"/></div>}
  </div>;
}

function Toolbar({ view, both, change }: { view: View; both: boolean; change: (patch: Partial<View>) => void }) {
  return <div className="visual-toolbar">
    {both && <div role="group" aria-label="Comparison mode" className="visual-modes">
      {MODES.map(([value, label]) => <button key={value} type="button" className="secondary" aria-pressed={view.mode === value} data-test-id={`visual-mode-${value}`} onClick={() => change({ mode: value })}>{label}</button>)}</div>}
    <button type="button" className="secondary" aria-pressed={view.fit} data-test-id="visual-zoom-fit" onClick={() => change({ fit: !view.fit })}>Zoom to fit</button>
    {both && view.mode === 'onion' && <label className="visual-onion">Approved opacity {view.onion}%
      <input type="range" min={0} max={100} defaultValue={view.onion} data-test-id="visual-onion-opacity" onInput={event => change({ onion: Number(event.currentTarget.value) })}/></label>}
  </div>;
}

const Picture = ({ runId, item, kind, label, style }: { runId: string; item: VisualItem; kind: 'approved' | 'current' | 'diff'; label: string; style?: { width: number } }) =>
  <img src={imageUrl(runId, item.name, kind)} alt={`${label} screenshot of ${item.name}`} width={item.width} height={item.height} style={style} draggable={false}/>;

/** The one image that exists when there is nothing to compare (a new screenshot, or a baseline the run did not reproduce). */
function Single({ runId, item, fit }: { runId: string; item: VisualItem; fit: boolean }) {
  const kind = item.images.current ? 'current' : item.images.approved ? 'approved' : undefined;
  return kind ? <Picture runId={runId} item={item} kind={kind} label={kind === 'current' ? 'Current' : 'Approved'} style={fit ? undefined : { width: item.width }}/> : null;
}

/** The selected comparison mode. `style` makes real size (zoom off) as wide as the screenshot itself. */
function Comparison({ runId, item, view }: { runId: string; item: VisualItem; view: View }) {
  const style = view.fit ? undefined : { width: item.width };
  const picture = (kind: 'approved' | 'current' | 'diff', label: string, own?: { width: number }) => <Picture runId={runId} item={item} kind={kind} label={label} style={own}/>;
  if (view.mode === 'slider') return <Compare runId={runId} item={item} style={style}/>;
  if (view.mode === 'onion') return <div className="visual-stage" style={style}>{picture('current', 'Current')}
    <img className="visual-overlay" src={imageUrl(runId, item.name, 'approved')} alt={`Approved screenshot of ${item.name}`} style={{ opacity: view.onion / 100 }} draggable={false}/></div>;
  if (view.mode === 'side') return <div className="visual-side"><figure><figcaption>Approved</figcaption>{picture('approved', 'Approved', style)}</figure><figure><figcaption>Current</figcaption>{picture('current', 'Current', style)}</figure></div>;
  return item.images.diff ? <div className="visual-stage" style={style}>{picture('diff', 'Diff')}</div>
    : <p className="visual-notice" role="note" data-test-id="visual-no-diff">No diff image was produced for this item{item.status === 'match' ? ': it matches its baseline' : ''}.</p>;
}

/** Approved on the left, current on the right, split by a draggable divider that is also a keyboard-operable slider. */
function Compare({ runId, item, style }: { runId: string; item: VisualItem; style?: { width: number } }) {
  const [position, setPosition] = useState(50);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  function moveTo(event: PointerEvent) {
    const box = stage.current!.getBoundingClientRect();
    if (box.width > 0) setPosition(Math.min(100, Math.max(0, Math.round((event.clientX - box.left) / box.width * 100))));
  }
  function onKeyDown(event: KeyboardEvent) {
    const next = moveSlider(event.key, event.shiftKey, position);
    if (next === undefined) return;
    event.preventDefault(); setPosition(next);
  }
  return <div className="visual-stage visual-compare" ref={stage} style={style} data-test-id="visual-slider-stage"
    onPointerDown={event => { setDragging(true); event.currentTarget.setPointerCapture?.(event.pointerId); handle.current!.focus(); moveTo(event); }}
    onPointerMove={event => { if (dragging) moveTo(event); }} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)}>
    <img src={imageUrl(runId, item.name, 'current')} alt={`Current screenshot of ${item.name}`} width={item.width} height={item.height} draggable={false}/>
    <img className="visual-overlay" src={imageUrl(runId, item.name, 'approved')} alt={`Approved screenshot of ${item.name}`} style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} draggable={false}/>
    <div ref={handle} className="visual-handle" role="slider" tabIndex={0} style={{ left: `${position}%` }} data-test-id="visual-slider"
      aria-label={`Comparison divider for ${item.name}: approved on the left, current on the right`} aria-orientation="horizontal"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={position} aria-valuetext={`${position}% approved, ${100 - position}% current`} onKeyDown={onKeyDown}/>
  </div>;
}
