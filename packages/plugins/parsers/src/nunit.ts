import { isAbsolute, relative } from 'node:path';
import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { collect, parseXml, text } from './xml.js';
const LOCATION = /in (.+?):line (\d+)/;
/** NUnit 3 `<test-run>`: failed `<test-case>` elements; file and line come from the stack trace when present. */
export const nunit: ParserPlugin = { id: 'nunit', apiVersion: 1, kind: 'parser', parse(raw, { gateId, cwd }) {
  return collect(parseXml(raw), 'test-case').filter(item => item['@_result'] === 'Failed').map(item => {
    const failure = [item['failure']].flat()[0] as Record<string, unknown> | undefined;
    const message = `${item['@_fullname']}: ${text(failure?.['message']) ?? 'failed'}`;
    const location = LOCATION.exec(text(failure?.['stack-trace']) ?? '');
    if (!location) return { gateId, severity: 'error' as const, message };
    const path = location[1]!;
    const inside = isAbsolute(path) ? relative(cwd, path) : path;
    return { gateId, severity: 'error' as const, message, file: inside.startsWith('..') ? path : inside.replaceAll('\\', '/'), line: Number(location[2]) };
  });
} };
