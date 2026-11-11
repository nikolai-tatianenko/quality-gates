# Project tasks

## M1 — Build
- [x] [T-001] Define the first deliverable and acceptance criteria

## QualityGate prototype
- [x] T-001: Scope, acceptance criteria and legacy defect inventory (`docs/PROTOTYPE.md`)
- [x] T-002: Strict TypeScript workspace, build, lint and test checks
- [x] T-003: Versioned contracts, plugin lifecycle and deterministic policy
- [x] T-004: Sequential Lighthouse execution and durable evidence
- [x] T-005: init/run CLI and exit semantics
- [x] T-006: Real Chrome smoke, CI, quickstart and tarball verification
- [x] T-007: Command gates (exit-code checks) for any project, with process-group cleanup
- [x] T-008: MCP stdio server (`list_gates`, `run_gates`, `get_run`) returning the CLI verdict

## v0.1.0 release presentation
- [x] T-009: Archive Lighthouse v1 outside the workspace; remove root legacy dependencies
- [x] T-010: MIT license, CONTRIBUTING.md and SECURITY.md with explicit unsandboxed execution
- [x] T-011: Real Claude Code → MCP BLOCK → implementation fix → PASS demo
- [x] T-012: v0.1.0 release preparation, repository metadata and follow-up Issues (tag after CI)

## Local self-analysis and React workspace
- [x] T-013: Reusable code-analysis workspace package, API/CLI and standalone tarball verification
- [x] T-014: TypeScript/SonarJS complexity checks and Python/Ruff adapter with real regression tests
- [x] T-015: React dashboard using the shared service, run/cancel, findings and evidence
- [x] T-016: 60 tests, complete runtime line/function coverage and enforced branch coverage floor
- [x] T-017: Self-use on this repository: lint, typecheck, analysis, coverage and local Lighthouse URL
- [x] T-018: Chrome startup stderr, profile-cleanup ordering and local Linux sandbox reproduction
- [x] T-019: MCP cancellation/disconnect/concurrency and client configuration/model adapters

