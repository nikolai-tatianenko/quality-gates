import { XMLParser, XMLValidator } from 'fast-xml-parser';
const ARRAYS = new Set(['testcase', 'test-case', 'testsuite', 'test-suite', 'failure', 'error']);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: name => ARRAYS.has(name) });
/** Parses XML into plain objects; elements in ARRAYS are always arrays. Throws `Invalid XML: ...`. */
export function parseXml(raw: string): Record<string, unknown> {
  const valid = XMLValidator.validate(raw);
  if (valid !== true) throw new Error(`Invalid XML: ${valid.err.msg}${/unclosed|end of|unexpected/i.test(valid.err.msg) ? ' (the report looks truncated: the tool may have been stopped or still writing it)' : ''}`);
  return parser.parse(raw) as Record<string, unknown>;
}
const asObjects = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : [value]).map(item => (item && typeof item === 'object' ? item as Record<string, unknown> : {}));
/** Collects nested nodes with the given element name at any depth. */
export function collect(node: unknown, name: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) { for (const item of node) collect(item, name, out); return out; }
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === name) out.push(...asObjects(value));
    collect(value, name, out);
  }
  return out;
}
/** Text of an element that may be a string, a CDATA/text node object, or absent. */
export function text(node: unknown): string | undefined {
  if (typeof node === 'string') return node.trim() || undefined;
  if (node && typeof node === 'object') return text((node as Record<string, unknown>)['#text']);
  return undefined;
}
