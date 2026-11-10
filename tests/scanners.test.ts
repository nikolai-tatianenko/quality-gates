import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinParsers } from '../packages/plugins/parsers/src/index.js';
import { commandPlugin } from '../packages/plugins/command/src/index.js';
import { filesystemPlugin } from '../packages/plugins/storage-fs/src/index.js';
import { jsonReporter } from '../packages/plugins/reporter-json/src/index.js';
import { configSchema } from '../packages/protocol/src/index.js';
import { run } from '../packages/core/src/index.js';
const ctx = { gateId: 'g', cwd: '/proj' };
const parse = (format: string, raw: string) => builtinParsers[format]!.parse(raw, ctx);

const SECRET = 'AKIAIOSFODNN7EXAMPLEs3cr3tV4lue';
const leak = (extra = {}) => ({ Description: 'AWS Access Key', StartLine: 12, EndLine: 12, StartColumn: 9, EndColumn: 40,
  Match: `aws_key = "${SECRET}"`, Secret: SECRET, File: 'src/config.ts', SymlinkFile: '', Commit: '', Entropy: 3.8, Author: '', Email: '', Date: '',
  Message: '', Tags: ['key', 'AWS'], RuleID: 'aws-access-token', Fingerprint: 'src/config.ts:aws-access-token:12', ...extra });

test('gitleaks reports rule, file and line and never keeps the match or the secret', () => {
  const findings = parse('gitleaks', JSON.stringify([leak(), leak({ File: 'a.env', StartLine: 3, StartColumn: 1, RuleID: 'generic-api-key', Description: '' })]));
  assert.deepEqual(findings, [
    { gateId: 'g', severity: 'error', ruleId: 'aws-access-token', file: 'src/config.ts', line: 12, column: 9, message: 'AWS Access Key' },
    { gateId: 'g', severity: 'error', ruleId: 'generic-api-key', file: 'a.env', line: 3, column: 1, message: 'Possible secret (generic-api-key)' }]);
  assert.ok(!JSON.stringify(findings).includes(SECRET));
  assert.deepEqual(parse('gitleaks', '[]'), []);
});
test('gitleaks exposes the values to scrub and rejects anything that is not a finding list', () => {
  assert.deepEqual(builtinParsers.gitleaks!.secrets!(JSON.stringify([leak(), leak({ Match: '', Secret: '' })])), [SECRET, `aws_key = "${SECRET}"`]);
  for (const raw of ['null', '{}', '"x"', '[{}]', '[1]', '[{"RuleID":"r","File":"f"}]', '[{"RuleID":"r","File":"f","StartLine":"1"}]', JSON.stringify([leak()]).slice(0, 80)])
    assert.throws(() => parse('gitleaks', raw), Error, raw);
});
test('gitleaks errors never echo the secret', () => {
  const bad = JSON.stringify([leak({ StartLine: SECRET })]);
  assert.throws(() => parse('gitleaks', bad), (error: Error) => !error.message.includes(SECRET) && /gitleaks/.test(error.message));
});

const advisory = (extra = {}) => ({ source: 1094544, name: 'semver', dependency: 'semver', title: 'semver vulnerable to Regular Expression Denial of Service',
  url: 'https://github.com/advisories/GHSA-c2qf-rxjj-qqgw', severity: 'high', cwe: ['CWE-1333'], cvss: { score: 7.5 }, range: '>=7.0.0 <7.5.2', ...extra });
