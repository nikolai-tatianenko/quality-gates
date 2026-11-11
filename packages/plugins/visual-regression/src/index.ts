import type { PluginPackage } from '../../../plugin-sdk/src/index.js';
import { visualCommand } from './approve.js';
import { visualGate } from './gate.js';
export { visualCommand, visualGate };
/** Optional plugin: list its package in `plugins:` of the config to get the `visual` gate type and `qualitygate visual approve`. */
export const manifest: PluginPackage = { apiVersion: 1, plugins: [visualGate], commands: { visual: visualCommand } };
