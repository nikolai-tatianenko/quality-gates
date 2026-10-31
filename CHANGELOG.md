# Changelog

## Unreleased — local workspace and analysis

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