const audit = (vulnerabilities: object) => JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: 2 }, dependencies: { total: 120 } } });
test('npm-audit makes one finding per advisory with severity, GHSA id and URL', () => {
  const raw = audit({
    semver: { name: 'semver', severity: 'high', isDirect: false, via: [advisory()], effects: ['node-gyp'], range: '>=7.0.0 <7.5.2', nodes: ['node_modules/semver'], fixAvailable: true },
    'node-gyp': { name: 'node-gyp', severity: 'high', isDirect: true, via: ['semver'], effects: [], range: '*', nodes: ['node_modules/node-gyp'], fixAvailable: false },
    tmp: { name: 'tmp', severity: 'low', isDirect: true, via: [advisory({ source: 5, name: 'tmp', title: 'tmp arbitrary write', url: 'https://example.com/x', severity: 'low' })], effects: [], range: '<0.2.4', nodes: [], fixAvailable: true },
    lodash: { name: 'lodash', severity: 'critical', isDirect: true, via: [advisory({ name: 'lodash', severity: 'moderate', url: 'not a url', source: 77 })], effects: [], range: '<4.17.21', nodes: [], fixAvailable: true },
    ms: { name: 'ms', severity: 'moderate', isDirect: true, via: [advisory({ name: 'ms', severity: undefined, source: undefined, url: undefined, title: 'ms ReDoS' })], effects: [], range: '<2.0.0', nodes: [], fixAvailable: true },
  });
  const findings = parse('npm-audit', raw);
  assert.deepEqual(findings[0], { gateId: 'g', severity: 'error', ruleId: 'GHSA-c2qf-rxjj-qqgw', message: 'semver: semver vulnerable to Regular Expression Denial of Service (>=7.0.0 <7.5.2)',
    helpUrl: 'https://github.com/advisories/GHSA-c2qf-rxjj-qqgw' });
  assert.deepEqual(findings.map(f => [f.ruleId, f.severity]), [['GHSA-c2qf-rxjj-qqgw', 'error'], ['5', 'info'], ['77', 'warning'], [undefined, 'warning']]);
  assert.equal(findings[1]?.helpUrl, 'https://example.com/x');
  assert.equal(findings[2]?.helpUrl, undefined);
  assert.equal(findings.length, 4);
});
test('npm-audit accepts a clean report and rejects error output, old formats and bad shapes', () => {
  assert.deepEqual(parse('npm-audit', audit({})), []);
  const bad = ['', 'null', '[]', '{}', JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'request failed' } }), JSON.stringify({ advisories: {}, metadata: {} }),
    JSON.stringify({ auditReportVersion: 1, vulnerabilities: {} }), JSON.stringify({ auditReportVersion: 2, vulnerabilities: [] }),
    audit({ a: { name: 'a', severity: 'scary', via: [] } }), audit({ a: { severity: 'low', via: [] } }), audit({ a: { name: 'a', severity: 'low', via: [3] } }),
    audit({ a: { name: 'a', severity: 'low', via: [{ source: 'one' }] } }), audit({ a: { name: 'a', severity: 'low' } }), audit({}).slice(0, 40)];
  for (const raw of bad) assert.throws(() => parse('npm-audit', raw), Error, raw);
});
test('npm-audit keeps a vulnerable package whose via list is empty as one finding', () => {
  assert.deepEqual(parse('npm-audit', audit({ a: { name: 'a', severity: 'moderate', via: [], range: '*' } })), [{ gateId: 'g', severity: 'warning', message: 'a: vulnerable (*)' }]);
  assert.deepEqual(parse('npm-audit', audit({ a: { name: 'a', severity: 'info', via: [] } })), [{ gateId: 'g', severity: 'info', message: 'a: vulnerable' }]);
});
test('npm-audit keeps a package whose via entries are all strings when a referenced package is missing from the report', () => {
  const present = { name: 'b', severity: 'high', via: [advisory({ name: 'b' })], range: '*' };
  const chained = (via: string[]) => parse('npm-audit', audit({ a: { name: 'a', severity: 'high', via, range: '<2' }, b: present })).filter(finding => finding.message.startsWith('a:'));
  assert.deepEqual(chained(['gone']), [{ gateId: 'g', severity: 'error', message: 'a: vulnerable via gone (<2)' }]);
  assert.deepEqual(chained(['b', 'gone'])[0], { gateId: 'g', severity: 'error', message: 'a: vulnerable via gone (<2)' });
  assert.deepEqual(chained(['b']), []);
});

