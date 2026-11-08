# Changelog

## Unreleased — local workspace and analysis

- Desktop client prototype (QG-801 to QG-805, in part): `packages/desktop` with a Node host (workspace store with validation on every launch and recent projects, bridge launcher that reads the pairing code from its own child process or attaches with a typed code, one-time permission prompt, run watcher, opt-in notification text built from verdict and gate ids only, safe opening of report and evidence folders), a React launcher page, a minimal Rust/Tauri 2 shell that forwards seven allow-listed requests, packaging config, placeholder icon, a signing and notarization plan without secrets (docs/DESKTOP_SIGNING.md) and a manual-dispatch macOS/Windows smoke-build workflow. Verified: `tests/desktop-*.test.ts`, including a run against the real bridge, dashboard and CLI. Not verified: the Rust shell was never compiled (no `cargo` here), nothing ran in a Tauri webview, notification clicks, packaging, signing, updates. See docs/DESKTOP.md.

- Chrome extension (QG-901, QG-902, QG-904, QG-905 in part, QG-906): Manifest V3 popup in `packages/chrome-extension` that pairs with the local bridge with the one-time code, shows the active tab's address and its origin, requires explicit consent for every scan, runs the configured Lighthouse thresholds through `POST /v1/scans`, and shows the bridge's verdict and exit code, scores against minimums, findings, run id, evidence file names and a link to the dashboard. Permissions are `activeTab` and `storage` only, no host access, strict CSP; `tests/extension-package.test.ts` pins them. Handles bridge down, revoked token and a scan that continues after the popup closes. Verified with unit tests, a run against the real bridge and `pnpm smoke:extension` in real Chrome 156 on macOS; the real toolbar click that grants `activeTab`, Web Store submission, a DevTools panel and screenshot thumbnails are not done. The dashboard's design tokens moved to `packages/dashboard/src/tokens.css` (output unchanged). See docs/CHROME_EXTENSION.md.

- Team view in the dashboard and `GET /v1/team` on the bridge: summary for leads, trends, run history, engineer view, Markdown export.

- Local bridge (QG-802, QG-903): `qualitygate bridge` serves an authenticated API on 127.0.0.1 for the planned browser extension and desktop shell: one-time pairing code printed in the terminal, bearer tokens pinned to the pairing origin (expiry, revocation, `bridge --revoke-all`, SHA-256 hashes in a 0600 file), Host and exact Origin allow list (extension id, Tauri, loopback dashboard), exact-origin CORS, rate limit and 4 KiB body limit. Endpoints list the approved gates, run selected gates, report and cancel a job (one at a time), return runs, findings, listed artifacts, history and trends, and scan a URL with the configured Lighthouse thresholds (`QualityGateService.scan`, not recorded in the history). Verdicts and exit codes are the stored run's; gate logs, raw reports and absolute paths are never returned. See docs/BRIDGE.md. The extension and desktop clients themselves are not built.

- Live progress view: in an interactive terminal `qualitygate run` shows each gate's status, elapsed time and last output line, updating in place, then a one-line summary. Off when stdout is not a TTY, when `CI` is set, with `--json`, with `--no-live` or `QUALITYGATE_NO_LIVE=1`; piped output, `--json` and exit codes are unchanged. Plain ANSI codes instead of React Ink (Ink 8 requires React >= 19.3 and about twenty runtime packages). Plugins may call the new optional `context.log(line)` to show progress; gate output of secret-scanning parsers is never shown live.

