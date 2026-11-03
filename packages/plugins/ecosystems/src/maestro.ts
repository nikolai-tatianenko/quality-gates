import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';

const REPORT = '.qualitygate/maestro/report.xml';

async function hasFlow(directory: string): Promise<boolean> {
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter(entry => /\.ya?ml$/.test(entry)))
    if ((await readFile(join(directory, name), 'utf8')).includes('appId:')) return true;
  return false;
}

/** Proposes `maestro test` with a JUnit report when `.maestro/` or `flows/` holds Maestro flows. */
export const maestro: EcosystemPlugin = { id: 'maestro', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  const folder = (await hasFlow(join(directory, '.maestro'))) ? '.maestro' : (await hasFlow(join(directory, 'flows'))) ? 'flows' : undefined;
  if (!folder) return null;
  return [{ id: 'e2e-mobile', run: `mkdir -p .qualitygate/maestro && maestro test --format junit --output ${REPORT} ${folder}`,
    timeoutMs: 900000, report: { format: 'junit', path: REPORT } }];
} };
