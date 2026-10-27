import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoragePlugin } from '../../../plugin-sdk/src/index.js';
export function filesystemPlugin(outputDir: string): StoragePlugin {
  return {
    id: 'filesystem', apiVersion: 1, kind: 'storage',
    async createRun(runId) {
      if (basename(runId) !== runId) throw new Error('Invalid run ID');
      const base = resolve(outputDir);
      await mkdir(base, { recursive: true });
      const dir = join(base, runId);
      await mkdir(dir); // Never reuse an existing run directory.
      return dir;
    },
    async write(dir, filename, data) {
      if (basename(filename) !== filename) throw new Error('Invalid evidence filename');
      const target = join(dir, filename);
      const temporary = join(dir, `.${filename}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, data, { flag: 'wx' });
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return target;
    },
  };
}
