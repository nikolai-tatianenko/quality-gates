# CI and PR-description integration verification — 2026-10-30

`pnpm check` passed with **72 tests**, lint, strict types, complexity analysis and
build. Runtime line/statement/function coverage is 100%; branches are 96.66%.
Four focused tests also passed with CLI subprocesses using the built bundle.

`pnpm verify:ci-templates` parsed GitHub/GitLab/Bitbucket YAML and executed the
report shell blocks against fixture commands. Each provider preserved gate exits
0/1/2/130 and propagated renderer failure. GitHub's base-checkout, separate write
permissions, fork guard and non-edited trigger were checked locally.

The packed CLI includes the CI guide and all three templates. API tests use fixture
responses for all providers and a real localhost HTTP server for the CLI. No real
PR/MR, remote pipeline or account configuration was changed. GitLab/Bitbucket need
separately provisioned trusted publishers. Last-read/write races and the lack of
cryptographic source binding remain explicit limits in [CI setup](CI.md).
Machine-readable [CI verification snapshot](verification/ci-integrations-2026-10-30.json).

---

# SonarQube and review integration verification — 2026-10-30

`pnpm check` passed: **68 tests**, lint, strict typecheck, complexity analysis and
build. Runtime coverage remains 100% lines/statements/functions and 96.36% branches.
New adapters use real subprocesses and local Git repositories; Sonar HTTP replies
are mocked, and MCP requests use real client/server transports.

