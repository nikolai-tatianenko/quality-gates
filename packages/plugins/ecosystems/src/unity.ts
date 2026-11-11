import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';

/**
 * Lists the Unity processes that have THIS project open (`-projectPath <dir>`, any case, whole path only).
 * `$1` is `any` or `editor`; an editor is a process without `-batchmode`. Other projects' processes never match.
 */
const unityProcesses = "unity_procs() { ps -axo pid=,command= 2>/dev/null | awk -v me=\"$$\" -v dir=\"$dir\" -v mode=\"$1\" "
  + "'{ line = tolower($0); key = \"-projectpath \" tolower(dir); i = index(line, key); if (!i || $1 == me) next; "
  + "rest = substr(line, i + length(key), 1); if (rest != \"\" && rest != \" \") next; "
  + "if (mode == \"editor\" && index(line, \"-batchmode\")) next; found = 1 } END { exit !found }'; }";
/** Seconds to wait for an earlier batch run on the same project to exit before giving up; `QUALITYGATE_UNITY_WAIT` overrides it. */
export const UNITY_WAIT_SECONDS = 120;
/**
 * Shell prefix for every Unity gate: refuse while an editor has this project open, wait (bounded) for an earlier batch run
 * on this project to exit (Unity aborts when a second instance opens the same project), then drop a stale
 * `Temp/UnityLockfile` and create the output folder. Processes of other projects are ignored.
 */
export const unityPrepare = `{ dir=$(pwd -P); ${unityProcesses}; waited=0; limit="\${QUALITYGATE_UNITY_WAIT:-${UNITY_WAIT_SECONDS}}"; `
  + 'while unity_procs any; do '
  + "if unity_procs editor; then echo 'Unity project is open in an editor; close it first' >&2; exit 1; fi; "
  + 'if [ "$waited" -ge "$limit" ]; then echo "A Unity process is still running for this project after ${limit}s (-projectPath $dir); not starting a second instance" >&2; exit 1; fi; '
  + 'waited=$((waited + 1)); sleep 1; done; '
  + 'rm -f Temp/UnityLockfile; mkdir -p .qualitygate/unity; }';

/** Proposes a compile check (`unity-log`) and EditMode tests (`nunit`) run through Unity batch mode. */
export const unity: EcosystemPlugin = { id: 'unity', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  const raw = await readFile(join(directory, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').catch(() => undefined);
  if (raw === undefined) return null;
  const version = /^m_EditorVersion:[ \t]*([0-9A-Za-z.]+)[ \t]*\r?$/m.exec(raw)?.[1];
  if (!version) throw new Error('Unreadable Unity version in ProjectVersion.txt');
  const editor = `"\${UNITY:-/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity}"`;
  const batch = `${unityPrepare} && ${editor} -batchmode -nographics`;
  return [
    { id: 'unity-compile', run: `${batch} -quit -projectPath "$(pwd -P)" -logFile .qualitygate/unity/compile.log`, timeoutMs: 1800000,
      report: { format: 'unity-log', path: '.qualitygate/unity/compile.log' } },
    { id: 'unity-tests', run: `${batch} -projectPath "$(pwd -P)" -runTests -testPlatform EditMode -testResults .qualitygate/unity/editmode.xml -logFile .qualitygate/unity/tests.log`,
      timeoutMs: 1800000, report: { format: 'nunit', path: '.qualitygate/unity/editmode.xml' } },
  ];
} };
