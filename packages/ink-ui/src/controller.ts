import { readTrends } from '../../core/src/history.js';
import { execute, loadConfig } from '../../cli/src/runner.js';
import { fixGates } from '../../cli/src/fix.js';
import { getRun } from '../../service/src/index.js';
import { builtinParsers } from '../../plugins/parsers/src/index.js';
import type { GateSpec } from '../../protocol/src/index.js';
import type { Controller } from './session.js';
import type { GateInfo } from './model.js';

/**
 * A gate's output stays off the screen when its report parser can expose secrets. A report format that is not a built-in
 * parser is treated the same way, because a third-party parser's behaviour is not known here.
 */
export function isWithheld(gate: GateSpec): boolean {
  if (!gate.report) return false;
  const parser = builtinParsers[gate.report.format];
  return !parser || !!parser.secrets;
}

/** Wires the screen to the real runner: the same `execute` and `fixGates` the command line uses, so verdicts and exit codes are identical. */
export async function projectController(configPath: string): Promise<Controller> {
  const { config, directory } = await loadConfig(configPath);
  const gates: GateInfo[] = config.gates.map(gate => ({ id: gate.id, command: gate.run, fixable: !!gate.fix, withheld: isWithheld(gate) }));
  return {
    gates, root: directory,
    last: () => getRun(configPath).catch(() => undefined),
    run: (ids, signal, onProgress) => execute(configPath, signal, ids, { onProgress }),
    fix: (ids, signal, onProgress, onFix) => fixGates(configPath, signal, { gates: ids, onProgress, onFix }),
    trends: () => readTrends(config.outputDir, 50, () => undefined),
  };
}
