import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParserPlugin } from '../../../plugin-sdk/src/index.js';
import { collect, parseXml, text } from './xml.js';
const SOURCE = '(?:[cm]?[jt]sx?|cs|py|php|java|kt|go|rb|rs|swift|vue|svelte)';
/** `file:///p/x.mjs:12:3`, `(/p/x.ts:12:3)`, `at /p/x.ts:12` or a relative `src/x.ts:12:3` in a stack; the lookbehind keeps `node:internal/..` and URLs out. */
const STACK_LOCATION = new RegExp(`(?<![\\w:./\\\\-])(file:\\/\\/[^\\s()]+?|[A-Za-z]:[\\\\/][^\\s()]+?|\\/[^\\s()]+?|[\\w.-]+(?:\\/[\\w.@-]+)*\\.${SOURCE}):(\\d+)(?::\\d+)?`, 'g');
const FILE_NAME = new RegExp(`^[\\w.@-]+(?:/[\\w.@-]+)*\\.${SOURCE}$`);
/** A path inside the project as a project-relative path; anything outside it, or unreadable, is no location. */
function inside(path: string, cwd: string): string | undefined {
  let local = path;
  if (path.startsWith('file://')) { try { local = fileURLToPath(path); } catch { return undefined; } }
  if (!isAbsolute(local) && !/^[A-Za-z]:[\\/]/.test(local)) return local.startsWith('..') ? undefined : local.replaceAll('\\', '/');
  const rest = relative(cwd, local);
  return rest.startsWith('..') || isAbsolute(rest) ? undefined : rest.replaceAll('\\', '/');
}
/** File and line of a failing testcase: its `file`/`line` attributes, else the first project frame of the stack text, else a path-like `classname` (no line). Nothing is guessed. */
function locate(testcase: Record<string, unknown>, stack: string, cwd: string): { file?: string; line?: number } {
  const frames = [...stack.matchAll(STACK_LOCATION)].filter(([, path]) => !path!.startsWith('node:') && !path!.includes('node_modules'))
    .flatMap(([, path, line]) => { const file = inside(path!, cwd); return file === undefined ? [] : [{ file, line: Number(line) }]; });
  const attribute = typeof testcase['@_file'] === 'string' ? inside(testcase['@_file'], cwd) : undefined;
  const classname = typeof testcase['@_classname'] === 'string' && FILE_NAME.test(testcase['@_classname']) ? inside(testcase['@_classname'], cwd) : undefined;
  const file = attribute ?? (frames.length && !classname ? frames[0]!.file : classname);
  if (file === undefined) return {};
  const line = Number(testcase['@_line']) > 0 && attribute ? Number(testcase['@_line']) : frames.find(frame => frame.file === file)?.line ?? (file === frames[0]?.file ? frames[0]!.line : undefined);
  return { file, ...(line ? { line } : {}) };
}
/** JUnit XML: every `<testcase>` with a `<failure>` or `<error>` becomes an error finding. */
export const junit: ParserPlugin = { id: 'junit', apiVersion: 1, kind: 'parser', parse(raw, { gateId, cwd }) {
  return collect(parseXml(raw), 'testcase').flatMap(testcase => {
    const failure = [testcase['failure'], testcase['error']].flat().find(item => item !== undefined) as Record<string, unknown> | string | undefined;
    if (failure === undefined) return [];
    const detail = (typeof failure === 'object' ? text(failure['@_message']) : undefined) ?? text(failure) ?? 'failed';
    const name = [testcase['@_classname'], testcase['@_name']].filter(Boolean).join('.');
    const stack = [typeof failure === 'object' ? text(failure['@_message']) : undefined, text(failure)].filter(Boolean).join('\n');
    return [{ gateId, severity: 'error' as const, message: `${name}: ${detail}`, ...locate(testcase, stack, cwd) }];
  });
},
count(raw) {
  const cases = collect(parseXml(raw), 'testcase');
  const failed = cases.filter(item => item['failure'] !== undefined || item['error'] !== undefined).length;
  const skipped = cases.filter(item => item['skipped'] !== undefined).length;
  return { passed: Math.max(0, cases.length - failed - skipped), failed, skipped };
} };
