import { z } from 'zod';
export const markers = {
  manualStart: '<!-- qualitygate:manual:start -->', manualEnd: '<!-- qualitygate:manual:end -->',
  autoStart: '<!-- qualitygate:auto:start -->', autoEnd: '<!-- qualitygate:auto:end -->',
} as const;
const metadataSchema = z.object({ head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), finishedAt: z.string().datetime(), runId: z.string().uuid() }).strict();
export type ReportMetadata = z.infer<typeof metadataSchema>;
/** Recognize standalone markers outside fenced code; malformed ownership boundaries fail closed. */
function boundaries(body: string) {
  const found = new Map<string, { start: number; end: number }>(); let offset = 0; let fence: string | undefined;
  for (const line of body.split(/(?<=\n)/)) {
    const clean = line.replace(/\r?\n$/, ''); const delimiter = clean.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      const current = delimiter[1]!;
      if (!fence) fence = current;
      else if (current[0] === fence[0] && current.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
    } else if (!fence && Object.values(markers).includes(clean as typeof markers[keyof typeof markers])) {
      if (found.has(clean)) throw new Error('Duplicate QualityGate section marker');
      found.set(clean, { start: offset, end: offset + line.length });
    }
    offset += line.length;
  }
  if (fence) throw new Error('Unclosed Markdown fence in PR description');
  return found;
}
function validateBoundaries(found: Map<string, { start: number; end: number }>) {
  for (const [start, end] of [[markers.manualStart, markers.manualEnd], [markers.autoStart, markers.autoEnd]]) {
    if (found.has(start!) !== found.has(end!) || (found.has(start!) && found.get(start!)!.start >= found.get(end!)!.start)) throw new Error('Malformed QualityGate section markers');
  }
  const ordered = [...found.keys()];
  if (ordered.length === 4 && !([markers.manualStart, markers.manualEnd, markers.autoStart, markers.autoEnd].every((value, index) => value === ordered[index]))) throw new Error('Overlapping or misplaced QualityGate sections');
  return found;
}
function older(section: string, metadata: ReportMetadata) {
  const matches = [...section.matchAll(/<!-- qualitygate:metadata (.+) -->/g)];
  if (matches.length > 1) throw new Error('Duplicate QualityGate metadata');
  if (!matches.length) return false;
  const previous = metadataSchema.parse(JSON.parse(matches[0]![1]!));
  return previous.head === metadata.head && Date.parse(previous.finishedAt) > Date.parse(metadata.finishedAt);
}
function compose(body: string, found: ReturnType<typeof boundaries>, generated: string) {
  const start = found.get(markers.autoStart); const end = found.get(markers.autoEnd);
  if (found.has(markers.manualStart)) return start && end ? body.slice(0, start.start) + generated + body.slice(end.end) : body + '\n\n' + generated;
  const manual = start && end ? body.slice(0, start.start) + body.slice(end.end) : body;
  return `## Manual description\n${markers.manualStart}\n${manual}${manual.endsWith('\n') ? '' : '\n'}${markers.manualEnd}\n\n${generated}`;
}
export function updateDescription(body: string, markdown: string, metadata: ReportMetadata) {
  metadataSchema.parse(metadata);
  if (markdown.includes('<!-- qualitygate:')) throw new Error('Generated report contains reserved section markers');
  const found = validateBoundaries(boundaries(body)); const start = found.get(markers.autoStart); const end = found.get(markers.autoEnd);
  if (start && end && older(body.slice(start.end, end.start), metadata)) return { body, changed: false, reason: 'older-run' as const };
  const generated = `${markers.autoStart}\n<!-- qualitygate:metadata ${JSON.stringify(metadata)} -->\n${markdown.trimEnd()}\n${markers.autoEnd}\n`;
  const result = compose(body, found, generated);
  if (Buffer.byteLength(result) > 32000) throw new Error('PR description exceeds the 32 KB publication limit; manual text was not truncated');
  return { body: result, changed: result !== body, reason: result === body ? 'unchanged' as const : 'updated' as const };
}
