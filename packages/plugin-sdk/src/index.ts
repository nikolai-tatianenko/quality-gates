import type { AuditData, Finding, GateData, GateSpec, RunResult } from '../../protocol/src/index.js';
export interface Manifest { id: string; apiVersion: 1 }
export interface Context { signal: AbortSignal; defer(cleanup: () => void | Promise<void>): void }
export interface AuditPlugin extends Manifest {
  kind: 'audit'; audit(url: string, context: Context): Promise<AuditData>;
}
export interface GatePlugin extends Manifest {
  kind: 'gate'; run(spec: GateSpec, context: Context): Promise<GateData>;
}
export interface StoragePlugin extends Manifest {
  kind: 'storage'; createRun(runId: string): Promise<string>;
  write(directory: string, filename: string, data: string): Promise<string>;
  /** Copies a file byte-for-byte into the run directory (additive; optional for storage plugins). */
  copy?(directory: string, filename: string, sourcePath: string): Promise<string>;
}
export interface ParserPlugin extends Manifest {
  kind: 'parser'; parse(raw: string, context: { gateId: string; cwd: string }): Finding[];
}
export interface ReporterPlugin extends Manifest {
  kind: 'reporter'; render(result: RunResult): string;
}
export type Plugin = AuditPlugin | GatePlugin | StoragePlugin | ReporterPlugin | ParserPlugin;
