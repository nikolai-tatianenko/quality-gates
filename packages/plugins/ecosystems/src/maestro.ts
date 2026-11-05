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

/** Folders searched for Maestro flows: `.maestro`, `maestro` and `flows`. */
const FOLDERS = ['.maestro', 'maestro', 'flows'];
/** Proposes `maestro test` with a JUnit report, listed as not enabled because it needs an emulator or simulator. */
export const maestro: EcosystemPlugin = { id: 'maestro', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  let folder: string | undefined;
  for (const candidate of FOLDERS) if (!folder && await hasFlow(join(directory, candidate))) folder = candidate;
  if (!folder) return null;
  return [{ id: 'e2e-mobile', run: `mkdir -p .qualitygate/maestro && maestro test --format junit --output ${REPORT} ${folder}`,
    timeoutMs: 900000, skip: 'needs an emulator or simulator and is slow', report: { format: 'junit', path: REPORT } }];
} };
