import { readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { configSchema, detectedGateSchema } from '../../protocol/src/index.js';
import type { DetectedGate } from '../../protocol/src/index.js';
import type { EcosystemPlugin } from '../../plugin-sdk/src/index.js';
import { builtinEcosystems } from '../../plugins/ecosystems/src/index.js';

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

/** Creates `.qualitygate.yml` from the gates proposed by ecosystem plugins and ignores its output folders. */
export async function setupProject(configPath: string, ecosystems: EcosystemPlugin[] = builtinEcosystems):
Promise<{ configPath: string; gates: { id: string; run: string }[]; gitignore: string[]; ecosystems: string[] }> {
  const path = resolve(configPath);
  const directory = dirname(path);
  await stat(directory);
  const proposals: { ecosystem: string; gates: DetectedGate[] }[] = [];
  for (const plugin of ecosystems) {
    const gates = detectedGateSchema.array().parse(await plugin.detect(directory) ?? []);
    if (gates.length) proposals.push({ ecosystem: plugin.id, gates });
  }
  const gates = mergeProposals(proposals);
  if (!gates.length) throw new Error('No lint, typecheck or test script found in package.json and no other ecosystem detected; write .qualitygate.yml by hand');
  const config = configSchema.parse({ schemaVersion: 1, gates });
  await writeFile(path, stringify(config), { flag: 'wx' });
  const gitignorePath = join(directory, '.gitignore');
  const current = await readFile(gitignorePath, 'utf8').catch(() => '');
  const lines = current.split('\n').map(line => line.trim());
  const gitignore = ignored.filter(entry => !lines.includes(entry));
  if (gitignore.length) await appendFile(gitignorePath, `${current && !current.endsWith('\n') ? '\n' : ''}${gitignore.join('\n')}\n`);
  return { configPath: path, gates: gates.map(({ id, run }) => ({ id, run })), gitignore, ecosystems: proposals.map(({ ecosystem }) => ecosystem) };
}
