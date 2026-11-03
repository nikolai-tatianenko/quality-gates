import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { parse } from 'yaml';
const exec = promisify(execFile);
const load = async name => parse(await readFile(`examples/ci/${name}`, 'utf8'));
const github = await load('github-actions.yml');
const gitlab = await load('gitlab-ci.yml');
const bitbucket = await load('bitbucket-pipelines.yml');
assert.equal(github.permissions.contents, 'read');
assert.equal(github.jobs.publish.permissions['pull-requests'], 'write');
assert.equal(github.jobs.check.permissions, undefined);
assert.ok(github.jobs.publish.steps[0].with.ref.includes('pull_request.base.sha'));
assert.ok(github.jobs.publish.steps.some(step => step.run?.includes('--ignore-scripts')));
assert.ok(github.jobs.publish.if.includes('head.repo.full_name == github.repository'));
assert.equal(github.jobs.publish.permissions.statuses, 'write');
assert.equal(github.jobs.check.permissions, undefined);
const publishRuns = github.jobs.publish.steps.map(step => step.run ?? '').join('\n');
for (const command of ['qualitygate status', 'qualitygate comment', 'qualitygate notify']) assert.ok(publishRuns.includes(command), `${command} runs in the trusted publish job`);
assert.ok(!github.jobs.check.steps.some(step => /qualitygate (status|comment|notify|pr)\b/.test(step.run ?? '')), 'Check job must not publish');
assert.ok(github.jobs.publish.steps.find(step => step.run?.includes('qualitygate status')).run.includes('--head-repository'));
assert.ok(!github.on.pull_request.types.includes('edited'));
assert.equal(gitlab.qualitygate.artifacts.when, 'always');
const scripts = {
  github: github.jobs.check.steps.find(step => step.name === 'Run gates and render report').run,
  gitlab: gitlab.qualitygate.script[0],
  bitbucket: bitbucket.pipelines['pull-requests']['**'][0].step.script.at(-1),
};
const directory = await mkdtemp(join(tmpdir(), 'qg-ci-templates-'));
try {
  const bin = join(directory, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'pnpm'), '#!/bin/bash\nif [ "$3" = run ]; then printf \'{"fixture":true}\\n\'; exit "$QG_RUN_EXIT"; fi\nif [ "$3" = report ]; then printf report > "${@: -1}"; exit "$QG_REPORT_EXIT"; fi\nexit 99\n', { mode: 0o755 });
  for (const [provider, script] of Object.entries(scripts)) {
    assert.ok(!script.includes('--write'), 'Target code jobs must not publish');
    for (const [runExit, reportExit, expected] of [[0, 0, 0], [1, 0, 1], [2, 0, 2], [130, 0, 130], [0, 2, 2]]) {
      let code = 0;
      try { await exec('/bin/bash', ['-e', '-c', script], { cwd: directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QG_RUN_EXIT: String(runExit), QG_REPORT_EXIT: String(reportExit) } }); }
      catch (error) { code = error.code; }
      assert.equal(code, expected, `${provider}: gate ${runExit}, renderer ${reportExit}`);
      assert.equal((await readFile(join(directory, '.qualitygate-ci/exit-code'), 'utf8')).trim(), String(runExit));
      assert.equal(await readFile(join(directory, '.qualitygate-ci/report.md'), 'utf8'), 'report');
    }
    console.log(`${provider}: YAML, publication boundary and exit-code preservation passed`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
