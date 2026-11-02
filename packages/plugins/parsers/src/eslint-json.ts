import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { parseEslintReport } from '../../eslint/src/index.js';
export const eslintJson: ParserPlugin = { id: 'eslint-json', apiVersion: 1, kind: 'parser',
  parse: (raw, { gateId, cwd }) => parseEslintReport(raw, gateId, cwd) };