- Run history and trends: every run is appended to `<outputDir>/history.sqlite` (Node's built-in `node:sqlite`). `qualitygate history` lists recent runs (id, time, decision, duration, gate counts) and compares the newest with the previous one (regressions, new failures, fixed gates, newly slow gates); `qualitygate trends` shows blocks per week, the most frequently failing gates and flaky gates (alternating PASS/BLOCK without a change of the inputs hash); both accept `--limit` and `--json` and exit `0`. `qualitygate export` adds a trends section to the static HTML report when history exists. A history write failure or a corrupt database only prints a warning and never changes a run's verdict or exit code.

- Dependency and secret scanners as report parsers: `npm-audit` (`npm audit --json`, v2 format), `osv-scanner` (`--format json`) and `gitleaks` (JSON report). Severity critical/high = error, moderate = warning, low = info; advisory ids become the rule id and help link. Wrong, truncated or error-output reports are errors, never "no findings". gitleaks findings carry rule, file and line only: `Match` and `Secret` are not stored, are removed from the gate output, and the report file is not copied into the run (new optional `secrets` hook on parser plugins). `qualitygate setup` lists a disabled `audit` gate (`npm audit`, or `osv-scanner` for pnpm and yarn) when a lockfile exists.
- axe-core report parser and SARIF export (not an accessibility preset: you supply the command that writes the axe JSON). The `axe-json` report format turns axe-core `violations` (not `incomplete`) into findings (severity from impact, rule id, selector from the page, help URL via the new optional `helpUrl`, which keeps only http(s) URLs); input without a `violations` array is an error, never "0 violations". `qualitygate report --sarif` exports a run as SARIF 2.1.0 for GitHub code scanning: gates that ended BLOCK, error or timeout without findings appear as results, `invocations[].executionSuccessful` follows the run, and file uris are relative (absolute or `../` paths get no location). With `--sarif --json` and no `--output` the SARIF is under the key `sarif`.
- Verdict trust: a gate that runs out of time now has its own status, `TIMEOUT` (`execution: timeout`), and its own exit code `3`,
  instead of looking like a tool crash (`2`). When the gate's report can be read, the message keeps the partial counts
  ("passed 40, failed 0, stopped by timeout"; JUnit, NUnit and Playwright reports). Every run now carries a step registry (`steps`:
  passed, failed, timeout, error, interrupted, skipped, cached, not-run) shown in the JSON report, Markdown/HTML reports, the CI
  verdict and the terminal, so "PASS" from 3 of 30 gates reads "3 of 30 steps ran". Additive to the JSON schema; `exitCode()`
  gains the value 3.
- Speed and noise: independent gates run in parallel (`concurrency`, default 4; `1` keeps the old sequential behaviour),
  `dependsOn` orders them and skips a gate whose dependency did not pass, `inputs` + `--changed` / `--cache` support fast local
  runs, `--only` is an alias of `--gate`, and the terminal prints one line per gate with its log path while npm/pnpm warnings stay in the log.
- `setup`: understands monorepos (pnpm/npm workspaces), every `test:*` script and `vitest*.config`; lists slow gates and
  gates that need a browser or an emulator as "found but not enabled" with the reason (Maestro is now listed, not enabled);
  warns about large test runs; writes `report:` for plain `eslint`, `vitest` and `node --test` scripts; reads an existing
  gate list with `--from`; prints the files it changed and accepts `--no-gitignore`.
- Local tarballs are built by `pnpm pack:local` into `.packages/<version>/` with a SHA-256 file instead of a shared `/tmp` folder.
- Tests: exit-code contract for 0, 1, 2, 3 and 130, and reference repositories (pnpm monorepo, Playwright, Maestro, Python) that
  `setup` must understand.

- Removed the archived `legacy/lighthouse-v1/` service (history keeps it).

- Hardening (review minors): the Unity editor version from `ProjectVersion.txt` must be letters, digits and dots (a crafted version can no longer inject shell syntax into the generated gate); `dashboard --tunnel` now stops the tunnel process when interrupted before the URL appears, never takes `api.trycloudflare.com` as the share URL, and its warning names the gate command lines and config path that become visible; report URLs for the PR comment, commit status and Slack are normalized and refused when they contain spaces or `( ) < > | [ ]`; a report or artifact file older than the run is treated as a leftover (missing report, skipped artifact) instead of being attached; artifacts that cannot be stored because the storage plugin has no `copy` are now reported as a gate error note.

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
