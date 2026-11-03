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
Design: `docs/superpowers/specs/2026-11-01-pluggable-ecosystems-design.md` (approved 2026-11-01).
Order: parsers → ecosystems → external loading; each part ships on its own. Keep exit codes
0/1/2/130, SDK `apiVersion: 1` (additive), 100% line / 95% branch coverage.
- [x] T-020: `parser` plugin kind and `report: { format, path }` on command gates; built-in `junit`, `nunit`, `playwright-json`, `eslint-json`, `unity-log`. Rules: non-zero exit + no report = BLOCK with log; exit 0 + no report or unreadable report = `error`; a report never turns a non-zero exit into PASS; report path stays inside the project; size limits with truncation noted
- [x] T-021: `artifacts: [globs]` on command gates; copy into run evidence, additive `artifacts: string[]` on gate results and JSON output, returned by MCP tools; globs inside the project root, symlinks not followed, count/byte limits
- [ ] T-022: `ecosystem` plugin kind and `qualitygate setup` merging proposals (id prefixed on collision, never overwrites config): move node, add python (`ruff`, `pytest --junitxml`), unity (compile + EditMode via `-runTests`, macOS Hub path, `UNITY` override, stale `Temp/UnityLockfile`), playwright, maestro (`--format junit`)
- [ ] T-023: `plugins: [package]` in `.qualitygate.yml` loaded from the project's `node_modules`, validated against plugin schemas, duplicate ids rejected; `setup --plugin <package>` (repeatable); docs and `SECURITY.md` say plugins run unsandboxed
- [ ] T-024: Acceptance on real projects: Unity client (`setup && run`, failing test yields a finding with file and line), Python server (`ruff` + `pytest` gates), Playwright failure with screenshot and trace in the evidence
- [ ] T-025: Open a PR `features/october31` → `main` (merge is the owner's call); tag the next release only after CI is green
- [ ] T-026: Re-verify and clear the stale session note that `pnpm smoke` and the stdio-close test fail with exit 2 (CI on `6c33b33` and `92e9943` passed); keep a ticket only if it reproduces
- [ ] T-027 (backlog, only after T-020/T-021): visual regression as a thin gate over Playwright screenshots, with explicit baseline updates and a missing baseline = BLOCK; not a custom comparer

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
- [ ] T-028: Share a run, safest first: `qualitygate export --out <dir>` writes the last run as a self-contained static HTML report (no server, no scripts from the network) that can be uploaded to Pages, S3 or a CI artifact
- [ ] T-029: Live share through a tunnel: `qualitygate dashboard --tunnel cloudflare|ngrok` starts the user's installed `cloudflared tunnel --url` or `ngrok http`, prints the public URL. Read-only mode only (no run-triggering endpoints), random access token in the URL, warning that logs and evidence become visible, tunnel closed on exit
- [ ] T-030: GitHub commit status / check run (`PASS`/`BLOCK`/`error`) with a link to the report, via `packages/ci`; needs `statuses: write`, same trusted-job rules as the description publisher (no fork PRs)
- [ ] T-031: Sticky PR comment as an alternative to editing the description (marker-based update, one comment per PR)
- [ ] T-032: Slack incoming-webhook notification on BLOCK or error (webhook URL from an env var, HTTPS only, message = gate summary + report link)
- [ ] T-033 (backlog): run history and trend page (blocks per week, most frequent failing gates, flaky gates) once exports from several runs exist

## Plans and design notes still to write
- [ ] T-034: Implementation plan for Phase 2 (T-022, ecosystem plugins and `setup`) with `superpowers:writing-plans`, after T-020/T-021 land
- [ ] T-035: Implementation plan for Phase 3 (T-023, external plugin loading), after T-022
- [ ] T-036: Short design note for T-028..T-032 (export format, tunnel read-only mode and token, status/comment permissions, Slack payload), then one plan; start with T-028 and T-030

## Connect real projects
- [ ] T-037: Owner picks the math app to connect (`math-app`, `example/math-web-app` or `example/react-native-math-app`); run `npx qualitygate-toolbox setup` there and keep the gates it proposes
- [ ] T-038: Connect the Unity project `unity-game` and the Python server (part of T-024, after Phase 2)

## Before an npm publish
- [ ] T-039: New version, changelog and matching tag (`v0.1.0` is stale and unpushed); publish only on the owner's explicit go
- [ ] T-040: Threat model for the CLI, dashboard, tunnel share and plugin loading (`docs/threat-model/`)
- [ ] T-041: Enable GitHub private vulnerability reporting on the repository
- [ ] T-042: Resolve or accept in `SECURITY.md` the zod 4 and minimatch advisories (7-day release-age policy applies, no overrides)

## Optional
- [ ] T-043: Bump pnpm to 11.11 or later (touches 12 files; re-run `pnpm verify:release`)
- [ ] T-044: Delete `legacy/lighthouse-v1` (nothing worth keeping was found; owner confirms)

## Roadmap beyond v0.1 (remaining items from `docs/QUALITYGATE_DETAILED_ROADMAP.md`)
Suggested order: adoption and distribution first, then gate depth, then trust/scale, then extra clients.
Publishing, renaming and merging to `main` are the owner's decisions and are not done unasked.

### Adoption and portfolio
- [ ] T-034: Adoption case study: install on 1–2 real work/personal projects (iOS, Unity, Python, web), record the pain, gates chosen, findings and before/after numbers, write a one-page case for each (customer-facing story, not a feature list)
- [ ] T-035: Make the quality-gate manifest for this repo so `gates.mjs check --completion` can run, and commit a test-review report (measured suite time, coverage gaps, isolation/duplication findings)

### Distribution (QG-405, QG-704, QG-706–708)
- [ ] T-036: Publish `qualitygate-toolbox` to npm with provenance and a release workflow; verify `npx` / `pnpm dlx` clean install on macOS and Linux (owner approves the first publish)
- [ ] T-037: Rename the GitHub repository from `qualitygate` to match the product (GitHub redirects the old URL); update README links, remote, badges and package metadata
- [ ] T-038: Public example repository and README badges (CI, license, npm version)
- [ ] T-039: Plugin authoring tutorial, generator (`create-qualitygate-plugin`) and compatibility matrix (QG-705, QG-1007)

### CLI (QG-401, QG-402)
- [ ] T-040: Add `qualitygate list` (gates and last result) and `qualitygate doctor` (Node, Chrome, tools on PATH, config validity); `inspect` already exists
- [ ] T-041 (backlog): React Ink progress view with streaming logs and a final summary; non-TTY and `--json` output must stay unchanged

### Gate depth (QG-1003–1006)
- [ ] T-042: Accessibility gate (axe-core) with findings normalised to the shared `Finding` schema, and SARIF export for GitHub code scanning
- [ ] T-043: Dependency and secret scanners as parser-backed gates (`npm audit`/`osv-scanner`, `gitleaks`) once T-020 lands
- [ ] T-044: SQLite run history, comparison against the previous run and regression detection; feeds T-033 trend page

### Trust and scale (QG-1008–1010)
- [ ] T-045: Stronger plugin isolation, signed manifests and permission prompts; required before recommending third-party plugins to others (see T-023)
- [ ] T-046 (backlog): Optional remote execution runner, reusing the GitHub/GitLab integrations
- [ ] T-047: Stable v1.0 SDK: freeze plugin contracts, semver policy, migration guide

### Extra clients (QG-801–906) — only if there is demand after adoption
- [ ] T-048 (backlog): Tauri desktop wrapper around the existing dashboard (workspace picker, recent projects, notifications, signing plan)
- [ ] T-049 (backlog): Manifest V3 Chrome extension that scans the current tab through an authenticated local bridge with explicit consent
