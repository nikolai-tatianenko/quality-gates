import { join } from 'node:path';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';
import type { DetectedGate } from '../../../protocol/src/index.js';
import { packageManager, readJson } from './shared.js';

const wanted = [
  { id: 'lint', scripts: ['lint'] },
  { id: 'typecheck', scripts: ['typecheck', 'type-check', 'check-types'] },
  { id: 'tests', scripts: ['test:ci', 'test'], timeoutMs: 300000 },
];

/** Proposes lint, typecheck and test gates from the scripts in package.json. */
export const node: EcosystemPlugin = { id: 'node', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  const pkg = await readJson(join(directory, 'package.json')) as { scripts?: Record<string, string>; packageManager?: unknown } | undefined;
  if (!pkg) return null;
  const scripts = pkg.scripts ?? {};
  const manager = await packageManager(directory, pkg.packageManager);
  const gates = wanted.flatMap(({ id, scripts: names, timeoutMs }): DetectedGate[] => {
    const script = names.find(name => name in scripts);
    return script ? [{ id, run: `${manager} run ${script}`, ...(timeoutMs ? { timeoutMs } : {}) }] : [];
  });
  return gates.length ? gates : null;
} };
