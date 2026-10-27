import { categories, type Config, type Scores } from '../../protocol/src/index.js';
export function evaluate(scores: Scores, thresholds: Config['thresholds']) {
  const violations: string[] = [];
  for (const key of categories) {
    const score = scores[key];
    if (score === undefined) violations.push(`${key}: required metric missing`);
    else if (score < thresholds[key]) violations.push(`${key}: ${score} < ${thresholds[key]}`);
  }
  return { decision: violations.length ? 'BLOCK' as const : 'PASS' as const, violations };
}
