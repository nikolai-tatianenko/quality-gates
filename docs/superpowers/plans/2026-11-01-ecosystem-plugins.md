# Ecosystem Plugins and Multi-Ecosystem `setup` (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `qualitygate setup` discovers every ecosystem in a project (Node, Python, Unity, Playwright, Maestro) through `ecosystem` plugins, merges their proposed gates non-interactively and writes `.qualitygate.yml` without ever overwriting an existing one.

**Architecture:** A new `ecosystem` plugin kind `{ kind: 'ecosystem', detect(dir) → DetectedGate[] | null }` joins the plugin SDK (additive, `apiVersion: 1`). A `DetectedGate` is the subset of a command gate a plugin may propose (`id`, `run`, `timeoutMs?`, `report?`, `artifacts?`), validated by a zod schema in `packages/protocol`. Built-ins live in one package, `packages/plugins/ecosystems` (one file per ecosystem plus `builtinEcosystems`, mirroring `packages/plugins/parsers`). `setupProject` in `packages/cli/src/setup.ts` runs the plugins, merges proposals (all gates sharing an id are prefixed with their ecosystem id), and writes the config exactly as today.

**Tech Stack:** TypeScript (tsx), Zod 3, `node:test`, c8 (100% lines / 95% branches). No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-01-pluggable-ecosystems-design.md` (Phase 2 only). Phase 3 (external plugin loading, `setup --plugin`) gets its own plan after this ships (T-035). Phase 1 plan: `docs/superpowers/plans/2026-11-01-report-parsers-and-artifacts.md`.

## Global Constraints

- Run everything with Node 22.23.4 first on PATH: `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH` (the default Node 22.19.0 makes every `pnpm` command fail).
- pnpm 11.28.9 only. No new third-party dependency; the 7-day `minimumReleaseAge` stays without overrides.
- `pnpm check` must pass: 100% line coverage, 95% branch coverage, lint, typecheck. Then `pnpm verify:release` (`verify:package` can flake once after sleep: re-run it alone).
- Plugin API stays `apiVersion: 1`; changes are additive. Exit codes unchanged: 0 PASS, 1 BLOCK, 2 error, 130 interrupted.
- Existing `setup` behaviour and `tests/setup.test.ts` keep passing unchanged: same Node gates and ids, same `timeoutMs`, `EEXIST` when the config exists, `ENOENT` for a missing directory, error message still starting `No lint, typecheck or test script`.
- `setup` is non-interactive and never overwrites a config (`writeFile` with `wx`). Detection only reads files; it never runs project code and never deletes anything.
- Proposed `report.path` values live under `.qualitygate/<ecosystem>/` (already git-ignored, inside the project as Phase 1 requires).
- Unity: macOS Hub path only; the `UNITY` environment variable overrides the editor path at run time (the gate command expands `${UNITY:-<hub path>}` in the shell). A stale `Temp/UnityLockfile` is removed by the gate command only when no `Unity` editor process is running; otherwise the gate fails with a clear message.
- Everything written (code, docs, comments, commit messages) is in English. Commit format: Commitizen (`type(scope): subject`), trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work on branch `features/october31`.

## Review Focus

1. A project with several ecosystems (Node + Playwright) gets unique ids: both colliding gates are prefixed (`node-tests`, `playwright-tests`), non-colliding ids stay unchanged (Task 3).
2. An existing `.qualitygate.yml` is never overwritten, even when more ecosystems are found (Task 3).
3. `setup` on a plain Node project produces byte-identical config and result to today (Task 3, existing tests).
4. The Unity gate commands behave correctly against a fake editor: honour `UNITY`, remove a stale lockfile, refuse when an editor is running, write the log and NUnit file where `report.path` points (Task 5).
5. Detection reads only file names and small manifests; a malformed `package.json` is an error, a missing one means "not Node" (Tasks 3, 4).

## File Structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/index.ts` (modify) | `detectedGateSchema`, `DetectedGate` type |
| `packages/plugin-sdk/src/index.ts` (modify) | `EcosystemPlugin`, widened `Plugin` union |
| `packages/plugins/ecosystems/` (create) | `package.json`, `src/index.ts` (`builtinEcosystems`), `shared.ts`, `node.ts`, `python.ts`, `unity.ts`, `playwright.ts`, `maestro.ts` |
| `packages/cli/src/setup.ts` (modify) | Run ecosystems, merge proposals, write config and `.gitignore` |
| `packages/cli/src/index.ts` (modify) | Print detected ecosystems |
| `tests/ecosystem-schema.test.ts`, `tests/ecosystems.test.ts`, `tests/setup-ecosystems.test.ts`, `tests/ecosystem-unity.test.ts` (create) | Tests per task |
| `README.md`, `docs/PROJECT_SETUP.md`, `CHANGELOG.md`, `SECURITY.md` (modify) | Behaviour and trust notes |

