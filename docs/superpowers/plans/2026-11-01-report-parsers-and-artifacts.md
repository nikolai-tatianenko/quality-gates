# Report Parsers and Artifacts (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Command gates can read a test/tool report into findings (file, line, message) and attach files (screenshots, traces, logs) as run evidence.

**Architecture:** Gates in `.qualitygate.yml` gain optional `report: {format, path}` and `artifacts: [globs]`. A new `parser` plugin kind (built-ins in `packages/plugins/parsers`) turns report text into `Finding[]`. The command plugin runs the command, reads and parses the report, and returns findings plus absolute artifact paths; core copies those into the run's evidence folder through a new optional `storage.copy`.

**Tech Stack:** TypeScript (tsx), Zod 3, `node:test`, c8 (100% lines / 95% branches), one XML dependency (`fast-xml-parser`, exact version).

**Spec:** `docs/superpowers/specs/2026-11-01-pluggable-ecosystems-design.md` (Phase 1 only). Phases 2 (ecosystem plugins for `setup`) and 3 (external plugin loading) get their own plans after this ships.

## Global Constraints

- Run everything with Node 22.23.4 first on PATH: `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH` (the default Node 22.19.0 makes every `pnpm` command fail).
- pnpm 11.28.9 only. New dependencies: exact version, at least 7 days old (`minimumReleaseAge`), no overrides; `pnpm audit --prod` must not gain an advisory.
- `pnpm check` must pass: 100% line coverage, 95% branch coverage, lint, typecheck.
- Plugin API stays `apiVersion: 1`; changes are additive. Existing configs and old run reports must still parse.
- Exit codes unchanged: 0 PASS, 1 BLOCK, 2 error, 130 interrupted.
- Exit code decides PASS/BLOCK. Non-zero exit and no report = BLOCK (log is the evidence). Exit 0 and no report = execution `error`. Unreadable/unparsable report = `error`. Exit 0 but report holds error-severity findings = `error` (same as the ESLint gate).
- `report.path` and artifact globs resolve inside the config file's directory; symlinks are never followed.
- Limits: report file max 5 MB; at most 50 artifact files and 50 MB total, with a note appended to gate output when truncated.
- Built-in formats: `junit`, `nunit`, `playwright-json`, `eslint-json`, `unity-log`.
- Commit format: Commitizen (`type(scope): subject`), commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work on branch `features/october31`.

## Review Focus

1. `report.path` is `../x`, absolute, or a symlink → gate `error`, file is never read (Task 4).
2. Report larger than 5 MB → gate `error`, no memory blow-up (Task 4).
3. Empty test suite / zero-test XML with exit 0 → PASS with no findings; malformed XML → `error`, never a crash (Tasks 3, 4).
4. Artifact glob matches nothing (a passing Playwright run produces no traces) → not an error (Task 5).
5. Binary artifacts (PNG, zip) are copied byte-for-byte, and files outside the project or behind symlinks are skipped (Task 5).

## File Structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/index.ts` (modify) | `report`/`artifacts` on gate config; `artifacts` on gate data and result |
| `packages/plugin-sdk/src/index.ts` (modify) | `ParserPlugin`, optional `StoragePlugin.copy` |
| `packages/plugins/parsers/` (create) | One file per format + `builtinParsers` registry |
| `packages/plugins/command/src/report.ts` (create) | Safe report reading (containment, size limit) |
| `packages/plugins/command/src/artifacts.ts` (create) | Glob expansion with limits, no symlinks |
| `packages/plugins/command/src/index.ts` (modify) | Exit-code/report state machine in `commandPlugin` |
| `packages/plugins/storage-fs/src/index.ts` (modify) | `copy` implementation |
| `packages/core/src/execution.ts` (modify) | Copy artifacts into evidence, fill `GateResult.artifacts` |
| `packages/cli/src/runner.ts`, `output.ts` (modify) | Wire parsers; print artifact paths |
| `tests/report-*.test.ts`, `tests/parsers.test.ts`, `tests/artifacts.test.ts` (create) | Tests per task |

---

### Task 1: Schema and SDK contracts

**Files:**
- Modify: `packages/protocol/src/index.ts` (gateSchema ~line 14, gateDataSchema ~line 66, gateResultSchema ~line 70)
- Modify: `packages/plugin-sdk/src/index.ts`
- Test: `tests/report-schema.test.ts`

