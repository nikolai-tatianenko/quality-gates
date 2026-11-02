import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { eslintJson } from './eslint-json.js';
import { playwrightJson } from './playwright-json.js';
import { unityLog } from './unity-log.js';
/** Built-in report parsers keyed by the `report.format` id used in `.qualitygate.yml`. */
export const builtinParsers: Record<string, ParserPlugin> = Object.fromEntries(
  [eslintJson, playwrightJson, unityLog].map(parser => [parser.id, parser]));