---

### Task 1: Schema and SDK contracts

**Files:**
- Modify: `packages/protocol/src/index.ts`, `packages/plugin-sdk/src/index.ts`
- Test: `tests/ecosystem-schema.test.ts`

**Interfaces:**
- Produces (protocol): `detectedGateSchema` = strict object `{ id, run, timeoutMs?, report?: { format, path }, artifacts?: string[] }` using the same field rules as `gateSchema` (id regex, `report` shape, at most 50 artifacts); `type DetectedGate = z.infer<typeof detectedGateSchema>`. `gateSchema` is refactored to share the field definitions without changing behaviour.
- Produces (SDK): `interface EcosystemPlugin extends Manifest { kind: 'ecosystem'; detect(directory: string): Promise<DetectedGate[] | null> }`, added to the `Plugin` union. `null` or `[]` means "this ecosystem is not present".

- [ ] **Step 1: Write failing tests**: (a) `detectedGateSchema.parse` accepts `{id:'tests', run:'x', timeoutMs:5, report:{format:'junit', path:'r.xml'}, artifacts:['a']}`; (b) rejects unknown keys (`type`), a bad id (`'Bad Id!'`), more than 50 artifacts; (c) `configSchema` still accepts and rejects what it did before (one existing case each).
- [ ] **Step 2: Run** `node --experimental-test-module-mocks --import tsx --test tests/ecosystem-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema and SDK type; fix any exhaustive `kind` switch that `pnpm typecheck` reports.
- [ ] **Step 4: Run** the test → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(protocol): add the ecosystem plugin kind`.

### Task 2: Node ecosystem and shared helpers

**Files:**
- Create: `packages/plugins/ecosystems/package.json` (copy shape of `packages/plugins/parsers/package.json`, name `@qualitygate/ecosystems`), `src/shared.ts`, `src/node.ts`, `src/index.ts`
- Test: `tests/ecosystems.test.ts`

**Interfaces:**
- Produces (`shared.ts`): `exists(path): Promise<boolean>`; `readJson(path): Promise<unknown | undefined>` (undefined on ENOENT, throws on invalid JSON); `packageManager(directory, declared?): Promise<'pnpm' | 'yarn' | 'npm'>` (moved from `setup.ts`, same rules); `execPrefix(manager): string` (`pnpm exec`, `yarn`, `npx`).
- Produces: `node: EcosystemPlugin` (id `node`) proposing `lint`, `typecheck`, `tests` exactly as today's `setup.ts` (`<manager> run <script>`, tests `timeoutMs: 300000`); `null` when there is no `package.json` or no matching script. `builtinEcosystems: EcosystemPlugin[]` in order node, python, unity, playwright, maestro (later tasks append).