**Interfaces:**
- Produces (protocol): `GateSpec.report?: { format: string; path: string }`, `GateSpec.artifacts?: string[]`; `gateDataSchema` gains `artifacts: string[]` (default `[]`, absolute source paths); `gateResultSchema` gains `artifacts: string[]` (default `[]`, stored copy paths, absolute like `evidencePath`).
- Produces (SDK): `interface ParserPlugin extends Manifest { kind: 'parser'; parse(raw: string, context: { gateId: string; cwd: string }): Finding[] }`, added to the `Plugin` union; `StoragePlugin.copy?(directory: string, filename: string, sourcePath: string): Promise<string>`.

- [ ] **Step 1: Write failing tests** in `tests/report-schema.test.ts`: (a) `configSchema.parse` accepts a command gate with `report: {format:'junit', path:'r.xml'}` and `artifacts: ['out/**/*.png']`; (b) rejects `report` on a `type: eslint` gate with message containing `only for command gates`; (c) rejects `format: 'Bad Format'` and more than 50 artifact globs; (d) `gateResultSchema.parse` of an old result without `artifacts` yields `artifacts: []`.
- [ ] **Step 2: Run** `node --experimental-test-module-mocks --import tsx --test tests/report-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema fields (`format` regex `^[a-z0-9-]+$`, `artifacts` max 50, add rule in the existing `superRefine`) and the SDK types. Fix any exhaustive `kind` switches `pnpm typecheck` reports for the widened `Plugin` union.
- [ ] **Step 4: Run** the test → PASS; run `pnpm typecheck` → clean.
- [ ] **Step 5: Commit** `feat(protocol): add report and artifacts to command gates`.

### Task 2: JSON and log parsers

**Files:**
- Create: `packages/plugins/parsers/package.json` (copy shape of `packages/plugins/eslint/package.json`, name `@qualitygate/parsers`), `src/index.ts`, `src/playwright-json.ts`, `src/unity-log.ts`, `src/eslint-json.ts`
- Test: `tests/parsers.test.ts`

**Interfaces:**
- Consumes: `ParserPlugin`, `Finding`, `parseEslintReport(raw, gateId, cwd)` from `packages/plugins/eslint/src/index.ts`.
- Produces: `builtinParsers: Record<string, ParserPlugin>` keyed by format id; exported later-task additions `junit`, `nunit` register here too (Task 3).

- [ ] **Step 1: Write failing tests** in `tests/parsers.test.ts` with inline fixtures:
  - `unity-log`: text containing `Assets/Scripts/Foo.cs(12,5): error CS0103: The name 'x' does not exist` yields one `error` finding `{file:'Assets/Scripts/Foo.cs', line:12, column:5, ruleId:'CS0103', message:"The name 'x' does not exist"}`; duplicate lines are reported once; `warning CS…` yields severity `warning`; log without matches yields `[]`.
  - `playwright-json`: report with one spec whose test result `status:'failed'` (file `tests/a.spec.ts`, line 7, error message) yields an `error` finding with that file/line and the test title in `message`; `timedOut` also fails; `passed`/`skipped` yield nothing; invalid JSON throws.
  - `eslint-json`: delegates to `parseEslintReport` (one finding for a sample report).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** each parser (Zod-validate Playwright JSON loosely with `passthrough`; walk `suites[].specs[].tests[].results[]`, recursing into nested `suites`) and `builtinParsers` in `src/index.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(parsers): add playwright-json, unity-log and eslint-json parsers`.

### Task 3: XML parsers (JUnit, NUnit)

**Files:**
- Modify: `package.json` (add dependency), `pnpm-lock.yaml`
- Create: `packages/plugins/parsers/src/xml.ts`, `src/junit.ts`, `src/nunit.ts`; modify `src/index.ts`
- Test: `tests/parsers.test.ts` (extend)

**Interfaces:**
- Consumes: `builtinParsers` from Task 2.
- Produces: `parseXml(raw: string): unknown` in `xml.ts` (throws `Error` with message starting `Invalid XML` on bad input); entries `junit` and `nunit` in `builtinParsers`.

- [ ] **Step 1: Add the dependency:** `pnpm add --save-exact fast-xml-parser` (choose the newest version that satisfies the 7-day policy); run `pnpm audit --prod` and confirm the advisory count is not higher than before (14). If the package fails either rule, write a minimal in-repo XML tokenizer in `xml.ts` instead and say so in the commit body.
- [ ] **Step 2: Write failing tests:**
  - `junit`: `<testsuite>` with one `<testcase classname="A" name="b"><failure message="boom">stack…</failure></testcase>` yields one `error` finding, message `A.b: boom`; `<error>` counts as failure; `<skipped/>` yields nothing; both `<testsuites>` root and bare `<testsuite>` root work; a single testcase (parsed as an object, not an array) works; empty suite yields `[]`.
  - `nunit` (NUnit 3 `<test-run>`): `<test-case fullname="N.T.m" result="Failed"><failure><message><![CDATA[expected 1]]></message><stack-trace><![CDATA[at N.T.m () in /proj/Assets/Tests/T.cs:line 42]]></stack-trace></failure></test-case>` yields an `error` finding with `file` relative to `cwd` when the path is under it (else as given), `line: 42`, message `N.T.m: expected 1`; `result="Passed"`/`Skipped`/`Inconclusive` yield nothing; no stack trace → finding without file/line.
  - both: malformed XML throws error beginning `Invalid XML`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** `parseXml` (arrays forced for `testcase`/`test-case`/`failure` via the library's `isArray` option) and both parsers; register them.
- [ ] **Step 5: Run** → PASS. **Step 6: Commit** `feat(parsers): add junit and nunit parsers`.

### Task 4: Safe report reading and command-gate state machine

**Files:**
- Create: `packages/plugins/command/src/report.ts`
- Modify: `packages/plugins/command/src/index.ts` (`commandPlugin`)
- Test: `tests/report-command.test.ts`

**Interfaces:**
- Consumes: `ParserPlugin` (Task 1), `captureCommand`, `builtinParsers` (Tasks 2–3).
- Produces: `readReport(cwd: string, path: string): Promise<{ status: 'ok'; raw: string; absolutePath: string } | { status: 'missing' } | { status: 'error'; error: string }>` (5 MB limit; rejects absolute paths, `..` escapes and symlinks; ENOENT → `missing`); `commandPlugin(cwd: string, parsers?: Record<string, ParserPlugin>): GatePlugin` (second argument defaults to `{}`); gate data from it now carries `findings` and `artifacts` (the report file's absolute path is included in `artifacts` when read).

- [ ] **Step 1: Write failing tests** (real temp dirs, real `node -e` commands as gates, a stub parser or `builtinParsers`):
  - exit 0 + valid JUnit report with no failures → `exitCode 0`, `findings []`, no error, report path in `artifacts`.
  - exit 1 + report with one failure → `exitCode 1`, one finding, no `error` (BLOCK comes from exit code).
  - exit 1 + report missing → no `error`, output mentions the missing report.
  - exit 0 + report missing → `error` contains `Report not found`.
  - exit 0 + report with a failing testcase → `error` contains `exited 0 but report contains failures`.
  - Review Focus 1: `path: '../outside.xml'`, an absolute path and a symlink → `error`, parser never called (use a throwing stub).
  - Review Focus 2: 5 MB + 1 byte report → `error` mentioning the limit.
  - Review Focus 3: empty `<testsuite/>` with exit 0 → no findings, no error; malformed XML → `error` starting `Invalid junit report`.
  - unknown `format: 'nope'` → `error` `Unknown report format: nope`.
  - a gate without `report` behaves exactly as before (`{exitCode, output, error}` only).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `readReport` (use `lstat` on the resolved path and each check from the spec; `readFile` after size check via `stat`) and the state machine in `commandPlugin.run` following Global Constraints. Never let a thrown parser error escape: convert to `data.error`.
- [ ] **Step 4: Run** → PASS; run `tests/gates.test.ts` to confirm no regression.
- [ ] **Step 5: Commit** `feat(command): parse gate reports into findings`.

### Task 5: Artifacts — glob, storage copy, evidence

**Files:**
- Create: `packages/plugins/command/src/artifacts.ts`
- Modify: `packages/plugins/command/src/index.ts`, `packages/plugins/storage-fs/src/index.ts`, `packages/core/src/execution.ts`, `packages/core/src/index.ts` only if the `Environment` type needs it
- Test: `tests/artifacts.test.ts`

**Interfaces:**
- Consumes: `commandPlugin` (Task 4), `GateSpec.artifacts`, `GateData.artifacts`.
- Produces: `expandArtifacts(cwd: string, patterns: string[], limits?: { maxFiles: number; maxBytes: number }): Promise<{ files: string[]; truncated: boolean }>` (absolute paths, `*` = one path segment, `**` = any depth, no new dependency, `lstat` and skip symlinks, skip anything resolving outside `cwd`, defaults 50 files / 50 MB); `filesystemPlugin(...).copy(directory, filename, sourcePath): Promise<string>` (same basename check and temp-then-rename as `write`, `copyFile`, byte-exact); `GateResult.artifacts: string[]` filled with the stored copy paths named `gate-<n>-<id>-artifact-<k>-<basename>`.

- [ ] **Step 1: Write failing tests:**
  - `expandArtifacts`: `out/**/*.png` finds nested files; `*.log` does not descend; no match → `{files: [], truncated: false}` (Review Focus 4); 51 matching files with defaults → 50 files and `truncated: true`; byte cap respected; a symlinked file and a directory symlink are skipped; a pattern containing `..` matches nothing.
  - `copy`: a 256-byte buffer with all byte values is identical after copy (Review Focus 5); filename containing `/` throws `Invalid evidence filename`.
  - End to end through `run()` from core with `commandPlugin` + `filesystemPlugin`: a gate writing `out/a.png` and declaring `artifacts: ['out/*.png']` yields `gates[0].artifacts` with one path that exists inside the run directory; when truncated, `outputTail` ends with a `[artifacts truncated` note.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `expandArtifacts` (iterative directory walk; convert glob to RegExp), `copy`, the `commandPlugin` call, and in `executeGate` copy each `data.artifacts[k]` via `env.storage.copy` when `env.directory` and `env.storage.copy` exist (append to `item.artifacts`).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(core): store gate artifacts as run evidence`.

### Task 6: Wiring, CLI output, docs, end-to-end

**Files:**
- Modify: `packages/cli/src/runner.ts` (pass `builtinParsers` to `commandPlugin`; also check `packages/mcp` and `packages/service` for other `commandPlugin(` call sites with `grep -rn "commandPlugin(" packages`), `packages/cli/src/output.ts`, `scripts/build.mjs` only if the bundle needs the new package, `README.md`, `docs/PROJECT_SETUP.md`, `CHANGELOG.md`, the spec (one line: `artifacts` holds stored-copy paths like `evidencePath`, not project-relative paths)
- Test: `tests/report-cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `qualitygate run` honoring `report`/`artifacts` from YAML; text output lines `  Artifact: <path>` under a gate.

- [ ] **Step 1: Write failing test** that builds a temp project, writes `.qualitygate.yml` with a gate `node -e` that writes a JUnit file with one failure and a PNG, using `report: {format: junit, path: …}` and `artifacts`, runs the real CLI (`cli()` helper pattern from `tests/cli-extended.test.ts`) and asserts: exit code 1, `--json` output contains the finding with message and `gates[0].artifacts` length 2 (report + png), text output shows the `Artifact:` lines and the finding.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the wiring and output change; update docs: README gate example for Playwright/Maestro/pytest/Unity formats, `PROJECT_SETUP.md` section on `report`/`artifacts`, `CHANGELOG.md` entry, and the spec line above.
- [ ] **Step 4: Run** `pnpm check` → PASS (watch the coverage table for new files at 100%). Then `pnpm verify:release` → `"status": "PASS"` in `.qualitygate/release-check.json`.
- [ ] **Step 5: Record and commit** `node "$JELLYBOT_ROOT/scripts/reflect.mjs" record --feature "Report parsers and artifacts" …`; commit `feat(cli): wire report parsers and artifacts into qualitygate run`; push the branch.

---

## Self-review notes

- Spec coverage (Phase 1): `parser` kind (T1–3), `report`/`artifacts` fields (T1), failure semantics (T4), formats junit/nunit/playwright-json/eslint-json/unity-log (T2–3), limits and containment (T4–5), additive `artifacts` result field (T1, T5), docs (T6). Phases 2 and 3 are deliberately out of this plan.
- One deliberate clarification of the spec: result `artifacts` holds paths of the stored copies (absolute, like `evidencePath`), because the spec's "project-relative" wording cannot describe copies; Task 6 updates the spec.
- Left to the implementer: glob-to-regex details, exact XML option names, test fixture contents beyond the assertions above.

## Roadmap after Phase 1 (to be done later by the owner)

This plan covers Phase 1 only (T-020, T-021). The next phases each need their own plan
written with `superpowers:writing-plans` against the approved design before any code:

- **Phase 2 — ecosystem plugins for `setup`** (T-022): `ecosystem` plugin kind and
  `qualitygate setup` merging proposals; built-ins node, python, unity, playwright, maestro.
- **Phase 3 — external plugin loading** (T-023): `plugins: [package]` in `.qualitygate.yml`
  resolved from `node_modules`, `setup --plugin <package>`, unsandboxed-plugin docs.
- **Then:** T-024 acceptance on the real Unity, Python and Playwright projects.

Design: `docs/superpowers/specs/2026-11-01-pluggable-ecosystems-design.md`.
