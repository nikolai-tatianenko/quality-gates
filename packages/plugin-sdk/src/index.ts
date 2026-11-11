import type { AuditData, Config, Counts, DetectedGate, Finding, GateData, GateSpec, RunResult } from '../../protocol/src/index.js';
export interface Manifest { id: string; apiVersion: 1 }
export interface Context {
  signal: AbortSignal; defer(cleanup: () => void | Promise<void>): void;
  /** Optional: shows a line of progress in the live terminal view. It is display only and never part of the result or the stored log. */
  log?(line: string): void;
  /** Optional: the project root (the folder of the config file). Set by the runner; plugins fall back to the working directory. */
  projectDir?: string;
  /** Optional: this run's evidence folder, where a plugin may store its own files. Absent when storage could not create the run. */
  evidenceDir?: string;
}
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
  /** Optional: how many tests passed, failed or were skipped; shown when a gate times out with a partial report. */
  count?(raw: string): Counts;
  /** Optional: secret values the report contains (never put them in findings). The runner removes them from the gate output and does not keep the report as an artifact. */
  secrets?(raw: string): string[];
}
/** Proposes gates for `qualitygate setup`; `null` or `[]` means the ecosystem is not present in `directory`. */
export interface EcosystemPlugin extends Manifest {
  kind: 'ecosystem'; detect(directory: string): Promise<DetectedGate[] | null>;
}
export interface ReporterPlugin extends Manifest {
  kind: 'reporter'; render(result: RunResult): string;
}
export type Plugin = AuditPlugin | GatePlugin | StoragePlugin | ReporterPlugin | ParserPlugin | EcosystemPlugin;
/** Kinds a third-party package may provide. */
export type ExternalPlugin = ParserPlugin | EcosystemPlugin | GatePlugin;
/** Where a plugin command (`qualitygate <name> ...`) finds the project; it prints `lines` and, with `--json`, the whole result. */
export interface CommandContext { args: string[]; config: Config; directory: string; signal: AbortSignal }
export type PluginCommand = (context: CommandContext) => Promise<{ lines: string[] } & Record<string, unknown>>;
/** What a plugin package exports as `manifest` (or default) from its entry module. `commands` adds optional `qualitygate <name>` commands. */
export interface PluginPackage { apiVersion: 1; plugins: ExternalPlugin[]; commands?: Record<string, PluginCommand> }
