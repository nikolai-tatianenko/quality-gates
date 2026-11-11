# Changelog

## Unreleased — local workspace and analysis

- T-086: the live view erases its rows using the real terminal size. With more gates than terminal rows it draws one row fewer than the height (running gates first, then `+N more`), rows that wrapped after the terminal was made narrower are counted when erasing, and a resize redraws. A history warning is printed after the rows are erased and the cursor is restored. The pty tests now assert exit codes 0 and 130.

- T-087: the `npm-audit` parser keeps a package whose `via` entries are all strings when a referenced package is missing from the report (one finding, `<name>: vulnerable via <missing>`), instead of dropping it.

- T-088: `qualitygate report --sarif` resolves absolute file paths against the project root (the directory of `--config`, default the working directory; `report` now accepts `--config`) instead of the working directory, escapes `#` and `?` in file uris, and reports skipped gates as notes instead of errors.
- History (T-085, T-089): `history.sqlite` now carries a schema version (`PRAGMA user_version`); a database from before versioning is upgraded in place by the next write without losing runs, and a database written by a newer QualityGate is refused with an error naming both versions (`history`/`trends` exit 2, `run` only warns). `history` and `trends` accept `--gate <id>` (repeatable), `--since <date>` and `--decision <PASS|BLOCK>`; `history --baseline <runId>` compares the newest run with a chosen run instead of the previous one. A gate is now reported as flaky only when its inputs hash is equal across the flip; a gate without `inputs` is never flaky (before, every flip counted). Loading `node:sqlite` no longer replaces `process.emitWarning`: only its experimental warning is filtered, other warnings still print. Pruning stays open.

- `qualitygate list` and `qualitygate doctor` (T-057): `list` shows every configured gate with its newest recorded result (from `history.sqlite`, never commands or output); `doctor` checks the Node version, the config, Chrome (only for URL audits), the programs the gates start on `PATH`, a writable output directory and a readable history database. Both are read-only, accept `--config` and `--json`, and never change a verdict; `doctor` exits `2` when a check fails (including a broken config) and prints no environment values. Verified by `tests/doctor.test.ts`; see README, "List gates and check the setup".
- Acceptance-run fixes: (1) Unity gates no longer race each other: the generated prefix waits (up to 120 s, `QUALITYGATE_UNITY_WAIT` overrides) until no Unity process for this project path (`-projectPath`, whole path, any case) is alive, then fails with a clear message; processes of other projects never block, a non-batch editor on this project is still refused at once, and the gates now pass `-projectPath "$(pwd -P)"`. (2) JUnit findings get `file` and `line` from the testcase `file`/`line` attributes, else the first in-project frame of the stack text (`file:///p/x.mjs:12:3`, `(path:line:col)`), else a path-like `classname`; nothing outside the project or inside `node_modules`/`node:` is used and nothing is invented. (3) Finding messages lose ANSI sequences and a stack trace (also one flattened onto a line) is cut to its first meaningful line; the full text stays in the gate log and the report artifact, and Markdown output also strips ANSI. (4) Gates that parsed a JUnit, NUnit or Playwright report show their counts in the text and Markdown output ("56 tests passed"); the decision is unchanged. There is no TAP parser, so TAP reports have no counts. (5) A timeout keeps the last 64 KB of output when the 1 MB capture limit was already full; secret-scanner gates still withhold all output. No verdict or exit code changes.
- Test review (T-052): `docs/TEST_REVIEW.md` records the measured suite time (411 tests, 58 s, 69 s with coverage), coverage per package, isolation and duplication findings. No test changed. Not verified there: smoke, smoke-dashboard, verify-hooks and verify-package did not pass in the sandbox used (no Chrome launch, no network).
- Visual regression, dashboard side (T-027, in part): the dashboard and the bridge can read the evidence of the optional visual-regression plugin. `<outputDir>/<runId>/visual/visual.json` (zod-validated; schema version 1, unknown fields ignored) lists screenshots with status `match`, `changed`, `new` or `missing`; `GET /api/run/visual` on the dashboard and `GET /v1/visual` on the bridge return the latest run's list (or `?run=<uuid>`), and with `?name=&image=approved|current|diff&run=` one listed PNG. Only listed images are served, by name, from that run's own `visual/` folder: no paths accepted, links refused (file and folders), PNG signature and a 10 MB cap. No file means `{enabled: false, items: []}`, a broken file an empty answer with a `warning`; neither is an error. The React dashboard shows a "Visual" section only when items exist: status chips and diff ratio, a viewer with Slider (role=slider, arrows, Shift, Page, Home, End), Side by side, Diff and Onion, zoom to fit, a "no approved baseline" notice for new screenshots, and the copyable `qualitygate visual approve <name>`; it never approves anything and never changes a verdict. It refetches after a run and when the window regains focus. Verified by unit tests (reader, both APIs, jsdom UI). The plugin that writes `visual.json` and the `visual approve` command are separate work; the section is covered by `scripts/dashboard-smoke.mjs`, which is written and must be run where Chrome is available (it has not been run for this section).
- Visual regression review fixes: the command gate no longer appends its output tail for secret scanners (a secret cut by the tail boundary leaked in part), and starts the tail of other gates at a line start; the dashboard reader refuses item names starting with a dash, absolute or `..` baseline folders, symlinked run and visual folders, and PNGs whose header size differs from the item or exceeds 40 megapixels, and the Visual section shows the reader's warning instead of hiding; the plugin escapes refused file names, accepts only lower-case `.png`, refuses overlapping current and baseline folders, and defaults `maxPixels` to 16 megapixels (schema cap 64). Linking the plugin is verified only under `tsx` from a checkout, not against `dist/qualitygate.mjs`.
- Optional visual-regression plugin (T-027): new workspace package `packages/plugins/visual-regression`, enabled only by `plugins:` in the config. Gate type `visual` (`run`, `current`, `baseline`, `threshold`, `maxDiffRatio`, `maxPixels`, `ignore`) runs your screenshot command and compares the PNG files with a version-controlled baseline using its own PNG decoder/encoder (`node:zlib`, no new dependency; 8-bit RGB/RGBA non-interlaced only, anything else is an error finding). A changed, new (no baseline) or missing screenshot blocks, a missing baseline is never a pass; evidence is `<runId>/visual/visual.json` plus copies of the approved, current and diff images. `qualitygate visual approve <name>|--all` copies the latest run's screenshots into the baseline and prints each file; it is never part of `run`, never changes a verdict, and refuses paths, symlinks and baselines that leave the project. Core changes are additive and optional: `context.projectDir` and `context.evidenceDir` for gate plugins, plugin-gate settings on gates, and optional `commands` in a plugin package. See docs/VISUAL_REGRESSION.md. Not verified: a run with real Playwright, installing the package from a registry (it is private).

