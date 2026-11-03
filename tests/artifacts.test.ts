import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandArtifacts } from '../packages/plugins/command/src/artifacts.js';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { filesystemPlugin } from '../packages/plugins/storage-fs/src/index.js';
import { jsonReporter } from '../packages/plugins/reporter-json/src/index.js';
import { configSchema } from '../packages/protocol/src/index.js';
import { run } from '../packages/core/src/index.js';
async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'qg-art-')));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const put = async (dir: string, path: string, data: string | Buffer = 'x') => {
  await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), data);
};
test('globs match nested files, stay on one level for *, and tolerate no match', () => withDir(async dir => {
  await put(dir, 'out/a/b/one.png'); await put(dir, 'out/two.png'); await put(dir, 'x.log'); await put(dir, 'sub/y.log'); await put(dir, 'out/three.txt');
  assert.deepEqual((await expandArtifacts(dir, ['out/**/*.png'])).files, [join(dir, 'out/a/b/one.png'), join(dir, 'out/two.png')]);
  assert.deepEqual((await expandArtifacts(dir, ['*.log'])).files, [join(dir, 'x.log')]);
  assert.deepEqual(await expandArtifacts(dir, ['out/?hree.txt', 'nothing/**/*.zip']), { files: [join(dir, 'out/three.txt')], truncated: false });
  assert.deepEqual(await expandArtifacts(dir, ['out/two.png', 'out/*.png']), { files: [join(dir, 'out/two.png')], truncated: false });
}));
test('file count and byte caps truncate', () => withDir(async dir => {
  for (let i = 0; i < 51; i++) await put(dir, `f/${String(i).padStart(2, '0')}.txt`);
  const byCount = await expandArtifacts(dir, ['f/*.txt']);
  assert.equal(byCount.files.length, 50); assert.equal(byCount.truncated, true);
  const byBytes = await expandArtifacts(dir, ['f/*.txt'], { maxFiles: 50, maxBytes: 3 });
  assert.equal(byBytes.files.length, 3); assert.equal(byBytes.truncated, true);
}));
test('symlinks, escapes and absolute patterns are skipped', () => withDir(async dir => {
  await put(dir, 'real/a.png'); await put(dir, 'a.png');
  await symlink(join(dir, 'a.png'), join(dir, 'link.png'));
  await symlink(join(dir, 'real'), join(dir, 'dirlink'));
  assert.deepEqual((await expandArtifacts(dir, ['*.png'])).files, [join(dir, 'a.png')]);
  assert.deepEqual((await expandArtifacts(dir, ['dirlink/*.png'])).files, []);
  assert.deepEqual((await expandArtifacts(dir, ['../*.png', '../**', join(dir, 'a.png'), 'real/../a.png'])).files, []);
}));
test('storage copy is byte exact and checks the filename', () => withDir(async dir => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await put(dir, 'src.bin', bytes); await mkdir(join(dir, 'run'));
  const storage = filesystemPlugin(join(dir, 'unused'));
  const target = await storage.copy!(join(dir, 'run'), 'copy.bin', join(dir, 'src.bin'));
  assert.deepEqual(await readFile(target), bytes);
  await assert.rejects(storage.copy!(join(dir, 'run'), 'a/b.bin', join(dir, 'src.bin')), /Invalid evidence filename/);
  await assert.rejects(storage.copy!(join(dir, 'run'), 'missing.bin', join(dir, 'nope')));
}));
const exec = (dir: string, gates: object[], storage = filesystemPlugin(join(dir, 'out'))) =>
  run(configSchema.parse({ schemaVersion: 1, gates, outputDir: join(dir, 'out') }), { gate: commandPlugin(dir), storage, reporter: jsonReporter });
const makePng = `node -e "require('fs').mkdirSync('out-art',{recursive:true});require('fs').writeFileSync('out-art/a.png',Buffer.from([137,80,78,71,0,255]))"`;
test('artifacts become run evidence copies', () => withDir(async dir => {
  const result = await exec(dir, [{ id: 'shots', run: makePng, artifacts: ['out-art/*.png'] }]);
  const [stored] = result.gates[0]!.artifacts;
  assert.ok(stored?.includes('gate-1-shots-artifact-1-a.png'));
  assert.deepEqual(await readFile(stored!), Buffer.from([137, 80, 78, 71, 0, 255]));
  assert.ok((await stat(stored!)).isFile()); assert.ok(stored!.startsWith(join(dir, 'out')));
}));
test('truncated artifacts add a note to the gate output', () => withDir(async dir => {
  const many = `node -e "const fs=require('fs');fs.mkdirSync('m');for(let i=0;i<51;i++)fs.writeFileSync('m/'+i,'x')"`;
  const result = await exec(dir, [{ id: 'many', run: many, artifacts: ['m/*'] }]);
  assert.equal(result.gates[0]!.artifacts.length, 50); assert.match(result.gates[0]!.outputTail, /\[artifacts truncated[^\n]*\n?$/);
}));
test('artifacts are skipped when storage cannot copy', () => withDir(async dir => {
  const base = filesystemPlugin(join(dir, 'out'));
  const result = await exec(dir, [{ id: 'shots', run: makePng, artifacts: ['out-art/*.png'] }], { ...base, copy: undefined });
  assert.deepEqual(result.gates[0]!.artifacts, []);
  assert.match(result.gates[0]!.errors.join('\n'), /1 artifact\(s\) not stored: the storage plugin cannot copy files/);
}));
