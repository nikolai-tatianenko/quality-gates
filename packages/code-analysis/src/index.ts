import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import { relative } from 'node:path';
import { analyzePython } from './python.js';

export interface AnalysisFinding {
  file: string; line?: number; column?: number; rule: string | null;
  severity: number; message: string;
}
export interface AnalysisOptions { cwd?: string; patterns?: string[]; language?: 'typescript' | 'python'; ruffPath?: string; signal?: AbortSignal }
export const rules: Linter.RulesRecord = {
  complexity: ['error', 15],
  'sonarjs/cognitive-complexity': ['error', 15],
  'max-depth': ['error', 4],
  'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
  'max-params': ['error', 4],
  'sonarjs/no-identical-functions': 'error',
  'sonarjs/no-duplicated-branches': 'error',
  'sonarjs/no-collapsible-if': 'error',
  'sonarjs/no-redundant-boolean': 'error',
};
/** Fixed, reproducible rules; does not load or execute a scanned project's config. */
export async function analyze(options: AnalysisOptions = {}) {
  if (options.language === 'python') return analyzePython(options);
  const cwd = options.cwd ?? process.cwd();
  const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: [{
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { parser: tseslint.parser }, plugins: { sonarjs }, rules,
  }] });
  const results = await eslint.lintFiles(options.patterns ?? ['packages/**/*.{ts,tsx}']);
  const findings: AnalysisFinding[] = results.flatMap(file => file.messages.map(issue => ({
    file: relative(cwd, file.filePath).replaceAll('\\', '/'), line: issue.line, column: issue.column,
    rule: issue.ruleId, severity: issue.severity, message: issue.message,
  })));
  return { schemaVersion: 1 as const, decision: results.some(file => file.errorCount > 0) ? 'BLOCK' as const : 'PASS' as const,
    findings, results };
}
