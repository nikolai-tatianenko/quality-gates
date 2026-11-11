/** Where the plugin keeps its files inside a run's evidence folder: `<runId>/visual/visual.json` and `approved|current|diff/<name>.png`. */
export const VISUAL_DIR = 'visual';
export const REPORT_FILE = 'visual.json';
export const DEFAULT_BASELINE = 'qualitygate-visual/approved';
export const DEFAULT_THRESHOLD = 0.1;
export const DEFAULT_MAX_PIXELS = 16_000_000;
export type VisualStatus = 'match' | 'changed' | 'new' | 'missing';
/** One screenshot. Paths are relative to the visual folder and null when the file is absent; `note` is optional and explains a refusal. */
export interface VisualItem {
  name: string; status: VisualStatus;
  approved: string | null; current: string | null; diff: string | null;
  width: number; height: number; diffPixels: number; diffRatio: number; threshold: number;
  note?: string;
}
/** The contract with the dashboard: schemaVersion 1; `problems` (optional) lists files that were refused and made the gate BLOCK. */
export interface VisualReport {
  schemaVersion: 1; gateId: string; baselineDir: string; items: VisualItem[]; problems?: string[];
}
