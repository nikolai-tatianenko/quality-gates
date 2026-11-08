import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';
import type { DetectedGate } from '../../../protocol/src/index.js';
import { exists, execPrefix, packageManager, readJson, type Manager } from './shared.js';

const wanted = [
  { id: 'lint', scripts: ['lint'] },
  { id: 'typecheck', scripts: ['typecheck', 'type-check', 'check-types'] },
  { id: 'tests', scripts: ['test:ci', 'test'], timeoutMs: 300000 },
];
const ESLINT_REPORT = '.qualitygate/node/eslint.json';
const JUNIT_REPORT = '.qualitygate/node/junit.xml';
/** More test files than this will probably not finish inside the default 300 s gate timeout. */
const LARGE_RUN_FILES = 300;
const LARGE_RUN_TIMEOUT_MS = 1800000;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.qualitygate', '.next', '.turbo']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Scripts made of one plain command: anything with shell operators is left alone. */
const PLAIN_COMMAND = /^[^&|;<>$`()]+$/;

type Scripts = Record<string, string>;
interface Manifest { scripts?: Scripts; packageManager?: unknown; workspaces?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** Why a `test:*` script is listed but not enabled, from its name. */
export function skipReason(name: string): string {
  if (/watch/i.test(name)) return 'watch mode never exits';
  if (/android|ios|mobile|detox|maestro|simulator|emulator/i.test(name)) return 'needs an emulator or simulator';
  if (/e2e|playwright|cypress|browser|visual|ui/i.test(name)) return 'needs a browser and is slow';
  return 'extra test script: enable it if it should block the run';
}

/** Directories of the workspace packages named by `pnpm-workspace.yaml` or `workspaces` (patterns `dir/*` and plain dirs). */
async function workspaceDirectories(directory: string, manifest: Manifest): Promise<string[]> {
  let patterns: unknown;
  if (await exists(join(directory, 'pnpm-workspace.yaml'))) patterns = (parse(await readFile(join(directory, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: unknown } | null)?.packages;
  else patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces as { packages?: unknown } | undefined)?.packages;
  const found: string[] = [];
  for (const pattern of Array.isArray(patterns) ? patterns.filter((item): item is string => typeof item === 'string') : []) {
    if (pattern.startsWith('!')) continue;
    const base = pattern.replace(/\/\*\*?$/, '');
    if (base === pattern) { found.push(base); continue; }
    const entries = await readdir(join(directory, base), { withFileTypes: true }).catch(() => []);
    found.push(...entries.filter(entry => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)).map(entry => `${base}/${entry.name}`));
  }
  return found;
}

/** Script names defined by at least one workspace package. */
async function workspaceScripts(directory: string, manifest: Manifest): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of await workspaceDirectories(directory, manifest)) {
    const pkg = await readJson(join(directory, dir, 'package.json')).catch(() => undefined) as Manifest | undefined;
    for (const name of Object.keys(pkg?.scripts ?? {})) names.add(name);
  }
  return names;
}

/** Counts test files without descending into dependency or build folders; stops early once the answer is clear. */
export async function countTestFiles(directory: string, limit = LARGE_RUN_FILES * 4): Promise<number> {
  let count = 0; const pending = [directory];
  while (pending.length && count < limit) {
    const entries = await readdir(pending.pop()!, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) pending.push(join(entry.parentPath ?? directory, entry.name));
      else if (entry.isFile() && TEST_FILE.test(entry.name)) count++;
    }
  }
  return count;
}

/** `eslint .` becomes an eslint-json report; the exit code still decides, the report adds file and line to findings. */
function withEslintReport(script: string, manager: Manager): Pick<DetectedGate, 'run' | 'report' | 'fix'> | undefined {
  const match = /^\s*eslint(\s+.*)?$/.exec(script);
  if (!match || !PLAIN_COMMAND.test(script) || /\s(-f|--format|-o|--output-file)\b/.test(script)) return undefined;
  const args = match[1] ?? ' .';
  // A script that already passes --fix repairs files on every run; there is nothing more for a separate fix command to add.
  const fix = /\s--fix\b/.test(args) ? undefined : `${execPrefix(manager)} eslint${args} --fix`;
  return { run: `${execPrefix(manager)} eslint${args} --format json --output-file ${ESLINT_REPORT}`, report: { format: 'eslint-json', path: ESLINT_REPORT }, ...(fix ? { fix } : {}) };
}

/** `vitest` and `node --test` get a JUnit report next to their normal console output. */
function withJunitReport(script: string, manager: Manager): Pick<DetectedGate, 'run' | 'report'> | undefined {
  if (!PLAIN_COMMAND.test(script) || /--(reporter|test-reporter)\b|--watch\b/.test(script)) return undefined;
  const report = { format: 'junit', path: JUNIT_REPORT };
  const vitest = /^\s*vitest(?:\s+run)?(\s+.*)?$/.exec(script);
  if (vitest) return { run: `${execPrefix(manager)} vitest run${vitest[1] ?? ''} --reporter=default --reporter=junit --outputFile.junit=${JUNIT_REPORT}`, report };
  if (/^\s*node\s(?:.*\s)?--test(?:\s|$)/.test(script))
    return { run: `mkdir -p .qualitygate/node && ${script.trim().replace(/--test(?=\s|$)/, `--test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${JUNIT_REPORT}`)}`, report };
  return undefined;
}

const AUDIT_REPORT = '.qualitygate/node/audit.json';
const OSV_REPORT = '.qualitygate/node/osv.json';
const LOCKFILES: Record<Manager, string> = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' };

