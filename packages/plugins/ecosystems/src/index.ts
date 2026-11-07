import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';
import { maestro } from './maestro.js';
import { node } from './node.js';
import { php } from './php.js';
import { playwright } from './playwright.js';
import { python } from './python.js';
import { unity } from './unity.js';
/** Built-in ecosystems in the order `qualitygate setup` consults them. */
export const builtinEcosystems: EcosystemPlugin[] = [node, python, php, unity, playwright, maestro];
