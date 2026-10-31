# SonarQube and agent review

QualityGate combines deterministic checks and agent review in the same run,
report, dashboard and MCP `run_gates` response. These integrations are opt-in.
They do not replace the existing ESLint/SonarJS or Python/Ruff analysis.

## SonarQube

Use a project-selected SonarScanner and an existing SonarQube instance.
Community Build is the free self-managed option; commercial editions and Cloud
plans have different capabilities. QualityGate does not install or license SonarQube.
See the [official comparison](https://docs.sonarsource.com/sonarqube-community-build/feature-comparison-table).

```yaml
schemaVersion: 1
gates:
  - id: sonar
    type: sonarqube
    run: sonar-scanner -Dsonar.host.url=http://127.0.0.1:9000 -Dsonar.qualitygate.wait=false
    timeoutMs: 300000
    sonar:
      serverUrl: http://127.0.0.1:9000
      tokenEnv: SONAR_TOKEN
      taskFile: .scannerwork/report-task.txt
```

Configure the scanner's project key, sources and coverage in your project's
`sonar-project.properties`. Install its supported runtime separately. Supply the
token through the environment, never a command literal or committed configuration.
The scanner and adapter must use the same token/server configuration. Disable
`sonar.qualitygate.wait` in the scanner: QualityGate owns that wait and distinguishes
a scanner failure from a completed analysis whose quality gate blocks. Use HTTPS
for a remote server; HTTP in the example is for a local server only.

Before executing the scanner, the adapter removes the previous task file. Scanner
failure is an execution error. After success, the adapter reads the new CE task ID,
polls `api/ce/task`, and requests `api/qualitygates/project_status` using that
**analysis ID**, never the project's potentially stale latest analysis. The total
scanner/poll/request budget is `timeoutMs` (default five minutes). Cancellation
stops polling and the owned scanner process group.

`OK` with no failed/missing conditions passes; `ERROR` or a failed/missing condition
blocks. `NONE`, malformed data, mismatched task/server, authentication failure,
failed/cancelled CE task and timeout are execution errors. Findings describe gate
conditions; this first adapter does **not** fetch individual Sonar issues with source
locations. Raw evidence includes server URL, task ID, analysis ID and gate response.
The configured token is redacted from scanner output and saved adapter evidence.
Do not print other credentials from scanner scripts.

## External methodologies

Add a source to the same project configuration:

```yaml
reviewSources:
  - id: cloudflare
    repository: https://github.com/cloudflare/security-audit-skill
    ref: main
    path: skills/security-audit
```

From the installed CLI (or substitute `node /path/to/qualitygate/dist/qualitygate.mjs`):

```sh
qualitygate sources sync --config /path/to/project/.qualitygate.yml --json
qualitygate sources restore --config /path/to/project/.qualitygate.yml --json
qualitygate sources list --config /path/to/project/.qualitygate.yml --json
qualitygate sources check --config /path/to/project/.qualitygate.yml --json
qualitygate sources read cloudflare --config /path/to/project/.qualitygate.yml --json
qualitygate sources read cloudflare LICENSE --config /path/to/project/.qualitygate.yml --json
```

`sync` explicitly fetches the configured GitHub repositories and replaces
`qualitygate.sources.lock.json` only after every fetch succeeds. Commit this lockfile.
Review its diff when updating: a new upstream version is not automatically trusted
by a running gate. The pnpm seven-day quarantine applies to registry packages;
it does not delay Git methodology revisions. `check` reports updates without changing the lock. It returns
zero on a successful check even when updates exist; inspect `updateAvailable`.
Use branch refs such as `main`; the initial implementation does not resolve
annotated-tag dereferencing for update checks.

The ignored `.qualitygate-review-sources/` cache holds bare Git stores keyed by
source ID and commit. A fresh machine runs `sources restore` to fetch the exact locked commits without
changing the lock. Use `sync` only when intentionally selecting new revisions. Fetches have a 60-second
limit per Git operation and bounded captured output; there is no download-size or
OS resource sandbox. Git global/system configuration and hooks are disabled, and
there is no checkout, submodule update, dependency installation or execution of
remote scripts. Downloading/reading a source does not run an audit. Source reads
are local after sync; a missing cache or missing lock is an explicit error.

MCP adds the read-only tool `get_review_methodology`:

```json
{"sourceId":"cloudflare","file":"SKILL.md"}
```

Read sibling Markdown/JSON/CJS files as reference text through the same tool; request `LICENSE` for the
root license. CJS validators are returned as text and never executed by this tool.
Responses include the repository, ref, exact commit and content.
Only configured source IDs and allowed basenames are accepted. MCP never updates
sources or accepts a repository URL from the model. The bounded `ask` adapter can
read these files, but still has no editor, shell or subagent tools.

Cloudflare's repository is MIT; retain its copyright and license when copying or
redistributing its contents. Its methodology requires an agent with independent
subagents and OS-enforced isolation for target-controlled execution. Our command
gates are **not sandboxed**. A missing required execution capability must remain
`needs_validation`; source download alone does not establish compliance with the
methodology. See [Cloudflare requirements](https://github.com/cloudflare/security-audit-skill#requirements).

## Importing actual agent review results

A trusted project-owned producer performs the review and prints exactly one JSON
object to stdout. Send progress messages to stderr. It may invoke an appropriate
agent runtime; QualityGate itself does not provide the multi-agent audit harness
or sandbox. Do not point this gate at a static old report and call that a fresh review.

```yaml
gates:
  - id: security-review
    type: review
    run: node scripts/review-producer.mjs
    timeoutMs: 300000
    review:
      sourceId: cloudflare
```

Producer output contract (a shortened finding, not a claim of an actual audit):

```json
{
  "schemaVersion": 1,
  "completed": true,
  "methodology": {
    "id": "cloudflare",
    "commit": "<40-character commit from qualitygate.sources.lock.json>"
  },
  "findings": [
    {
      "verdict": "needs_validation",
      "finding": {
        "severity": "warning",
        "message": "Authorization candidate needs isolated reproduction",
        "file": "src/auth.ts",
        "line": 12,
        "ruleId": "authorization/candidate"
      }
    }
  ]
}
```

This is QualityGate's normalized envelope, **not** Cloudflare's `findings.json`
schema. A Cloudflare producer must run that methodology's validators and independent
verification first, retain its original artifacts, and map its records into this
contract. `completed: true` is the producer's assertion, not proof independently
established by QualityGate. A zero-finding completed report may pass. The full
upstream schema, coverage ledger and independent-verifier requirements are not
validated by this adapter.

- Confirmed `error`/`warning` findings block; confirmed `info` findings do not.
- `needs_validation` always blocks and appears as a warning.
- `rejected` remains in evidence and appears as informational.
- Missing completion, mismatched methodology ID/commit, malformed/oversized JSON,
  nonzero producer exit, timeout or cancellation cannot produce PASS.

The standard run report includes normalized findings with locations and evidence
paths. Raw review evidence includes source provenance and the original producer
stdout, including rejected or malformed records. This release does not bind a
review to a source-tree digest or prevent a trusted producer from lying or reusing
an old report. Exact worktree binding is a follow-up before treating agent review
as an unattended release approval.

## Verification scope

Automated tests use real scanner/producer subprocesses, mocked Sonar HTTP responses,
real local Git repositories, and MCP client/server transports. They cover PASS,
BLOCK, malformed reports, task identity, deadlines, cancellation, source updates,
failed downloads, lock preservation and provenance. Live SonarQube server/scanner
compatibility and a full Cloudflare multi-agent audit are not yet verified.

This integration was developed and verified locally. These commands do not post
review comments, push commits or publish artifacts to GitHub.
