import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { collect, parseXml, text } from './xml.js';
/** JUnit XML: every `<testcase>` with a `<failure>` or `<error>` becomes an error finding. */
export const junit: ParserPlugin = { id: 'junit', apiVersion: 1, kind: 'parser', parse(raw, { gateId }) {
  return collect(parseXml(raw), 'testcase').flatMap(testcase => {
    const failure = [testcase['failure'], testcase['error']].flat().find(item => item !== undefined) as Record<string, unknown> | string | undefined;
    if (failure === undefined) return [];
    const detail = (typeof failure === 'object' ? text(failure['@_message']) : undefined) ?? text(failure) ?? 'failed';
    const name = [testcase['@_classname'], testcase['@_name']].filter(Boolean).join('.');
    return [{ gateId, severity: 'error' as const, message: `${name}: ${detail}` }];
  });
} };
