import { join } from 'node:path';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';
import type { DetectedGate } from '../../../protocol/src/index.js';
import { exists, readJson } from './shared.js';

const REPORT = '.qualitygate/php/junit.xml';
interface Composer { require?: Record<string, string>; 'require-dev'?: Record<string, string>; scripts?: Record<string, unknown> }
interface Tool { package: string; run: string; fix?: string }

const STYLE: Tool[] = [{ package: 'laravel/pint', run: 'vendor/bin/pint --test', fix: 'vendor/bin/pint' },
  { package: 'friendsofphp/php-cs-fixer', run: 'vendor/bin/php-cs-fixer fix --dry-run --diff', fix: 'vendor/bin/php-cs-fixer fix' },
  { package: 'squizlabs/php_codesniffer', run: 'vendor/bin/phpcs', fix: 'vendor/bin/phpcbf' }];
const ANALYSIS: Tool[] = [{ package: 'phpstan/phpstan', run: 'vendor/bin/phpstan analyse --no-progress' }, { package: 'vimeo/psalm', run: 'vendor/bin/psalm --no-progress' }];
const RUNNERS: Tool[] = [{ package: 'pestphp/pest', run: 'vendor/bin/pest' }, { package: 'phpunit/phpunit', run: 'vendor/bin/phpunit' }];
const STYLE_SCRIPTS = ['lint', 'cs', 'phpcs', 'style'];
const ANALYSIS_SCRIPTS = ['analyse', 'analyze', 'phpstan', 'psalm', 'typecheck'];

/** The command for a gate: an installed tool first, then the first matching Composer script. */
function choose(composer: Composer, tools: Tool[], scripts: string[]): Pick<Tool, 'run' | 'fix'> | undefined {
  const packages = { ...composer.require, ...composer['require-dev'] };
  const tool = tools.find(candidate => candidate.package in packages);
  if (tool) return tool;
  const script = scripts.find(name => name in (composer.scripts ?? {}));
  return script ? { run: `composer run ${script}` } : undefined;
}

/** Proposes style, static-analysis and test gates from the packages and Composer scripts the project already uses. */
export const php: EcosystemPlugin = { id: 'php', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  const composer = await readJson(join(directory, 'composer.json')) as Composer | undefined;
  if (!composer) return null;
  const runner = choose(composer, RUNNERS, [])?.run;
  const found: [string, Pick<Tool, 'run' | 'fix'> | undefined][] = [['lint', choose(composer, STYLE, STYLE_SCRIPTS)], ['typecheck', choose(composer, ANALYSIS, ANALYSIS_SCRIPTS)],
    ['tests', runner ? { run: `mkdir -p .qualitygate/php && ${runner} --log-junit ${REPORT}` } : choose(composer, [], ['test'])]];
  // Composer's own binaries are only there after `composer install`; say so instead of failing with "not found".
  const note = await exists(join(directory, 'vendor/autoload.php')) ? undefined : 'run `composer install` first: the tools live in vendor/bin';
  const gates = found.flatMap(([id, tool]): DetectedGate[] => !tool ? [] : [{ id, run: tool.run, ...(tool.fix ? { fix: tool.fix } : {}), ...(id === 'tests' ? { timeoutMs: 300000 } : {}),
    ...(id === 'tests' && runner ? { report: { format: 'junit', path: REPORT } } : {}), ...(note ? { note } : {}) }]);
  if (!gates.length) return null;
  // Needs the network and blocks on any known advisory, so it is listed but not enabled.
  return [...gates, { id: 'audit', run: 'composer audit', skip: 'dependency audit needs the network and blocks on any known advisory: enable it if it should block' }];
} };
