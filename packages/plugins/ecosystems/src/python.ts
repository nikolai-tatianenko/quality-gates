import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';
import type { DetectedGate } from '../../../protocol/src/index.js';

const REPORT = '.qualitygate/python/pytest.xml';
const text = (path: string) => readFile(path, 'utf8').catch(() => '');

/** Proposes ruff, pytest (JUnit report) and, when the project mentions it, mypy. */
export const python: EcosystemPlugin = { id: 'python', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  const names = await readdir(directory);
  const requirements = names.filter(name => /^requirements.*\.txt$/.test(name));
  if (!names.includes('pyproject.toml') && !requirements.length) return null;
  const manifests = await Promise.all([...requirements, 'pyproject.toml', 'setup.cfg'].map(name => text(join(directory, name))));
  const mypy = names.includes('mypy.ini') || manifests.some(content => /\bmypy\b/.test(content));
  const gates: DetectedGate[] = [
    { id: 'lint', run: 'ruff check .', fix: 'ruff check --fix .' },
    { id: 'tests', run: `pytest --junitxml=${REPORT}`, timeoutMs: 300000, report: { format: 'junit', path: REPORT } },
  ];
  return mypy ? [...gates, { id: 'typecheck', run: 'mypy .' }] : gates;
} };