interface Layout { scripts: Scripts; manager: Manager; inWorkspace: Set<string> }

/** The run command for a script: the root script, or every workspace package that defines it. */
function scriptCommand(layout: Layout, name: string): string | undefined {
  if (name in layout.scripts) return `${layout.manager} run ${name}`;
  if (!layout.inWorkspace.has(name)) return undefined;
  return layout.manager === 'pnpm' ? `pnpm -r --if-present run ${name}` : layout.manager === 'npm' ? `npm run ${name} --workspaces --if-present` : undefined;
}

function proposeWanted(layout: Layout): DetectedGate[] {
  return wanted.flatMap(({ id, scripts: names, timeoutMs }): DetectedGate[] => {
    const name = names.find(candidate => scriptCommand(layout, candidate));
    if (!name) return [];
    const reported: Partial<Pick<DetectedGate, 'run' | 'report' | 'fix'>> | undefined = name in layout.scripts && id !== 'typecheck' ? (id === 'lint' ? withEslintReport : withJunitReport)(layout.scripts[name]!, layout.manager) : undefined;
    return [{ id, run: reported?.run ?? scriptCommand(layout, name)!, ...(reported?.report ? { report: reported.report } : {}), ...(reported?.fix ? { fix: reported.fix } : {}), ...(timeoutMs ? { timeoutMs } : {}) }];
  });
}

/** Other `test:*` scripts are listed as found but not enabled, with the reason. */
function proposeExtras(layout: Layout, enabled: DetectedGate[]): DetectedGate[] {
  const used = new Set(enabled.map(gate => gate.run));
  return Object.keys(layout.scripts).filter(name => name.startsWith('test:') && name !== 'test:ci' && !used.has(`${layout.manager} run ${name}`))
    .map(name => ({ id: name.replaceAll(':', '-').toLowerCase().replace(/[^a-z0-9_-]/g, '-'), run: `${layout.manager} run ${name}`, skip: skipReason(name) }));
}

/** A dependency audit is listed but not enabled: it needs the network and fails on any known advisory. npm has its own audit; pnpm and yarn reports differ, so osv-scanner reads their lockfiles. */
async function proposeAudit(directory: string, manager: Manager): Promise<DetectedGate[]> {
  const lockfile = LOCKFILES[manager];
  if (!await exists(join(directory, lockfile))) return [];
  const reported = '> ' + (manager === 'npm' ? AUDIT_REPORT : OSV_REPORT);
  if (manager === 'npm') return [{ id: 'audit', run: `mkdir -p .qualitygate/node && npm audit --json ${reported}`, report: { format: 'npm-audit', path: AUDIT_REPORT },
    skip: 'dependency audit needs the network and blocks on any known advisory: enable it if it should block' }];
  return [{ id: 'audit', run: `mkdir -p .qualitygate/node && osv-scanner scan source --format json -L ${lockfile} ${reported}`, report: { format: 'osv-scanner', path: OSV_REPORT },
    skip: 'dependency audit needs osv-scanner v2 on PATH and blocks on any known advisory: enable it if it should block' }];
}

/** A vitest config without a test script still means there are tests to run. */
async function proposeVitest(directory: string, layout: Layout): Promise<DetectedGate[]> {
  if (!(await readdir(directory)).some(name => /^vitest(\.[\w-]+)?\.config\.[cm]?[jt]s$/.test(name))) return [];
  const reported = withJunitReport('vitest run', layout.manager)!;
  return [{ id: 'tests', run: reported.run!, report: reported.report, timeoutMs: 300000 }];
}

/** A run over hundreds of test files gets a long timeout and a warning, so it does not end as a surprise timeout. */
async function warnLargeRun(directory: string, gates: DetectedGate[]): Promise<DetectedGate[]> {
  if (!gates.some(gate => gate.id === 'tests')) return gates;
  const files = await countTestFiles(directory);
  if (files <= LARGE_RUN_FILES) return gates;
  const note = `${files}+ test files will probably not finish within the default 300 s; the tests gate gets a 30 minute timeout. Consider a faster subset (changed packages only) with --changed and inputs.`;
  return gates.map(gate => gate.id === 'tests' ? { ...gate, timeoutMs: LARGE_RUN_TIMEOUT_MS, note } : gate);
}

/** Proposes lint, typecheck and test gates (and a disabled dependency audit) from package.json scripts, workspaces and vitest config. */
export const node: EcosystemPlugin = { id: 'node', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  const manifest = await readJson(join(directory, 'package.json')) as Manifest | undefined;
  if (!manifest) return null;
  const manager = await packageManager(directory, manifest.packageManager);
  const layout: Layout = { scripts: manifest.scripts ?? {}, manager, inWorkspace: await workspaceScripts(directory, manifest) };
  const gates = proposeWanted(layout);
  if (!gates.some(gate => gate.id === 'tests')) gates.push(...await proposeVitest(directory, layout));
  // A TypeScript project without a typecheck script still gets one.
  if (!gates.some(gate => gate.id === 'typecheck') && 'typescript' in { ...manifest.dependencies, ...manifest.devDependencies } && await exists(join(directory, 'tsconfig.json')))
    gates.push({ id: 'typecheck', run: `${execPrefix(manager)} tsc --noEmit` });
  const all = [...await warnLargeRun(directory, gates), ...proposeExtras(layout, gates)];
  return all.length ? [...all, ...await proposeAudit(directory, manager)] : null;
} };
