# Changelog

## Unreleased — local workspace and analysis

- Removed the archived `legacy/lighthouse-v1/` service (history keeps it).

- Dependencies: zod 4.6.7 (fixes the zod advisory; `z.record` now takes explicit key and value
  schemas) and pnpm 11.28.9 for checkouts. Remaining advisories are documented in `SECURITY.md`.

- Security fixes: `status|comment|pr --write` now require `--head-repository` (fork PRs are refused
  even when a workflow forgets the flag; `pr` gained the flag); the sticky comment trusts only
  bot-authored marker comments (`comment --author <login>` for user tokens) and unreadable comment
  metadata counts as "not older" instead of failing the step; external plugin names are validated as
  npm package names and a package resolving outside `node_modules` is refused before any import.

- CI notifications (`packages/ci`): `qualitygate status` (GitHub commit status `success`/`failure`/
  `error` with a report link, needs `statuses: write`), `qualitygate comment` (one sticky,
  marker-based PR comment, alternative to the description block) and `qualitygate notify` (Slack
  incoming webhook on BLOCK or error, HTTPS only, URL from an env var). All are dry runs without
  `--write`; status and comment refuse fork PRs when `--head-repository` differs. Status and
  Slack omit tool output; comments include the detailed report. Publishers do not change the
  gate verdict or its exit code. The GitHub example publishes them from the trusted job.

- Sharing: `qualitygate export --out <dir>` writes a self-contained static HTML report
  (`index.html`, no scripts, no network resources) plus `report.json` for the last run or `--input`.
  `pnpm dashboard --tunnel cloudflare|ngrok` starts your installed `cloudflared`/`ngrok`, prints a
  tokenized public URL and serves a read-only dashboard (no run or cancel endpoints, random access
  token, tunnel closed on exit; missing binary exits 2). Logs and evidence become visible to anyone
  with the link. Design: `docs/design/2026-11-02-sharing-and-integrations-design.md`.

- External plugins: `plugins: [package]` in `.qualitygate.yml` loads `parser`, `ecosystem` and
  `gate` plugins from the project's `node_modules` (manifest `apiVersion: 1`, validated, duplicate
  ids rejected, load failures exit 2), a gate `type` may name a third-party gate, and
  `qualitygate setup --plugin <package>` (repeatable) writes the list. `setup --json` gains an
  additive `plugins` array. Plugins run unsandboxed with your permissions (README, `SECURITY.md`).

- New `ecosystem` plugin kind (SDK `apiVersion` stays 1) and a multi-ecosystem `qualitygate setup`:
  built-in `node` (the previous script detection), `python` (`ruff`, `pytest --junitxml`, optional
  `mypy`), `unity` (`unity-compile` + EditMode `unity-tests`, `UNITY` override, stale
  `Temp/UnityLockfile` removal), `playwright` and `maestro`. Proposals are merged
  non-interactively, ids that collide are prefixed with the ecosystem, and an existing config is
  never overwritten. `setup --json` gains an additive `ecosystems` list.

- Command gates accept `report: { format, path }` (built-in parsers `junit`, `nunit`,
  `playwright-json`, `eslint-json`, `unity-log`) and `artifacts: [globs]`. Reports become
  findings with file and line; artifacts are copied into the run evidence and listed in an
  additive `artifacts` array on gate results (JSON output and MCP tools). The exit code still
  decides PASS/BLOCK; report paths and globs stay inside the project, symlinks are skipped,
  and size/count limits apply. Adds `fast-xml-parser` 5.11.2; SDK `apiVersion` stays 1
  (new `parser` plugin kind and optional `StoragePlugin.copy` are additive).

- Rename the package to `qualitygate-toolbox` (the `qualitygate` command is unchanged);
  tarballs are now `qualitygate-toolbox-0.1.0.tgz`.

- Update Lighthouse to 13.5.0 and the MCP SDK to 1.32.2, clearing the `puppeteer-core`,
  `basic-ftp`, `extract-zip` and Sentry/OpenTelemetry advisories (24 to 14 in `pnpm audit --prod`).

- `qualitygate setup`: generate `.qualitygate.yml` gates from package.json scripts and
  update `.gitignore` in one command (also usable via `npx -p <tarball>`).

- Update `yaml` to 2.8.4 (advisory fix), add a bug-report issue template and document
  remaining transitive dependency advisories and the LGPL analyzer dependency.

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