## Pluggable ecosystems and test reports
Design: `docs/design/2026-11-01-pluggable-ecosystems-design.md` (approved 2026-11-01).
Order: parsers → ecosystems → external loading; each part ships on its own. Keep exit codes
0/1/2/130, SDK `apiVersion: 1` (additive), 100% line / 95% branch coverage.
- [x] T-020: `parser` plugin kind and `report: { format, path }` on command gates; built-in `junit`, `nunit`, `playwright-json`, `eslint-json`, `unity-log`. Rules: non-zero exit + no report = BLOCK with log; exit 0 + no report or unreadable report = `error`; a report never turns a non-zero exit into PASS; report path stays inside the project; size limits with truncation noted
- [x] T-021: `artifacts: [globs]` on command gates; copy into run evidence, additive `artifacts: string[]` on gate results and JSON output, returned by MCP tools; globs inside the project root, symlinks not followed, count/byte limits
- [x] T-022: `ecosystem` plugin kind and `qualitygate setup` merging proposals (id prefixed on collision, never overwrites config): move node, add python (`ruff`, `pytest --junitxml`), unity (compile + EditMode via `-runTests`, macOS Hub path, `UNITY` override, stale `Temp/UnityLockfile`), playwright, maestro (`--format junit`)
- [x] T-023: `plugins: [package]` in `.qualitygate.yml` loaded from the project's `node_modules`, validated against plugin schemas, duplicate ids rejected; `setup --plugin <package>` (repeatable); docs and `SECURITY.md` say plugins run unsandboxed
- [ ] T-024: Acceptance on real projects: Unity client (`setup && run`, failing test yields a finding with file and line), Python server (`ruff` + `pytest` gates), Playwright failure with screenshot and trace in the evidence
- [x] T-024a: Defects found by the first real-project acceptance run, fixed with tests: Unity gates racing each other (false BLOCK), JUnit findings without file/line, noisy finding messages (ANSI, flattened stacks), no test counts on PASS, empty log after a timeout. Still open for T-024: re-run on the real projects to confirm
- [ ] T-025: Open a PR `features/october31` → `main` (merge is the owner's call); tag the next release only after CI is green
- [ ] T-026: Re-verify and clear the stale session note that `pnpm smoke` and the stdio-close test fail with exit 2 (CI on `6c33b33` and `92e9943` passed); keep a ticket only if it reproduces
- [ ] T-027 (backlog, only after T-020/T-021): visual regression as a thin gate over Playwright screenshots, with explicit baseline updates and a missing baseline = BLOCK; not a custom comparer. Dashboard side done (reader, `GET /api/run/visual`, `GET /v1/visual`, Visual section; `pnpm smoke:dashboard` extended but not yet run in real Chrome); the plugin that writes `visual.json` and `qualitygate visual approve` are separate work
- [x] T-027: visual regression as an optional plugin (`packages/plugins/visual-regression`, docs/VISUAL_REGRESSION.md): `type: visual` gate over screenshots your command writes, explicit `qualitygate visual approve`, missing baseline = BLOCK. Decision changed from the backlog note: it ships its own small PNG comparer (zero dependencies) instead of wrapping one. Open: a run with real Playwright; dashboard view of `visual.json`

## Verification limits / follow-up
- [x] CI Markdown artifacts and managed PR/MR descriptions for GitHub, GitLab and Bitbucket Cloud
- [x] Manual-content migration, tagged replacement, stale-head/older-run guards and edit re-read
- [x] Local API/CLI contract tests and pipeline exit-code preservation checks
- [ ] Live provider pipeline execution and separately provisioned GitLab/Bitbucket trusted publishers
- [x] SonarQube gate adapter with exact CE analysis identity and error/cancellation tests
- [x] Pinned review sources, explicit updates/frozen restore and MCP methodology reads
- [x] Review producer contract with provenance and unresolved-candidate blocking
- [ ] Live SonarQube Community Build + supported scanner end-to-end verification
- [ ] Cloudflare full audit producer, upstream schema/ledger verification and isolated execution runner
- [ ] Bind agent reviews and PASS to the exact source-tree and policy digests
- [ ] Live tool-calling inference with an installed Ollama model and a running vLLM server
- [ ] Interactive Cursor/Codex client validation beyond generated configuration tests
- [ ] Dedicated Vitest/coverage result plugin (generic project test commands already work)
- [ ] Native Linux account and Windows execution/cleanup support matrix

## Team visibility and process integration
Existing: `packages/ci` already updates PR/MR descriptions (GitHub, GitLab, Bitbucket) and the GitHub template writes the job summary. These tasks add what is missing. Each needs a short design note first; secrets come from env vars only, URLs HTTPS only, nothing changes exit codes.
- [x] T-028: Share a run, safest first: `qualitygate export --out <dir>` writes the last run as a self-contained static HTML report (no server, no scripts from the network) that can be uploaded to Pages, S3 or a CI artifact
- [x] T-029: Live share through a tunnel (shipped as `pnpm dashboard --tunnel`, the dashboard is not in the CLI tarball): `--tunnel cloudflare|ngrok` starts the user's installed `cloudflared tunnel --url` or `ngrok http`, prints the public URL. Read-only mode only (no run-triggering endpoints), random access token in the URL, warning that logs and evidence become visible, tunnel closed on exit
- [x] T-030: GitHub commit status / check run (`PASS`/`BLOCK`/`error`) with a link to the report, via `packages/ci`; needs `statuses: write`, same trusted-job rules as the description publisher (no fork PRs)
- [x] T-031: Sticky PR comment as an alternative to editing the description (marker-based update, one comment per PR)
- [x] T-032: Slack incoming-webhook notification on BLOCK or error (webhook URL from an env var, HTTPS only, message = gate summary + report link)
- [x] T-033: Trends from recorded runs (blocks per week, most frequent failing gates, flaky gates): `qualitygate trends` and a trends section in the exported static HTML report

## Plans and design notes still to write
- [x] T-036: Short design note for T-028..T-032 (export format, tunnel read-only mode and token, status/comment permissions, Slack payload), then one plan; start with T-028 and T-030

## Connect real projects
- [ ] T-037: Owner picks the math app to connect (`su_math_app`, `MathStream/math-web-app` or `MathStream/ReactNativeMathApp`); run `npx qualitygate-toolbox setup` there and keep the gates it proposes
- [ ] T-038: Connect the Unity project `games-christmas-swype` and the Python server (part of T-024, after Phase 2)

## Before an npm publish
- [ ] T-039: New version, changelog and matching tag (`v0.1.0` is stale and unpushed); publish only on the owner's explicit go
- [x] T-040: Threat model for the CLI, dashboard, tunnel share and plugin loading (`docs/threat-model/`)
- [ ] T-041: Enable GitHub private vulnerability reporting on the repository
- [x] T-042: Resolve or accept in `SECURITY.md` the zod 4 and minimatch advisories (7-day release-age policy applies, no overrides)

## Optional
- [x] T-043: Bump pnpm to 11.28.9 (touches 12 files; re-run `pnpm verify:release`)
- [x] T-044: Delete `legacy/lighthouse-v1` (done; history keeps it)

## Roadmap beyond v0.1 (remaining items from `docs/QUALITYGATE_DETAILED_ROADMAP.md`)
Suggested order: adoption and distribution first, then gate depth, then trust/scale, then extra clients.
Publishing, renaming and merging to `main` are the owner's decisions and are not done unasked.

### Adoption and portfolio
- [ ] T-051: Adoption case study: install on 1–2 real work/personal projects (iOS, Unity, Python, web), record the pain, gates chosen, findings and before/after numbers, write a one-page case for each (customer-facing story, not a feature list)
- [x] T-052: Test-review report `docs/TEST_REVIEW.md` (measured suite time, coverage gaps, isolation and duplication findings). The external quality-gate manifest is deliberately not committed: this repository keeps no tooling files of that kind. The four full-tier gates (smoke, smoke:dashboard, verify:hooks, verify:package) still need one run where Chrome and the network are available

### Distribution (QG-405, QG-704, QG-706–708)
- [ ] T-053: Publish `qualitygate-toolbox` to npm with provenance and a release workflow; verify `npx` / `pnpm dlx` clean install on macOS and Linux (owner approves the first publish)
- [ ] T-054: Rename the GitHub repository from `lighthouse-nodejs-cicd` to match the product (GitHub redirects the old URL); update README links, remote, badges and package metadata
- [ ] T-055: Public example repository and README badges (CI, license, npm version)
- [ ] T-056: Plugin authoring tutorial, generator (`create-qualitygate-plugin`) and compatibility matrix (QG-705, QG-1007)

### CLI (QG-401, QG-402)
- [x] T-057: Add `qualitygate list` (gates and last result) and `qualitygate doctor` (Node, Chrome, tools on PATH, config validity, writable output directory, history database); `inspect` already exists. Both read-only with `--json` and `--config`; `doctor` exits 2 when a check fails
- [x] T-058: Live progress view for interactive terminals (gate statuses, last log line per running gate, summary); non-TTY, CI and `--json` output unchanged. `run` uses plain ANSI codes; the interactive `qualitygate ui` (Ink 7.1.1 on React 19.2.0, own workspace package, bundled into `dist/qualitygate-ui.mjs`) runs and fixes gates with the same runner. Gates may declare `fix`; `qualitygate fix` re-runs them and prints before/after

### Gate depth (QG-1003–1006)
- [x] T-059: axe-core report parser (findings normalised to the shared `Finding` schema, no accessibility preset or built-in browser audit) and SARIF export for GitHub code scanning
- [x] T-060: Dependency and secret scanners as parser-backed gates (`npm audit`/`osv-scanner`, `gitleaks`) once T-020 lands
- [x] T-061: SQLite run history (`node:sqlite`), `qualitygate history` with comparison against the previous run and regression detection; feeds T-033

### Trust and scale (QG-1008–1010)
- [x] T-050: Review fixes: sticky comment trusts only bot-authored marker comments and tolerates unreadable metadata; `--write` requires `--head-repository` for `pr`, `status`, `comment` (template verifier covers all three); plugin names validated and real path kept inside `node_modules` before import
- [ ] T-062: Stronger plugin isolation, signed manifests and permission prompts; required before recommending third-party plugins to others (see T-023)
- [ ] T-063 (backlog): Optional remote execution runner, reusing the GitHub/GitLab integrations
- [ ] T-064: Stable v1.0 SDK: freeze plugin contracts, semver policy, migration guide

### Extra clients (QG-801–906) — only if there is demand after adoption
- [ ] T-065 (backlog): Tauri desktop wrapper around the existing dashboard (workspace picker, recent projects, notifications, signing plan). Done: the authenticated local bridge (docs/BRIDGE.md) and `packages/desktop` (tested TypeScript host: workspace store, bridge launcher, permission prompt, opt-in notifications, safe folder opening, launcher page; minimal Rust shell, config, placeholder icon, signing plan docs/DESKTOP_SIGNING.md, manual macOS/Windows smoke workflow). Done since: the shell compiles and `QualityGate.app` builds and starts on macOS. Not done: Windows build, nothing clicked through in the Tauri webview, no bundled Node/self-contained CLI, no signed or notarized package, no update flow, no notification click action
- [ ] T-066 (in progress): Manifest V3 Chrome extension that scans the current tab through an authenticated local bridge with explicit consent. Done: popup with pairing, consent per scan, scan, cancel, resume, results, revoked-token and bridge-down handling, permissions review, tests, real-Chrome smoke (`pnpm smoke:extension`, docs/CHROME_EXTENSION.md). Not done: DevTools panel, screenshot/diff thumbnails and a dashboard run deep link (QG-905 remainder), the real toolbar click granting `activeTab` (unverified), Web Store package and submission (docs/CHROME_STORE_CHECKLIST.md)

## Deferred review minors (from the whole-branch review)
- [x] T-067: Validate the Unity version from `ProjectVersion.txt` (`^[0-9A-Za-z.]+$`) before it is put into the generated gate command; stop the tunnel when Ctrl+C arrives before it is ready and reject `api.trycloudflare.com` as a share URL; add the gate `run` strings and config path to the shared-dashboard warning
- [x] T-068: Normalize and validate report URLs (`new URL(v).href`, reject `)`, `>`, `|`, whitespace) in the PR comment and Slack message; clear or freshness-check stale reports and artifacts between runs; do not silently drop artifacts when storage has no `copy`

## Feedback from the first real-project trial (ordered by priority)

### 1. Trust in the verdict (do first)
- [x] T-069: Add a distinct `TIMEOUT` gate status instead of reporting a timeout as `error`. A timed-out gate must not look like a tool crash; report partial counts ("passed N, failed 0, stopped by timeout") when the parser can read a partial report
- [x] T-070: Give the timeout its own exit code and add it to the exit-code contract (0, 1, 2, 130, plus the new one); document it in the README and CI docs
- [x] T-071: Explicit step registry in `report.json` and the HTML/exported report: list every configured gate as passed, failed, timed out, skipped or not run. A verdict built from 3 of 30 gates must say so and must not read as "project is green"
- [x] T-072: Single source of gates: `qualitygate setup --from scripts/gates.mjs` (or read `package.json` and `gates.json`) so projects that already declare gates do not maintain a second list by hand

### 2. Setup that understands monorepos
- [x] T-073: Detect more than `scripts.test`: `test:*` scripts, `vitest*.config`, `playwright*.config`, `maestro/` (without a leading dot) and `pnpm -r` workspaces
- [x] T-074: Show "found but not enabled" gates with a checkbox and the reason (slow, needs a browser, needs an emulator) so the owner decides instead of the tool silently skipping them
- [x] T-075: Warn about large runs (for example a 647-file glob will not fit in 300 s); propose a fast subset or mark the gate as `slow`
- [x] T-076: Write `report:` automatically for recognised tools (eslint-json, junit, playwright-json) so findings arrive with file and line instead of a raw log; start with the `node` ecosystem plugin (eslint and junit)

### 3. Speed and noise
- [x] T-077: Run independent gates in parallel (lint and typecheck took about 50 s sequentially) with `dependsOn` for gates that need another gate first
- [x] T-078: One output line per gate with the path to its log; move npm and pnpm warnings into the log
- [x] T-079: Add `--only <gate>` and `--changed` for fast local runs, and a cache keyed by the hash of a gate's input files

### 4. Safe operation
- [x] T-080: `setup` must not touch files other than the ones explicitly allowed; print "these files changed" so `.qualitygate.yml` and `.gitignore` do not leak into someone else's auto-commits
- [x] T-081: Replace the shared `/tmp/qualitygate-packages/` tarball location in the install docs with a versioned folder and a checksum check

### 5. Testing the tool itself
- [x] T-082: Self-test suite on 3–4 reference repositories (pnpm monorepo, Playwright, Maestro, Python) asserting that `setup` finds the expected gates
- [x] T-083: Exit-code contract tests, one per code (0, 1, 2, 130 and the timeout code)
- [ ] T-085: History follow-ups. Done: schema versioning/migrations for `history.sqlite` (`PRAGMA user_version`, a newer database is refused), filters (`--gate`, `--since`, `--decision`), comparison against a chosen baseline run (`history --baseline <runId>`). Open: retention/pruning (trend charts and a history table in the dashboard team view are already done)

### Suggested start
T-069 + T-070 + T-076: the `TIMEOUT` status with partial counts, plus automatic `report:` for eslint and junit. These are small changes in the `node` plugin and the runner, and they remove what made the trial result hard to trust.

## Review follow-ups (scanners, history and live view)
- [x] T-086: Live view: erase rows with the real terminal height and width (resize and more gates than rows), assert exit 130 in the pty and SIGINT tests, route the history warning after the live rows are erased
- [x] T-087: npm audit parser: a package whose `via` entries are all strings must still produce a finding when the referenced package is missing from the report
- [x] T-088: SARIF: resolve file paths against the project root instead of the working directory, escape `#` and `?`, and report `skip:` gates as notes
- [ ] T-089: History: flag a gate as flaky only when its inputs hash proves nothing changed; stop swapping the global `process.emitWarning` while loading `node:sqlite`
- [ ] T-086: Live view: erase rows with the real terminal height and width (resize and more gates than rows), assert exit 130 in the pty and SIGINT tests, route the history warning after the live rows are erased
- [ ] T-087: npm audit parser: a package whose `via` entries are all strings must still produce a finding when the referenced package is missing from the report
- [ ] T-088: SARIF: resolve file paths against the project root instead of the working directory, escape `#` and `?`, and report `skip:` gates as notes
- [x] T-089: History: flag a gate as flaky only when its inputs hash proves nothing changed; stop swapping the global `process.emitWarning` while loading `node:sqlite`