const osv = (vuln: object, extra = {}) => JSON.stringify({ results: [{ source: { path: '/proj/package-lock.json', type: 'lockfile' }, packages: [
  { package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' }, vulnerabilities: [vuln], groups: [{ ids: ['GHSA-35jh-r3h4-6jhm'], max_severity: '7.2' }], ...extra }] }] });
const ghsa = (extra = {}) => ({ id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], summary: 'Command Injection in lodash', details: 'long text',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }], database_specific: { severity: 'HIGH' }, ...extra });
test('osv-scanner findings carry the advisory id, aliases, package, relative file and OSV link', () => {
  assert.deepEqual(parse('osv-scanner', osv(ghsa())), [{ gateId: 'g', severity: 'error', ruleId: 'GHSA-35jh-r3h4-6jhm', file: 'package-lock.json',
    message: 'lodash@4.17.20: Command Injection in lodash (CVE-2021-23337)', helpUrl: 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm' }]);
  const level = (severity: unknown, extra = {}) => parse('osv-scanner', osv(ghsa({ database_specific: { severity }, ...extra })))[0]?.severity;
  assert.deepEqual(['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'weird' /* unknown name: the group score 7.2 decides */].map(s => level(s)), ['error', 'error', 'warning', 'info', 'error']);
});
test('osv-scanner falls back to the group score, then to a warning, and copes with sparse entries', () => {
  const score = (max: string | undefined) => parse('osv-scanner', JSON.stringify({ results: [{ source: { path: 'a/yarn.lock' }, packages: [
    { package: { name: 'x', version: '1', ecosystem: 'npm' }, vulnerabilities: [{ id: 'OSV-1', details: 'First line\nsecond' }], groups: [{ ids: ['OSV-1'], ...(max ? { max_severity: max } : {}) }] }] }] }));
  assert.deepEqual(['9.8', '7', '5.5', '2.1', 'n/a', undefined].map(max => score(max)[0]?.severity), ['error', 'error', 'warning', 'info', 'warning', 'warning']);
  const rated = (severity: string) => parse('osv-scanner', JSON.stringify({ results: [{ source: { path: 'a/yarn.lock' }, packages: [{ package: { name: 'x', version: '1' },
    vulnerabilities: [{ id: 'OSV-1', database_specific: { severity } }] }] }] }))[0]!.severity;
  assert.deepEqual(['constructor', '__proto__', 'toString', 'HIGH'].map(rated), ['warning', 'warning', 'warning', 'error']);
  assert.deepEqual(score('9.8')[0], { gateId: 'g', severity: 'error', ruleId: 'OSV-1', file: 'a/yarn.lock', message: 'x@1: First line', helpUrl: 'https://osv.dev/vulnerability/OSV-1' });
  const bare = parse('osv-scanner', JSON.stringify({ results: [{ source: { path: '/elsewhere/Gemfile.lock' }, packages: [{ package: { name: 'y', version: '2', ecosystem: 'RubyGems' }, vulnerabilities: [{ id: 'OSV-2' }] }] }] }));
  assert.deepEqual(bare, [{ gateId: 'g', severity: 'warning', ruleId: 'OSV-2', message: 'y@2: OSV-2', helpUrl: 'https://osv.dev/vulnerability/OSV-2' }]);
});
test('osv-scanner accepts a clean report and rejects anything that is not a result list', () => {
  assert.deepEqual(parse('osv-scanner', '{"results":[]}'), []);
  assert.deepEqual(parse('osv-scanner', JSON.stringify({ results: [{ source: { path: 'p' }, packages: [] }] })), []);
  const bad = ['', 'null', '[]', '{}', '{"results":{}}', '{"results":[{}]}', '{"results":[{"source":{"path":"p"}}]}', '{"results":[{"source":{},"packages":[]}]}',
    JSON.stringify({ results: [{ source: { path: 'p' }, packages: [{ package: { name: 'x' }, vulnerabilities: [] }] }] }),
    JSON.stringify({ results: [{ source: { path: 'p' }, packages: [{ package: { name: 'x', version: '1' }, vulnerabilities: [{ summary: 's' }] }] }] }), osv(ghsa()).slice(0, 60)];
  for (const raw of bad) assert.throws(() => parse('osv-scanner', raw), Error, raw);
});

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'qg-scan-')));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const exec = (dir: string, gate: object) => run(configSchema.parse({ schemaVersion: 1, gates: [{ id: 'secrets', ...gate }], outputDir: join(dir, 'out') }),
  { gate: commandPlugin(dir, builtinParsers), storage: filesystemPlugin(join(dir, 'out')), reporter: jsonReporter });
const everything = async (dir: string): Promise<string> => {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  return (await Promise.all(files.map(entry => readFile(join(entry.parentPath, entry.name), 'utf8')))).join('\n');
};
/** Puts the report in place (inside the freshness window) and returns a command that succeeds. */
const prepared = (dir: string, raw: string) => writeFile(join(dir, 'gitleaks.json'), raw).then(() => 'true');
test('a gitleaks gate blocks on a leak and the secret is nowhere in the saved run, even when the tool prints it', () => withDir(async dir => {
  await writeFile(join(dir, 'gitleaks.json'), JSON.stringify([leak()]));
  process.env.QG_TEST_LEAK = SECRET;
  const printing = 'echo "Finding: $QG_TEST_LEAK"; echo "Secret: $QG_TEST_LEAK" >&2; exit 1';
  const result = await exec(dir, { run: printing, report: { format: 'gitleaks', path: 'gitleaks.json' }, artifacts: [] });
  delete process.env.QG_TEST_LEAK;
  const gate = result.gates[0]!;
  assert.match(gate.outputTail, /Finding: \[redacted\]/);
  assert.equal(result.decision, 'BLOCK'); assert.equal(gate.exitCode, 1);
  assert.deepEqual(gate.findings.map(f => [f.ruleId, f.file, f.line]), [['aws-access-token', 'src/config.ts', 12]]);
  assert.deepEqual(gate.artifacts, []);
  const saved = await everything(join(dir, 'out'));
  assert.ok(saved.includes('aws-access-token')); assert.ok(!saved.includes(SECRET)); assert.ok(!JSON.stringify(result).includes(SECRET));
}));
test('a gitleaks gate with exit 0 and a clean report passes; a missing, truncated or empty report never does', () => withDir(async dir => {
  const clean = await exec(dir, { run: await prepared(dir, '[]'), report: { format: 'gitleaks', path: 'gitleaks.json' } });
  assert.equal(clean.decision, 'PASS'); assert.deepEqual(clean.gates[0]!.findings, []);
  const truncated = await exec(dir, { run: await prepared(dir, '[{"RuleID":"aws'), report: { format: 'gitleaks', path: 'gitleaks.json' } });
  assert.equal(truncated.decision, 'BLOCK'); assert.equal(truncated.gates[0]!.execution, 'error');
  const missing = await exec(dir, { run: 'true', report: { format: 'gitleaks', path: 'nope.json' } });
  assert.equal(missing.decision, 'BLOCK'); assert.match(missing.gates[0]!.errors.join(), /Report not found/);
  const crashed = await exec(dir, { run: 'exit 3', report: { format: 'gitleaks', path: 'nope.json' } });
  assert.equal(crashed.decision, 'BLOCK'); assert.equal(crashed.gates[0]!.exitCode, 3);
}));
test('a secret scanner fails closed: with no usable report the printed output is withheld, never stored', () => withDir(async dir => {
  process.env.QG_TEST_LEAK = SECRET;
  const printing = 'echo "Finding: $QG_TEST_LEAK"; echo "Secret: $QG_TEST_LEAK" >&2';
  const report = (path: string) => ({ format: 'gitleaks', path });
  const cases: [string, object][] = [
    ['missing report', { run: `${printing}; exit 1`, report: report('nope.json') }],
    ['missing report with exit 0', { run: printing, report: report('nope.json') }],
    ['crashed', { run: `${printing}; exit 3`, report: report('nope.json') }],
    ['truncated report', { run: `${printing}; printf '[{"RuleID":"aws' > gitleaks.json; exit 1`, report: report('gitleaks.json') }],
    ['unreadable entries', { run: `${printing}; printf '[1,2]' > gitleaks.json; exit 1`, report: report('gitleaks.json') }],
    ['timed out', { run: `${printing}; sleep 30`, timeoutMs: 400, report: report('gitleaks.json') }]];
  for (const [name, gate] of cases) {
    const result = await exec(dir, gate);
    const saved = await everything(join(dir, 'out')) + JSON.stringify(result);
    assert.ok(!saved.includes(SECRET), `${name}: the secret was stored`);
    assert.match(result.gates[0]!.outputTail, /output withheld/, name);
    assert.notEqual(result.decision, 'PASS', name);
    await rm(join(dir, 'out'), { recursive: true, force: true });
  }
  delete process.env.QG_TEST_LEAK;
}));
test('an npm audit gate that crashed with an error object stays an error, and a clean report passes', () => withDir(async dir => {
  const offline = await exec(dir, { run: await prepared(dir, '{"error":{"code":"ENOTFOUND"}}'), report: { format: 'npm-audit', path: 'gitleaks.json' } });
  assert.equal(offline.decision, 'BLOCK'); assert.match(offline.gates[0]!.errors.join(), /Invalid npm-audit report/);
  const ok = await exec(dir, { run: await prepared(dir, audit({})), report: { format: 'npm-audit', path: 'gitleaks.json' } });
  assert.equal(ok.decision, 'PASS');
}));
