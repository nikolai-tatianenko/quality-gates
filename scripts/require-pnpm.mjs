import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
// Package consumers choose their own manager; this guard applies to our checkout.
if (existsSync(new URL('pnpm-workspace.yaml', root))) {
  const expected = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).packageManager;
  const actual = (process.env.npm_config_user_agent || '').split(' ')[0];
  if (actual !== expected.replace('@', '/')) {
    console.error(`This repository (${fileURLToPath(root)}) requires ${expected}. Run: corepack enable && pnpm install --frozen-lockfile`);
    process.exitCode = 1;
  }
}
