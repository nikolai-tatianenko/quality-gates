import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Builds a local tarball into a versioned folder (`.packages/<version>/`) instead of a shared temp folder,
 * so two checkouts or two versions never overwrite each other, and writes a SHA-256 file next to it.
 * Nothing is published.
 */
const { name, version } = JSON.parse(await readFile('package.json', 'utf8'));
const directory = resolve('.packages', version);
execFileSync('pnpm', ['build'], { stdio: 'inherit' });
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const packed = JSON.parse(execFileSync('pnpm', ['--silent', 'pack', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
const filename = (Array.isArray(packed) ? packed[0] : packed).filename.split('/').pop();
const tarball = join(directory, filename);
const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
await writeFile(`${tarball}.sha256`, `${sha256}  ${filename}\n`);
console.log([`${name} ${version}`, `Tarball: ${tarball}`, `SHA-256: ${sha256}`, '',
  'In the target project:', '  mkdir -p tools', `  cp ${tarball} ${tarball}.sha256 tools/`,
  `  (cd tools && shasum -a 256 -c ${filename}.sha256)`, `  pnpm add -D ./tools/${filename}`].join('\n'));
