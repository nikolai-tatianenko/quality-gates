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
- [ ] T-020: `parser` plugin kind and `report: { format, path }` on command gates; built-in `junit`, `nunit`, `playwright-json`, `eslint-json`, `unity-log`. Rules: non-zero exit + no report = BLOCK with log; exit 0 + no report or unreadable report = `error`; a report never turns a non-zero exit into PASS; report path stays inside the project; size limits with truncation noted
- [ ] T-021: `artifacts: [globs]` on command gates; copy into run evidence, additive `artifacts: string[]` on gate results and JSON output, returned by MCP tools; globs inside the project root, symlinks not followed, count/byte limits
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
