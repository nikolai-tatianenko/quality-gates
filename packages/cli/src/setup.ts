import { readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { configSchema, detectedGateSchema } from '../../protocol/src/index.js';
import type { DetectedGate } from '../../protocol/src/index.js';
import type { EcosystemPlugin } from '../../plugin-sdk/src/index.js';
import { builtinEcosystems } from '../../plugins/ecosystems/src/index.js';
import { loadExternalPlugins } from '../../core/src/external.js';
import { builtinIds } from './runner.js';
import { readGatesFile } from './gates-file.js';

const ignored = ['.qualitygate/', '.qualitygate-ci/', '.qualitygate-review-sources/'];

/**
 * Merges ecosystem proposals into one gate list. Gates whose id several ecosystems propose are renamed
 * `<ecosystem>-<id>`; ids that still clash are an error, so a config is never silently ambiguous.
 */
export function mergeProposals(proposals: { ecosystem: string; gates: DetectedGate[] }[]): DetectedGate[] {
  const counts = new Map<string, number>();
  for (const { gates } of proposals) for (const { id } of gates) counts.set(id, (counts.get(id) ?? 0) + 1);
  const seen = new Set<string>();
  return proposals.flatMap(({ ecosystem, gates }) => gates.map(gate => {
    const id = counts.get(gate.id)! > 1 ? `${ecosystem}-${gate.id}` : gate.id;
    if (seen.has(id)) throw new Error(`Duplicate gate id: ${id}`);
    seen.add(id);
    return { ...gate, id };
  }));
}

export interface SetupOptions {
  /** Read the gates from this JSON or ES module instead of detecting ecosystems. */
  from?: string;
  /** Leave .gitignore alone (default: add the output folders). */
  gitignore?: boolean;
}
export interface SetupResult {
  configPath: string; gates: { id: string; run: string; fix?: string }[]; gitignore: string[]; ecosystems: string[]; plugins: string[];
  /** Found but not enabled, with the reason; written to the config as comments. */
  skipped: { id: string; run: string; reason: string }[];
  /** Advice, for example about a run that will not fit the timeout. */
  notes: string[];
  /** Every file setup wrote or changed, so nothing is touched silently. */
  changed: string[];
}

async function proposals(directory: string, ecosystems: EcosystemPlugin[], plugins: string[], from?: string) {
  if (from) return [{ ecosystem: 'file', gates: await readGatesFile(resolve(directory, from)) }];
  const external = await loadExternalPlugins(directory, plugins, builtinIds);
  const found: { ecosystem: string; gates: DetectedGate[] }[] = [];
  for (const plugin of [...ecosystems, ...external.ecosystems]) {
    const gates = detectedGateSchema.array().parse(await plugin.detect(directory) ?? []);
    if (gates.length) found.push({ ecosystem: plugin.id, gates });
  }
  return found;
}

/** The gate as it appears in the config: advice and skip reasons are for the person running setup only. */
function configGate(gate: DetectedGate): DetectedGate {
  const copy = { ...gate };
  delete copy.skip; delete copy.note;
  return copy;
}

/** Disabled gates as a commented YAML block the owner can uncomment under `gates:`. */
function skippedBlock(skipped: DetectedGate[]): string {
  if (!skipped.length) return '';
  const lines = skipped.flatMap(gate => {
    return [`# ${gate.id}: ${gate.skip}`, ...stringify([configGate(gate)]).trimEnd().split('\n').map(line => `# ${line}`)];
  });
  return `\n# Found but not enabled. Copy a block under \`gates:\` to enable it.\n${lines.join('\n')}\n`;
}

async function updateGitignore(directory: string): Promise<string[]> {
  const gitignorePath = join(directory, '.gitignore');
  const current = await readFile(gitignorePath, 'utf8').catch(() => '');
  const lines = current.split('\n').map(line => line.trim());
  const added = ignored.filter(entry => !lines.includes(entry));
  if (added.length) await appendFile(gitignorePath, `${current && !current.endsWith('\n') ? '\n' : ''}${added.join('\n')}\n`);
  return added;
}

/**
 * Creates `.qualitygate.yml` from the gates proposed by ecosystem plugins (or read with `from`) and, unless
 * `gitignore: false`, ignores its output folders. `plugins` are npm packages from the project's node_modules whose
 * ecosystems join the run; they are listed in the config. Gates marked `skip` are written as comments only.
 */
export async function setupProject(configPath: string, ecosystems: EcosystemPlugin[] = builtinEcosystems, plugins: string[] = [], options: SetupOptions = {}): Promise<SetupResult> {
  const path = resolve(configPath);
  const directory = dirname(path);
  await stat(directory);
  const found = await proposals(directory, ecosystems, plugins, options.from);
  const merged = mergeProposals(found);
  const gates = merged.filter(gate => !gate.skip);
  const skipped = merged.filter(gate => gate.skip);
  if (!gates.length) throw new Error(skipped.length
    ? `Every gate found needs a decision (${skipped.map(gate => `${gate.id}: ${gate.skip}`).join('; ')}); write .qualitygate.yml by hand`
    : 'No lint, typecheck or test script found in package.json and no other ecosystem detected; write .qualitygate.yml by hand');
  const config = configSchema.parse({ schemaVersion: 1, ...(plugins.length ? { plugins } : {}), gates: gates.map(configGate) });
  await writeFile(path, stringify(config) + skippedBlock(skipped), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === 'EEXIST' ? `${path} already exists; remove it or pick another path with --config` : error.message);
  });
  const gitignore = options.gitignore === false ? [] : await updateGitignore(directory);
  return { configPath: path, gates: gates.map(({ id, run, fix }) => ({ id, run, ...(fix ? { fix } : {}) })), gitignore, ecosystems: found.map(({ ecosystem }) => ecosystem), plugins,
    skipped: skipped.map(({ id, run, skip }) => ({ id, run, reason: skip! })), notes: merged.flatMap(gate => gate.note ? [`${gate.id}: ${gate.note}`] : []),
    changed: [path, ...(gitignore.length ? [join(directory, '.gitignore')] : [])] };
}
