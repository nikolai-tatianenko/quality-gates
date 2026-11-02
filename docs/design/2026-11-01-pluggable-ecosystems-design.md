# Pluggable ecosystems and test reports — design

Status: approved by owner. Date: 2026-11-01. Branch: `features/october31`.

## Intent

QualityGate wraps a project's own commands and gives developers, CI and AI agents one
verdict. Today a command gate only reports "exit code 0 / not 0" plus a log. The owner
runs a Unity (C#) client and a Python server, uses Playwright and Maestro for end-to-end
tests, and wants other languages and tools to be addable without editing QualityGate
core: "everything is a plugin". The why: a failed gate should say which test failed, in
which file and line, with the screenshot or trace attached, and `qualitygate setup`
should configure a new project of any language in one command.

## Goals

1. Command gates can read a test or tool report and turn it into findings (file, line,
   rule, message), using the existing `Finding` schema.
2. Command gates can attach files (screenshots, videos, traces, logs) as run evidence.
3. `qualitygate setup` discovers the project's ecosystems through plugins and proposes gates.
4. Third-party plugins can be installed from npm and enabled in `.qualitygate.yml`.
5. Built-in support, all as plugins: Node, Python, Unity (EditMode tests + compile
   errors), Playwright, Maestro.

## Non-goals

- Running Unity on CI without a licence, or building iOS/Android players.
- Sandboxing plugins. They are trusted local code, as `SECURITY.md` already states.
- Replacing existing `eslint`, `sonarqube`, `review` gate types in this change.
- A plugin marketplace or registry.
- Changing exit-code semantics: 0 PASS, 1 BLOCK, 2 error, 130 interrupted.

## Anti-goals

- A parser that hides a failing exit code. A report with zero failures never turns a
  non-zero exit into PASS, and a missing or unreadable report is an execution error,
  not a pass (same rule the ESLint gate already follows).
- Plugin loading that silently runs code from an unreviewed path.

## Constraints

- Node >=22.23.4, pnpm 11.5.1, the 7-day `minimumReleaseAge` dependency policy (no
  overrides), 100% line and 95% branch test coverage (`pnpm check`).
- Plugin API stays versioned (`apiVersion`). Existing v1 plugins keep working.
- No new runtime dependency unless an eligible, audited one is clearly needed.
  XML parsing (JUnit, NUnit) should use a small dependency or a minimal in-repo parser.
- Gate commands remain unsandboxed; security docs must say so for plugins too.

## Design

### Phase 1 — report parsers and artifacts (ship first)

New plugin kind `parser`: `{ kind: 'parser', id, parse(raw, ctx) → Finding[] }`.
Command gates gain two optional fields in `gateSchema`:

```yaml
- id: e2e-web
  run: pnpm exec playwright test
  report: { format: playwright-json, path: test-results/report.json }
  artifacts: [test-results/**/*.png, test-results/**/*.webm, test-results/**/trace.zip]
```

Rules:
- The command runs first. Then the report at `path` (relative to the config file, must
  stay inside it) is read and parsed into findings; artifacts are copied under the run's
  evidence folder and their paths referenced from findings or the gate result.
- Exit code decides PASS/BLOCK. Findings add detail and may force BLOCK only when the
  exit code was 0 but the report contains failures (as the ESLint gate does).
- Missing report, unparsable report, or a path escaping the project → gate execution
  `error` with a clear message.
- Built-in formats: `junit` (Maestro, pytest `--junitxml`), `nunit` (Unity Test
  Framework `-testResults`), `playwright-json`, `eslint-json` (reusing today's parser).
- Size limits on reports and artifact count/bytes, with truncation noted in the result.

### Phase 2 — ecosystem plugins for `setup`

New plugin kind `ecosystem`: `{ kind: 'ecosystem', id, detect(dir) → DetectedGate[] | null }`.
`qualitygate setup` runs every enabled ecosystem plugin, merges the proposals, and
writes the config; it still refuses to overwrite an existing config. Built-ins:

| Plugin | Detects | Proposes |
|---|---|---|
| node | `package.json` scripts | lint, typecheck, tests (today's behaviour moves here) |
| python | `pyproject.toml` / `requirements*.txt` | `ruff check`, `pytest --junitxml`, optional `mypy` |
| unity | `ProjectSettings/ProjectVersion.txt` | compile check and EditMode tests via Unity batch mode with `-runTests -testPlatform EditMode -testResults`, report format `nunit`, `error CS` log scan |
| playwright | `playwright.config.*` | `playwright test` with `playwright-json` report and artifacts |
| maestro | `.maestro/` or `flows/` with Maestro YAML | `maestro test --format junit --output …` |

Unity specifics: resolve the editor from `ProjectVersion.txt` under the standard Unity
Hub path (override with a `UNITY` env var or config field), remove a stale
`Temp/UnityLockfile`, and report clearly if the project is open in an editor.

### Phase 3 — loading external plugins

`.qualitygate.yml` gets `plugins: [package-name, ...]`. Each is resolved from the
project's `node_modules`, must export a manifest with `apiVersion: 1`, and is validated
against the plugin schemas. Duplicate ids are rejected (as today). Loading is explicit
opt-in per project; documentation states plugins run with the user's permissions.

## Decisions I made (not yet confirmed by the owner)

- Order is parsers → ecosystems → external loading, each releasable on its own.
- Unity scope is EditMode tests plus compile errors only.
- New plugin kinds extend SDK v1 additively; no apiVersion bump.
- Phase 1 gate type stays `command`; report parsing is options on it, not a new type.

## Decisions added after the builder check (my calls unless marked)

- **Failed command, no report:** non-zero exit with no report is BLOCK with the log as
  evidence (the tool failed the check; this covers a Unity compile error that aborts before
  `-testResults`). Exit 0 with no report is an execution `error`. Unreadable report with
  any exit code is `error`.
- **Unity compile errors:** a fifth built-in format, `unity-log`, scans a log file for
  `error CS` lines and yields findings with file and line. A gate has one `report`; the
  unity plugin therefore proposes two gates (`unity-compile` with `unity-log`,
  `unity-tests` with `nunit`).
- **`setup` and plugins:** built-in ecosystem plugins are always on. Third-party ones are
  added for the run with `qualitygate setup --plugin <package>` (repeatable); the written
  config then lists them under `plugins:`.
- **Merging proposals:** non-interactive. Each proposed gate id is prefixed with its
  ecosystem on collision (`node-tests`, `playwright-tests`). A more specific ecosystem may
  declare it replaces another's gate (Playwright replaces nothing in Node; it adds one).
- **Artifacts in results:** an additive optional `artifacts: string[]` (absolute paths of
  the stored copies in the run's evidence folder, like `evidencePath`; default `[]`) on the gate result and in JSON output. Existing consumers ignore
  it, MCP tools return it. Artifact globs and `report.path` must resolve inside the
  project root; symlinks are not followed.
- **Public kinds:** `parser` and `ecosystem` join the SDK as public kinds. Built-ins are
  registered by core; third-party parsers become available to `report.format` once
  Phase 3 loads them.
- **File and line are best effort:** findings always carry a message and gate id; file,
  line and column are filled when the report or stack trace provides them (NUnit stack
  traces, `error CS`, Playwright locations). Maestro JUnit gives test name and message only.

## Owner decisions (2026-11-01, approved)

1. **Plugin loading trust:** listing a package in `plugins:` is the opt-in. No extra
   lockfile pin or first-run prompt in this change; documentation states plugins run
   unsandboxed with the user's permissions. (Revisit if third-party plugins appear.)
2. **Operating systems:** macOS only for Unity detection; the `UNITY` env var is the
   override for Windows and Linux.

## Left to the builder

XML parser choice, exact CLI flags for Maestro and Unity versions, file layout of new
packages (`packages/plugins/parser-*`, `packages/plugins/ecosystem-*`), test fixtures,
how artifacts are named inside the evidence folder, and README/docs wording.

## Success

On the owner's Unity project, `qualitygate setup && qualitygate run` produces gates for
compile and EditMode tests; a deliberately failing test yields a finding with file and
line. On a Python server project, the same command produces `ruff` and `pytest` gates.
A Playwright failure shows its screenshot and trace in the run evidence.