- [ ] **Step 1: Write failing tests** with temp dirs: script→gate mapping for each manager source (`packageManager` field, each lockfile, npm fallback), `test:ci` preferred over `test`, no `package.json` → `null`, `{}` → `null`, invalid JSON → rejects.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ecosystems): move node script detection into an ecosystem plugin`.

### Task 3: `setupProject` merges ecosystem proposals

**Files:**
- Modify: `packages/cli/src/setup.ts`, `packages/cli/src/index.ts`
- Test: `tests/setup-ecosystems.test.ts` (and the existing `tests/setup.test.ts` must pass untouched)

**Interfaces:**
- Consumes: `EcosystemPlugin`, `detectedGateSchema`, `builtinEcosystems`.
- Produces: `setupProject(configPath: string, ecosystems: EcosystemPlugin[] = builtinEcosystems): Promise<{ configPath; gates: {id; run}[]; gitignore: string[]; ecosystems: string[] }>` (`ecosystems` is additive: ids of plugins that proposed gates). `mergeProposals(proposals: { ecosystem: string; gates: DetectedGate[] }[]): DetectedGate[]`: gates whose id occurs more than once are renamed `<ecosystem>-<id>`; if a renamed id still collides, throw `Duplicate gate id: <id>`. CLI text output gains a line `Ecosystems: node, playwright`; `--json` gains `ecosystems`.

- [ ] **Step 1: Write failing tests** using stub ecosystem plugins: two plugins proposing `tests` → `a-tests`, `b-tests`, while a unique `lint` keeps its id (Review Focus 1); renamed id still colliding → `Duplicate gate id`; nothing detected → error starting `No lint, typecheck or test script`; missing directory → `ENOENT`; existing config → `EEXIST` and file content unchanged (Review Focus 2); a plugin returning an invalid gate (bad id) is rejected by the schema; `ecosystems` lists only plugins that proposed gates; written YAML round-trips through `configSchema`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`stat` the directory first so a missing one fails with `ENOENT`; run `detect` sequentially in plugin order; parse each result with `detectedGateSchema.array()`; keep the `.gitignore` handling untouched).
- [ ] **Step 4: Run** the new test and `tests/setup.test.ts`, `tests/cli*.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(cli): merge ecosystem proposals in setup`.

### Task 4: Python, Playwright and Maestro ecosystems

**Files:**
- Create: `packages/plugins/ecosystems/src/python.ts`, `playwright.ts`, `maestro.ts`; modify `src/index.ts`
- Test: `tests/ecosystems.test.ts` (extend)

**Interfaces:**
- Produces:
  - `python` (id `python`): detects `pyproject.toml` or any `requirements*.txt`. Proposes `lint` = `ruff check .`; `tests` = `pytest --junitxml=.qualitygate/python/pytest.xml` with `report {junit, .qualitygate/python/pytest.xml}` and `timeoutMs: 300000`; `typecheck` = `mypy .` only when `mypy` appears in `pyproject.toml`, `mypy.ini`, `setup.cfg` or a requirements file.
  - `playwright` (id `playwright`): detects `playwright.config.{ts,js,mjs,cjs,mts,cts}`. Proposes `tests` = `PLAYWRIGHT_JSON_OUTPUT_NAME=.qualitygate/playwright/report.json <execPrefix> playwright test --reporter=list,json`, `report {playwright-json, .qualitygate/playwright/report.json}`, `artifacts ['test-results/**/*.png', 'test-results/**/*.webm', 'test-results/**/*.zip']`, `timeoutMs: 600000`.
  - `maestro` (id `maestro`): flows directory is `.maestro` if present, else `flows`; it counts only when it holds a `.yaml`/`.yml` file whose text contains `appId:`. Proposes `e2e-mobile` = `mkdir -p .qualitygate/maestro && maestro test --format junit --output .qualitygate/maestro/report.xml <dir>`, `report {junit, …}`, `timeoutMs: 900000`.

- [ ] **Step 1: Write failing tests**: python detection by each trigger file, mypy only when mentioned, no trigger → `null`; playwright for each config extension and manager prefix, `null` without config; maestro with `.maestro`, with `flows`, `.maestro` preferred, directory without `appId:` → `null`, missing dirs → `null`. Assert each proposal passes `detectedGateSchema`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** and register in `builtinEcosystems`. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ecosystems): add python, playwright and maestro`.

### Task 5: Unity ecosystem

**Files:**
- Create: `packages/plugins/ecosystems/src/unity.ts`; modify `src/index.ts`
- Test: `tests/ecosystem-unity.test.ts`

