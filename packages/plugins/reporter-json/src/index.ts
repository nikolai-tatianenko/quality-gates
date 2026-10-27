import type { ReporterPlugin } from '../../../plugin-sdk/src/index.js';
import { runResultSchema } from '../../../protocol/src/index.js';
export const jsonReporter: ReporterPlugin = {
  id: 'json', apiVersion: 1, kind: 'reporter',
  render: result => JSON.stringify(runResultSchema.parse(result), null, 2) + '\n',
};
