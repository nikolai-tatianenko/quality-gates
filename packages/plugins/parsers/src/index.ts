import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { axeJson } from './axe-json.js';
import { eslintJson } from './eslint-json.js';
import { gitleaks } from './gitleaks.js';
import { junit } from './junit.js';
import { npmAudit } from './npm-audit.js';
import { nunit } from './nunit.js';
import { osvScanner } from './osv-scanner.js';
import { playwrightJson } from './playwright-json.js';
import { unityLog } from './unity-log.js';
/** Built-in report parsers keyed by the `report.format` id used in `.qualitygate.yml`. */
export const builtinParsers: Record<string, ParserPlugin> = Object.fromEntries(
  [axeJson, eslintJson, gitleaks, junit, npmAudit, nunit, osvScanner, playwrightJson, unityLog].map(parser => [parser.id, parser]));
