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

## Verification limits / follow-up
- [ ] Live tool-calling inference with an installed Ollama model and a running vLLM server
- [ ] Interactive Cursor/Codex client validation beyond generated configuration tests
- [ ] Dedicated Vitest/coverage result plugin (generic project test commands already work)
- [ ] Native Linux account and Windows execution/cleanup support matrix
