/** The few `chrome.*` calls the popup uses, typed locally so no `@types/chrome` dependency and no broad API surface is needed. */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
export interface TabInfo { url?: string }
export interface ChromeApi {
  storage: { local: StorageArea };
  tabs: { query(query: { active: true; currentWindow: true }): Promise<TabInfo[]> };
}
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export type Scores = Partial<Record<'performance' | 'accessibility' | 'seo' | 'best-practices', number>>;
export interface Job { jobId: string; kind: string; url?: string; status: 'running' | 'cancelling' | 'finished' | 'cancelled' | 'error'; runId?: string; execution?: string; decision?: 'PASS' | 'BLOCK'; exitCode: number; error?: string }
export interface AuditSummary { url: string; execution: string; decision: 'PASS' | 'BLOCK'; scores: Scores; violations: string[]; errors: string[] }
export interface RunSummary { runId: string; execution: string; decision: 'PASS' | 'BLOCK'; exitCode: number; thresholds?: Scores; errors: string[]; results: AuditSummary[] }
export interface FindingSummary { severity: 'error' | 'warning' | 'info'; message: string; ruleId?: string; helpUrl?: string }
export interface GatesInfo { gates: { id: string; type?: string }[]; scan: { available: boolean; thresholds?: Scores } }
