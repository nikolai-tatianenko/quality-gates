#!/usr/bin/env node
import { analyze } from './index.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
try {
  const languageIndex = args.indexOf('--language');
  const language = languageIndex < 0 ? 'typescript' : args[languageIndex + 1];
  if (language !== 'typescript' && language !== 'python') throw new Error('--language must be typescript or python');
  if (languageIndex >= 0) args.splice(languageIndex, 2);
  const unknown = args.find(arg => arg.startsWith('-') && arg !== '--json');
  if (unknown) throw new Error(`Unknown option: ${unknown}`);
  const patterns = args.filter(arg => arg !== '--json');
  const result = await analyze({ language, patterns: patterns.length ? patterns : undefined });
  // ESLint-compatible JSON can be consumed by QualityGate's ESLint gate plugin.
  if (json) console.log(JSON.stringify(result.results));
  else {
    for (const issue of result.findings) console.log(`${issue.file}:${issue.line ?? 1}:${issue.column ?? 1} ${issue.rule ?? 'parse'} ${issue.message}`);
    console.log(`${result.decision}: ${result.findings.length} code analysis findings`);
  }
  process.exitCode = result.decision === 'BLOCK' ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
