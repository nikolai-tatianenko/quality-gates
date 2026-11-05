import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';
import { execPrefix, packageManager, readJson } from './shared.js';

const REPORT = '.qualitygate/playwright/report.json';

/** Proposes `playwright test` with a JSON report and screenshots, videos and traces as run evidence. */
export const playwright: EcosystemPlugin = { id: 'playwright', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  if (!(await readdir(directory)).some(name => /^playwright\.config\.[cm]?[jt]s$/.test(name))) return null;
  const pkg = await readJson(join(directory, 'package.json')) as { packageManager?: unknown } | undefined;
  const prefix = execPrefix(await packageManager(directory, pkg?.packageManager));
  const note = `Playwright needs its browsers once: ${prefix} playwright install`;
  return [{ id: 'tests', note, run: `PLAYWRIGHT_JSON_OUTPUT_NAME=${REPORT} ${prefix} playwright test --reporter=list,json`, timeoutMs: 600000,
    report: { format: 'playwright-json', path: REPORT }, artifacts: ['test-results/**/*.png', 'test-results/**/*.webm', 'test-results/**/*.zip'] }];
} };
