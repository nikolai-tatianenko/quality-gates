# QualityGate product vision

QualityGate gives developers, CI and AI agents a shared answer to two questions:
does this change satisfy the project's quality policy, and what evidence supports
that decision? Projects own their policy. Existing tools perform the analysis.
QualityGate coordinates execution, evaluates results and preserves the evidence.

## The problem

Teams often distribute quality requirements across package scripts, CI jobs,
editor settings and agent prompts. Those entry points can disagree about thresholds,
required checks and failure semantics. An agent may see a failed command without
the source location or raw report needed to act on it.

QualityGate makes that contract explicit and available through CLI, MCP and a local
dashboard. A policy violation, missing metric and tool execution failure remain
distinct outcomes. None can silently become a successful CI result.

## Execution model

1. Commit a versioned configuration containing targets, checks and requirements.
2. Invoke the shared service from the CLI, CI, a Git hook, MCP or the dashboard.
3. Plugins execute tools and normalize their output into a versioned result schema.
4. The policy engine evaluates the recorded measurements against explicit rules.
5. Persist the run ID, execution status, decision, reasons and evidence paths.

Identical recorded metrics and thresholds must produce the same policy decision.
That guarantee does not make repeated browser measurements identical: Lighthouse
results can vary with the page, machine and execution environment.

## Design principles

- **Project-owned policy.** Required missing metrics block the result. Plugins
  supply measurements and execution outcomes; policy determines acceptance.
- **Separate execution and acceptance.** A completed audit can yield BLOCK. A
  report-write failure remains an execution error even when measured scores pass.
- **A small shared core.** Contracts, orchestration and lifecycle are independent
  of individual tools, report presentation and storage implementations.
- **Evidence accompanies the verdict.** Keep raw tool output and normalized
  results associated with the same run, with atomic summary writes.
- **Explicit resource ownership.** Timeouts, interruption and cleanup failures
  are observable. The runner must terminate the processes it starts.
- **Versioned boundaries.** TypeScript and Zod define configuration and result
  contracts. Compatibility checks reject unsupported plugin contracts early.
- **Local operation.** The core workflow requires no hosted account. Remote
  integrations are explicit dependencies with documented trust boundaries.

## Implemented developer preview

The initial Lighthouse CLI supports sequential HTTP(S) audits, explicit category
thresholds, raw JSON evidence and machine-readable output. Configuration creation
does not overwrite existing files. Exit codes distinguish PASS (`0`), BLOCK (`1`),
execution/configuration/storage errors (`2`) and interruption (`130`).

The current Node.js/TypeScript monorepo extends that foundation with:

- Command gates for existing project scripts and an ESLint JSON adapter with
  structured file, line, rule, severity and evidence fields.
- A reusable TS/JS and Python analysis package using ESLint/SonarJS and Ruff.
  QualityGate applies the same analyzer to its own sources.
- A stdio MCP server exposing configured checks, execution, saved runs and pinned
  review methodologies. The recorded Claude Code session demonstrates
  BLOCK → inspect → implementation fix → PASS without weakening tests or policy.
- A local React dashboard for execution, cancellation, findings and evidence,
  including light/dark/system themes and loopback-only Portless routing.
- A SonarQube adapter tied to a specific scanner analysis and a normalized
  contract for externally produced review findings.
- GitHub, GitLab and Bitbucket CI templates, report rendering and explicit
  PR/MR description publication that preserves handwritten content.

External review methodologies are downloaded explicitly, pinned by Git commit
and read as reference material. Updating a source lock and restoring its frozen
revision are separate operations. Unresolved review candidates block acceptance.
Loading a methodology does not constitute a completed security audit.

## Trust boundaries and limits

Configured commands and local plugins are trusted code, **not sandboxed**. They
inherit the invoking user's permissions. MCP exposes the selected configuration;
it does not accept arbitrary commands or replacement project paths. The local
dashboard has no authentication and must not be exposed as a public service.

A complete Cloudflare audit harness, independent verification of upstream audit
artifacts, isolated target execution and exact worktree binding remain future work.
Live provider/editor/model compatibility is limited to the evidence recorded in
[verification](docs/VERIFICATION.md), not inferred from adapter availability.

## Next product increments

1. Validate adoption in independent repositories and tighten installation,
   environment diagnostics and failure recovery around observed problems.
2. Extend structured adapters for tests and coverage while preserving the common
   result contract and explicit evaluation rules.
3. Bind review results to the exact source tree and verify producer evidence;
   introduce isolation before executing untrusted targets.
4. Build run comparison and history from persisted evidence, with actionable
   regressions rather than synthetic analytics.
5. Expand interfaces or remote execution only after validating demand, resource
   ownership and the corresponding security model.

New interfaces must use the existing runner and policy engine. Package publication
and hosted operation are separate release decisions. The original CommonJS service
(removed from the tree, still in git history) was ISC; the maintained implementation uses MIT.

## Acceptance criteria

A user can configure a project from the quickstart, run the same policy locally
and in CI, and explain each BLOCK through a metric, finding or explicit failure.
A new audit plugin can integrate without changing the core. One failed target
does not erase earlier results. A saved report identifies both the decision and
the raw evidence needed to inspect it.

See the [README](README.md) for usage, [prototype scope](docs/PROTOTYPE.md) for the
original boundary, [verification](docs/VERIFICATION.md) for observed behavior and
[roadmap](TODO.md) for outstanding work.