The official Cloudflare source was downloaded, restored by exact SHA and checked
against upstream locally. The example pins commit
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`. A real stdio MCP client retrieved its
methodology and provenance. No downloaded scripts were executed. Failed downloads
preserve the lock; update checks do not activate new versions.

The first consumer smoke run exposed a fixture audit exceeding its hard-coded
60-second budget. Completed fixture audits took 36–49 seconds inside Lighthouse,
including 14–30 seconds clearing browser caches, before Chrome startup/cleanup.
The runner correctly saved an execution error and cleaned its Chrome processes.
The smoke harness now uses the production default of 120 seconds; its explicit
2.5-second timeout and SIGINT checks remain separate. This is a test-budget
alignment, not a claim that the underlying Chrome/cache latency has been fixed.

The final `pnpm verify:package` passed: local tarball installation, real Chrome
PASS/BLOCK, mixed URL results, missing Chrome, timeout, SIGINT and write failure.
Every browser scenario asserted owned-process cleanup. The installed CLI also
read the pinned Cloudflare CJS validator as inert text; the package example
contains only config/lock files, without the downloaded Git cache.
Machine-readable [integration snapshot](verification/review-integrations-2026-10-30.json).
No push, publication or remote CI run was performed.

Live SonarQube server/scanner compatibility, a complete Cloudflare multi-agent
audit, upstream report/coverage-ledger verification and an isolated target runner
remain unverified or unimplemented. Review producer assertions are trusted and
are not yet bound to an exact worktree digest. See [setup and limits](SECURITY_REVIEW.md).

---

# Dependency policy verification — 2026-10-30

The repository now requires pnpm 11.5.1 and a strict seven-day minimum registry
release age (10080 minutes), without age exclusions. Native developer-engine
checks reject npm checkout installs even with scripts disabled; a dependency-free
preinstall guard covers other managers/versions. Packaged CLI consumers retain
package-manager choice.

The initial lockfile was rejected for six too-recent entries. Fresh resolution
selected compatible eligible versions rather than bypassing the age policy:
MCP SDK 1.32.1, Hono 4.13.13, ignore 7.0.13, ip-address 10.7.4,
legacy-javascript 0.0.3 and qs 6.16.1. Fresh and frozen-lockfile installs passed.

`pnpm verify:release` passed all four stages with **62 tests**, 100% runtime
lines/statements/functions and 95.82% branches. Packaging uses pnpm; npm consumer
installation checks run outside the checkout. The packaged guard is also checked
in consumer mode. `pnpm smoke` separately passed against the locked source graph,
including real Chrome, timeout, SIGINT and owned-process cleanup. CI now checks
both source and consumer browser workflows.

Machine-readable [policy verification snapshot](verification/dependency-policy-2026-10-30.json)
includes tested configuration hashes, test totals and local run results. No push,
publication or remote CI run was performed. Code-style configuration and the
current limits of project overrides are documented in [CODE_QUALITY.md](CODE_QUALITY.md).

---

# GitHub developer-preview acceptance — 2026-10-30

Source commit: `b33356b92a053b329204ffb38fc0d209a82ec653` (local branch `feature/new_solution`).
Machine-readable [verification snapshot](verification/local-release-2026-10-30.json).

`pnpm install --frozen-lockfile` and the complete `pnpm verify:release` passed:

| Step | Result |
| --- | --- |
| Lint, types, code analysis, 60 tests, coverage and builds | PASS |
| Standalone analyzer tarball API/CLI, TypeScript and Python | PASS |
| Installed CLI tarball: Chrome, errors, timeout, SIGINT and no owned Chrome leaks | PASS |
| Documented `pnpm dashboard` command in real Chrome: Python BLOCK → source fix → PASS | PASS |

Coverage remains 100% lines/statements/functions and 95.83% branches. The
workflow now includes the analyzer package and actual dashboard command/browser
check. README/CHANGELOG distinguish verified features from experimental model
and editor integrations; local links and referenced Python fixtures are committed.

The first release run exposed an overly short 15-second fixture-readiness wait in
the SIGINT smoke test. Process monitoring now runs asynchronously without blocking
the HTTP fixture; readiness uses the configured audit budget. Test failure also
waits for CLI cleanup and diagnoses leaks before emergency cleanup, so cleanup
cannot turn a leak into a passing assertion. The complete release command then
passed all four stages sequentially.

This is ready to share as a **developer preview**. No push, package publication or
remote GitHub Actions run occurred. The first remote CI result still has to be
checked after an authorized push. Existing tags were left intact.

---

# Local self-analysis, Python and React verification — 2026-10-29

- Final `pnpm check` passed: lint, strict typecheck, code analysis, **60 tests**,
  enforced coverage and all workspace builds.
- Runtime TypeScript/TSX coverage: **100% statements/lines (1196/1196), 100%
  functions (97/97), 95.83% branches (713/744)**. The floors are 100/100/100/95 in
  `.c8rc.json`. HTML, JSON summary, raw JSON and LCOV are in `coverage/`.
- Every runtime file in `packages/` is included even if never imported. The only
  explicit source exclusion is `plugin-sdk/src/index.ts`, which contains only
  TypeScript interfaces/types. Dependencies, generated bundles, tests, tooling
  scripts, CSS and the legacy archive are outside this runtime coverage scope.
- A fresh temporary workspace excluded all node_modules/dist/coverage from its
  copy, installed the frozen lockfile, and passed the complete check/build pipeline.
- Self-check through QualityGate used the repository's actual four gates (lint,
  typecheck, analysis, coverage tests) plus a local HTML preview of its README.
  Result: PASS, scores performance 100 / accessibility 100 / SEO 91 /
  best-practices 100. This is self-use on this repository, not an external adoption
  claim. Evidence: `.qualitygate/project-verification/`.
- The standalone `@qualitygate/code-analysis` tarball installed with npm in a
  temporary directory and passed executable/API checks and TS/Python BLOCK → PASS.
  It uses ESLint/SonarJS and Ruff 0.9.2, not a new parser or hand-written complexity
  algorithm. Its configured rules report no current product-code violations.
- A real Chrome 156 session used the React UI to run Python analysis + unittest,
  received F401/BLOCK, then PASS after removing the unused import. Desktop and
  mobile screenshots were visually inspected; mobile overflow and browser JS
  errors were checked. Evidence: `.qualitygate/dashboard-smoke/`.
- The updated CLI tarball passed real Chrome PASS, BLOCK, mixed URL failure,
  missing Chrome, timeout, SIGINT, storage failure and plain/JSON output scenarios.
  The harness checked owned Chrome PIDs after each run. An earlier concurrent smoke
  exposed a timeout/profile-cleanup race; cleanup now kills and reaps the owned
  process before asking the launcher to remove its profile. A regression test
  asserts that ordering using real child processes; the repeated smoke passed.
  Evidence: `.qualitygate/smoke-mQ8qEE/`.
- A local Linux arm64 container reproduced the root Chrome sandbox startup failure
  and passed a real audit with the explicit isolated-container opt-in. Startup
  diagnostics now read the actual launcher file, `chrome-err.log`. See
  [environments](ENVIRONMENTS.md) for exact versions, commands and limits.
- MCP tests cover active cancellation, child-process cleanup, disconnect drain,
  and overlapping-run rejection while reads remain available. Model adapters have
  local HTTP contract tests and a real stdio MCP roundtrip. Live model inference
  and every editor's UI have not been validated; see [integrations](INTEGRATIONS.md).

All work and verification in this stage stayed local. GitHub Actions YAML was
updated/parsed but no remote workflow, push or package publication was performed.
The earlier release notes below remain historical verification records.

---

# v0.1.0 release verification — 2026-10-28

- Frozen-lockfile install, lint, strict typecheck, 24 tests and build passed after
  removing the root legacy dependencies. A fresh temporary workspace passed the
  same checks.
- `pnpm verify:package` passed after a local tarball install: real Chrome PASS,
  BLOCK, mixed URL failure, missing Chrome, timeout, SIGINT and storage-error
  scenarios all returned the expected codes and cleaned up owned Chrome processes.
- A real Claude Code session called QualityGate through MCP, received BLOCK,
  read the failing assertion, edited only the implementation, and received PASS.
  The recorder asserted that the tests/config were unchanged. The published GIF
  and MP4 are 75-second paced replays, verified with ffprobe and inspected visually.
  The sanitized tool transcript is in `docs/demo/session.json`.
- QualityGate now uses MIT. The archived Lighthouse v1 source retains ISC in its
  own directory and has a separate dependency installation outside the workspace.
- Issues #1 (ESLint/Vitest plugins) and #2 (structured inspection) record follow-up
  work. Repository description/topics and private vulnerability reporting are set.

The notes below describe the original local prototype baseline, before command
gates, MCP and the public v0.1.0 release preparation.

---

# Prototype verification — 2026-10-27

Environment: macOS, Node 22.19.0, pnpm 11.5.1, Lighthouse 12.8.2,
Chrome 156 (host user agent recorded in raw evidence).

## Checks

- `pnpm check`: lint, strict typecheck, 13 tests and bundled CLI/worker build pass.
- `pnpm verify:clean`: fresh temporary workspace, frozen-lockfile pnpm install,
  all 13 tests, lint, typecheck and build pass.
- `pnpm smoke`: real Chrome against the local fixture; JSON output parses against
  the protocol schema and matches the persisted report.
- `pnpm verify:package`: builds and packs locally, installs the tarball with npm in
  an isolated temporary directory, checks the executable and init command, then
  runs the real Chrome smoke suite using the installed CLI and worker.

## Observed workflow

| Scenario | Exit | Result |
| --- | --- | --- |
| Two valid local URLs, all thresholds zero | 0 | PASS, separate scores and raw evidence |
| Same fixture, SEO threshold 100 | 1 | BLOCK |
| Valid URL followed by an inaccessible URL | 2 | Both results retained; audit error takes precedence over BLOCK |
| Missing Chrome | 2 | Explicit browser error, summary saved |
| Hanging navigation with a 2.5-second timeout | 2 | Timeout recorded, Chrome cleaned |
| SIGINT during hanging navigation | 130 | Interrupted summary; next URL skipped; Chrome cleaned |
| Output path occupied by a regular file | 2 | Storage error; completed audit still returned in JSON |
| Invalid config | 2 | Versioned JSON error envelope |

The smoke suite records owned Chrome PIDs during each CLI run and checks that they
no longer exist after exit. Raw Lighthouse JSON and the summary are preserved in
`.qualitygate/smoke-*`; every run has a unique ID.

Unit/integration coverage additionally verifies incompatible plugin versions,
duplicate registration, independent custom audit plugins, required missing metrics,
identical saved scores under passing/blocking thresholds, exclusive config creation,
unknown CLI arguments, an executable with a nonexistent interpreter, cleanup errors,
real atomic-report rename failure, interruption during report writing, and simultaneous
audit/evidence errors. Scores are rounded to integer percentages to avoid floating
point boundary errors such as 0.58 becoming 57.99999999999999.

The GitHub Actions workflow has been updated and its YAML parsed locally. It was
not executed on GitHub: this work intentionally has no push, PR or publication.
The ISC license, legacy CLI entrypoint and existing uncommitted user materials remain.
