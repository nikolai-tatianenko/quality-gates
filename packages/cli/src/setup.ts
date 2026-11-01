import { readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { configSchema } from '../../protocol/src/index.js';

const wanted = [
  { id: 'lint', scripts: ['lint'] },
  { id: 'typecheck', scripts: ['typecheck', 'type-check', 'check-types'] },
  { id: 'tests', scripts: ['test:ci', 'test'], timeoutMs: 300000 },
];
const ignored = ['.qualitygate/', '.qualitygate-ci/', '.qualitygate-review-sources/'];
const lockfiles: [string, string][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']];

const exists = (path: string) => access(path).then(() => true, () => false);

async function packageManager(directory: string, declared: unknown): Promise<string> {
  const name = typeof declared === 'string' ? declared.split('@')[0] : undefined;
  if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name;
  for (const [file, manager] of lockfiles) if (await exists(join(directory, file))) return manager;
  return 'npm';
}

/** Creates `.qualitygate.yml` from the lint/typecheck/test scripts in package.json and ignores its output folders. */
export async function setupProject(configPath: string): Promise<{ configPath: string; gates: { id: string; run: string }[]; gitignore: string[] }> {
  const path = resolve(configPath);
  const directory = dirname(path);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; packageManager?: unknown };
  const scripts = pkg.scripts ?? {};
  const manager = await packageManager(directory, pkg.packageManager);
  const gates = wanted.flatMap(({ id, scripts: names, timeoutMs }) => {
    const script = names.find(name => name in scripts);
    return script ? [{ id, run: `${manager} run ${script}`, ...(timeoutMs ? { timeoutMs } : {}) }] : [];
  });
  if (!gates.length) throw new Error('No lint, typecheck or test script found in package.json; write .qualitygate.yml by hand');
  const config = configSchema.parse({ schemaVersion: 1, gates });
  await writeFile(path, stringify(config), { flag: 'wx' });
  const gitignorePath = join(directory, '.gitignore');
  const current = await readFile(gitignorePath, 'utf8').catch(() => '');
  const lines = current.split('\n').map(line => line.trim());
  const gitignore = ignored.filter(entry => !lines.includes(entry));
  if (gitignore.length) await appendFile(gitignorePath, `${current && !current.endsWith('\n') ? '\n' : ''}${gitignore.join('\n')}\n`);
  return { configPath: path, gates: gates.map(({ id, run }) => ({ id, run })), gitignore };
}