- Fix and interactive UI (T-058 follow-up): a command gate may declare `fix: <command>` (same trust and working directory as `run`, never accepted from the MCP server or the bridge). `qualitygate fix [--gate <id>]... [--allow-dirty] [--json]` runs the fix commands of the gates that blocked last time (else all gates with a fix), runs exactly those gates again with the normal runner and prints before/after decisions and `git diff --stat`; the re-run is the verdict, exit codes are unchanged, and it refuses a dirty git working tree unless `--allow-dirty`. `qualitygate setup` proposes fixes for plain eslint scripts, `ruff check --fix .`, pint, php-cs-fixer and phpcbf. `qualitygate ui` is a new Ink 7.1.1 screen (new workspace package `packages/ink-ui`, bundled with React 19.2.0 into `dist/qualitygate-ui.mjs`, loaded only by `ui`) that runs the same runner: live gate table, details panel (never for secret-scanner output), fix with a y/n question, trends sparkline, Ctrl+C cancels and exits 130; it refuses a non-TTY, CI or `TERM=dumb` with one line and exit 2. `qualitygate run` keeps its plain ANSI live view. Verified by unit and Ink render tests with fake streams and by a run in a real pseudo-terminal on macOS; see README, "Interactive UI and fix".

- Desktop client prototype (QG-801 to QG-805, in part): `packages/desktop` with a Node host (workspace store with validation on every launch and recent projects, bridge launcher that reads the pairing code from its own child process or attaches with a typed code, one-time permission prompt, run watcher, opt-in notification text built from verdict and gate ids only, safe opening of report and evidence folders), a React launcher page, a minimal Rust/Tauri 2 shell that forwards seven allow-listed requests, packaging config, placeholder icon, a signing and notarization plan without secrets (docs/DESKTOP_SIGNING.md) and a manual-dispatch macOS/Windows smoke-build workflow. Verified: `tests/desktop-*.test.ts`, including a run against the real bridge, dashboard and CLI. The Rust shell compiles (clippy clean) and `QualityGate.app` builds unsigned and starts on macOS. Not verified: Windows, anything inside the Tauri webview, notification clicks, signing, updates. See docs/DESKTOP.md.

- Chrome extension (QG-901, QG-902, QG-904, QG-905 in part, QG-906): Manifest V3 popup in `packages/chrome-extension` that pairs with the local bridge with the one-time code, shows the active tab's address and its origin, requires explicit consent for every scan, runs the configured Lighthouse thresholds through `POST /v1/scans`, and shows the bridge's verdict and exit code, scores against minimums, findings, run id, evidence file names and a link to the dashboard. Permissions are `activeTab` and `storage` only, no host access, strict CSP; `tests/extension-package.test.ts` pins them. Handles bridge down, revoked token and a scan that continues after the popup closes. Verified with unit tests, a run against the real bridge and `pnpm smoke:extension` in real Chrome 156 on macOS; the real toolbar click that grants `activeTab`, Web Store submission, a DevTools panel and screenshot thumbnails are not done. The dashboard's design tokens moved to `packages/dashboard/src/tokens.css` (output unchanged). See docs/CHROME_EXTENSION.md.

- Team view in the dashboard and `GET /v1/team` on the bridge: summary for leads, trends, run history, engineer view, Markdown export.

- Local bridge (QG-802, QG-903): `qualitygate bridge` serves an authenticated API on 127.0.0.1 for the planned browser extension and desktop shell: one-time pairing code printed in the terminal, bearer tokens pinned to the pairing origin (expiry, revocation, `bridge --revoke-all`, SHA-256 hashes in a 0600 file), Host and exact Origin allow list (extension id, Tauri, loopback dashboard), exact-origin CORS, rate limit and 4 KiB body limit. Endpoints list the approved gates, run selected gates, report and cancel a job (one at a time), return runs, findings, listed artifacts, history and trends, and scan a URL with the configured Lighthouse thresholds (`QualityGateService.scan`, not recorded in the history). Verdicts and exit codes are the stored run's; gate logs, raw reports and absolute paths are never returned. See docs/BRIDGE.md. The extension and desktop clients themselves are not built.

- Live progress view: in an interactive terminal `qualitygate run` shows each gate's status, elapsed time and last output line, updating in place, then a one-line summary. Off when stdout is not a TTY, when `CI` is set, with `--json`, with `--no-live` or `QUALITYGATE_NO_LIVE=1`; piped output, `--json` and exit codes are unchanged. Plain ANSI codes for `run` (the separate `qualitygate ui` screen uses Ink 7). Plugins may call the new optional `context.log(line)` to show progress; gate output of secret-scanning parsers is never shown live.

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
