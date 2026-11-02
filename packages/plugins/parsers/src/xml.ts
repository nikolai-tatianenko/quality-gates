import { XMLParser, XMLValidator } from 'fast-xml-parser';
const ARRAYS = new Set(['testcase', 'test-case', 'testsuite', 'test-suite', 'failure', 'error']);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: name => ARRAYS.has(name) });
/** Parses XML into plain objects; elements in ARRAYS are always arrays. Throws `Invalid XML: ...`. */
export function parseXml(raw: string): Record<string, unknown> {
  const valid = XMLValidator.validate(raw);
  if (valid !== true) throw new Error(`Invalid XML: ${valid.err.msg}`);
  return parser.parse(raw) as Record<string, unknown>;
}
/** Collects nested nodes with the given element name at any depth. */
export function collect(node: unknown, name: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) for (const item of node) collect(item, name, out);
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) {
    if (key === name) for (const item of Array.isArray(value) ? value : [value]) { if (item && typeof item === 'object') out.push(item as Record<string, unknown>); else out.push({}); }
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