**Interfaces:**
- Produces: `unity` (id `unity`): detects `ProjectSettings/ProjectVersion.txt`, reads `m_EditorVersion: <version>` (error `Unreadable Unity version in ProjectVersion.txt` when absent). Editor path expression `${UNITY:-/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity}`. Two gates sharing a `prepare` shell prefix that: when `Temp/UnityLockfile` exists, fails with `Unity project is open in an editor; close it first` (exit 1) if `pgrep -x Unity` finds a process, else removes the lockfile; then `mkdir -p .qualitygate/unity`.
  - `unity-compile`: `<prepare> && "<editor>" -batchmode -nographics -quit -projectPath . -logFile .qualitygate/unity/compile.log`, `report {unity-log, .qualitygate/unity/compile.log}`, `timeoutMs: 1800000`.
  - `unity-tests`: `<prepare> && "<editor>" -batchmode -nographics -projectPath . -runTests -testPlatform EditMode -testResults .qualitygate/unity/editmode.xml -logFile .qualitygate/unity/tests.log`, `report {nunit, .qualitygate/unity/editmode.xml}`, `timeoutMs: 1800000`.
  - Exported `unityPrepare` string so tests can run the prefix directly.

- [ ] **Step 1: Write failing tests**: detection and exact gate ids/reports/timeouts; version read from a realistic `ProjectVersion.txt` (two lines); missing version line → rejects; no `ProjectSettings` → `null`. Behavioural (Review Focus 4, real `sh`): `unityPrepare` removes a stale lockfile and creates `.qualitygate/unity`; with a fake `pgrep` first on PATH exiting 0 it fails with the message and keeps the lockfile. End to end through `commandPlugin` + `builtinParsers`: with `UNITY` pointing at a fake shell script that writes the `-logFile` (containing `Assets/A.cs(3,4): error CS0103: nope`) and exits 1, `unity-compile` yields one finding at line 3; a fake editor writing a NUnit file with one failed case makes `unity-tests` yield a finding.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** and register. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(ecosystems): add unity compile and EditMode gates`.

### Task 6: Docs, end-to-end, verification

**Files:**
- Modify: `README.md`, `docs/PROJECT_SETUP.md`, `CHANGELOG.md`, `SECURITY.md`, `TODO.md`
- Test: `tests/setup-ecosystems.test.ts` (extend with a real-CLI case)

- [ ] **Step 1: Write failing test**: a temp project with `package.json` (test script), `playwright.config.ts` and `pyproject.toml`; run `setupProject` and assert gate ids `lint`(node), `node-tests`, `playwright-tests`, `python-lint`... per the collision rule, every gate validates under `configSchema`, and `qualitygate setup --json` (CLI helper from `tests/cli-extended.test.ts`) reports `ecosystems`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** any fix; update docs: what each ecosystem proposes, the collision rule, `UNITY` override and lockfile behaviour, a `SECURITY.md` note that proposed commands (and later plugins) run unsandboxed with the user's permissions and that `setup` only writes a config for the user to review; CHANGELOG entry; tick T-034 and T-022 in `TODO.md`.
- [ ] **Step 4: Run** `pnpm check` → PASS (new files at 100% lines), then `pnpm verify:release` → `"status": "PASS"`.
- [ ] **Step 5: Record and commit** with `reflect.mjs record`; commit and push.

---

## Self-review notes

- Spec coverage (Phase 2): `ecosystem` kind (T1), merge rules and no-overwrite (T3), node moved (T2), python/playwright/maestro (T4), unity incl. Hub path, `UNITY` override, stale lockfile, two gates (T5), docs (T6). `setup --plugin` and `plugins:` in config are Phase 3 (T-023) and deliberately absent.
- Deliberate simplifications: no "replaces" declaration between ecosystems (the spec says Playwright replaces nothing); Unity on Windows/Linux relies on the `UNITY` variable as the owner decided; Maestro screenshots (kept in `~/.maestro`) are not collected as artifacts.
- Left to the implementer: fixture contents beyond the assertions above and exact wording of docs.
