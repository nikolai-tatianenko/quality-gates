# Changelog

## Unreleased — local workspace and analysis

- Pin the supported runtime to Node.js 22.23.4 across nvm, package engines and
  CI examples. Translate remaining project documentation to English while
  preserving multibyte-output regression coverage.
- Portless-backed `dev:ui` with a stable named `.localhost` URL, private loopback
  proxy/backend, dynamic backend port and explicit public-origin validation.
  Portless 0.12.0 preserves the Node 22 baseline and seven-day dependency policy.
- Project installation/CI/Husky guides and copyable hooks, verified with real
  Husky in a disposable Git fixture. README now includes real dashboard captures,
  Mermaid flow, product rationale and clear setup/verification boundaries.

- Shadcn-inspired neutral dashboard styling with semantic theme tokens, an inset
  workspace, SVG navigation, outline actions and section navigation. A fourth
  metric shows the latest recorded run duration; light/dark/system modes persist.

- Refreshed dashboard with light/dark/system themes, persisted browser preferences,
  a CSP-compatible early theme bootstrap, responsive cards/tables and distinct
  error/warning/info colors. Execution errors override PASS in the headline.
- Real Chrome theme persistence/system-change checks, selected text contrast
  checks and screenshots at desktop, 390px and 320px widths.

- CI Markdown reports and GitHub/GitLab/Bitbucket Cloud PR-description adapters;
  migrate handwritten content, replace only managed sections, skip stale heads
  and older runs, and re-read concurrent manual edits before explicit writes.
- CI templates preserve gate exit codes and failure artifacts; GitHub separates
  checks from a trusted publisher. GitLab/Bitbucket publication needs a separately
  configured trusted publisher pipeline.

- SonarQube scanner gates: fresh task metadata, exact analysis identity, bounded
  polling, token redaction, quality-gate condition findings and raw evidence.
- Versioned external review sources with explicit update/check/frozen restore,
  local bare Git cache and read-only `get_review_methodology` MCP tool.
- Review producer contracts retain provenance and confirmed/unresolved/rejected
  records. Unresolved candidates block; incomplete/malformed reports are errors.
  Full Cloudflare orchestration and a target-execution sandbox are not included.

- Enforce pnpm 11.5.1 for checkout installs, with native developer-engine checks
  and a dependency-free guard. Packaged CLI consumers retain manager choice.
- Delay registry dependency versions by seven days, fail when no eligible version
  exists, and refresh/review the lockfile without age exceptions. MCP SDK is pinned
  to compatible 1.32.1; younger transitive versions are replaced by eligible ones.
- Document current code-quality configuration and per-project lint policies;
  standalone analyzer defaults remain fixed and a full formatter policy is pending.

- React dashboard with run/cancel, latest verdict, structured findings and report
  download over a loopback HTTP API using the shared execution service.
- Independent `@qualitygate/code-analysis` workspace package with API and CLI:
  ESLint/SonarJS for TS/JS complexity and code smells; Ruff for Python.
- ESLint-compatible reports normalized to file/line/rule/message findings and
  retained as raw evidence. Python analysis + unittest example included.
- Shared service lifecycle for MCP and dashboard: cancellation, disconnect drain,
  overlapping-run rejection and saved-run inspection.
- Native configuration emitters for Claude, Cursor, Codex, VS Code and compatible
  clients. Bounded Ollama/vLLM/chat-compatible tool-calling adapters; live inference
  remains experimental and model prose cannot override a validated gate verdict.
- Runtime TS/TSX coverage reporting with 100% line/statement/function floors and a
  95% branch floor. Clean installation and standalone tarball checks.
- Chrome startup stderr diagnostics and process-exit-before-profile-cleanup fix;
  local Linux root-container sandbox reproduction and explicit opt-in verification.
- CI configuration now covers Ruff, coverage, analyzer/CLI package installation and
  a real Chrome dashboard workflow. Remote execution awaits the next GitHub push.

## 0.1.0 baseline

- CLI command gates and sequential Lighthouse audits, explicit policy, JSON
  evidence, exit codes and cleanup.
- MCP tools and a recorded real Claude Code BLOCK → fix → PASS demonstration.
- MIT license; original ISC implementation archived under `legacy/lighthouse-v1/`.
