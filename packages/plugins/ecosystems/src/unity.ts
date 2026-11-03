import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemPlugin } from '../../../plugin-sdk/src/index.js';

/**
 * Shell prefix for every Unity gate: refuse while an editor is running, otherwise drop a stale
 * `Temp/UnityLockfile`, then create the output folder.
 */
export const unityPrepare = '{ if [ -f Temp/UnityLockfile ]; then if pgrep -x Unity >/dev/null 2>&1; then '
  + "echo 'Unity project is open in an editor; close it first' >&2; exit 1; fi; rm -f Temp/UnityLockfile; fi; mkdir -p .qualitygate/unity; }";

/** Proposes a compile check (`unity-log`) and EditMode tests (`nunit`) run through Unity batch mode. */
export const unity: EcosystemPlugin = { id: 'unity', apiVersion: 1, kind: 'ecosystem', async detect(directory) {
  const raw = await readFile(join(directory, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').catch(() => undefined);
  if (raw === undefined) return null;
  const version = /^m_EditorVersion:[ \t]*([0-9A-Za-z.]+)[ \t]*\r?$/m.exec(raw)?.[1];
  if (!version) throw new Error('Unreadable Unity version in ProjectVersion.txt');
  const editor = `"\${UNITY:-/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity}"`;
  const batch = `${unityPrepare} && ${editor} -batchmode -nographics`;
  return [
    { id: 'unity-compile', run: `${batch} -quit -projectPath . -logFile .qualitygate/unity/compile.log`, timeoutMs: 1800000,
      report: { format: 'unity-log', path: '.qualitygate/unity/compile.log' } },
    { id: 'unity-tests', run: `${batch} -projectPath . -runTests -testPlatform EditMode -testResults .qualitygate/unity/editmode.xml -logFile .qualitygate/unity/tests.log`,
      timeoutMs: 1800000, report: { format: 'nunit', path: '.qualitygate/unity/editmode.xml' } },
  ];
} };
