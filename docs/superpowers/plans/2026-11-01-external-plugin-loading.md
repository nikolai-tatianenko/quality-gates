# External Plugin Loading (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project can list npm packages under `plugins:` in `.qualitygate.yml`; QualityGate loads them from the project's `node_modules`, validates their manifest, and registers their parsers, ecosystems and gates. `qualitygate setup --plugin <package>` (repeatable) writes that list.

**Architecture:** `configSchema` gains `plugins: string[]` (valid npm package names, unique). A loader in `packages/core/src/external.ts` resolves `<project>/node_modules/<package>`, imports its entry module, validates the exported manifest `{ apiVersion: 1, plugins: [...] }` with zod schemas from `packages/protocol`, rejects duplicate ids (against built-ins and within the batch) and returns parsers, ecosystems and gates. `execute` (run/MCP/dashboard) merges parsers and gates into the built-ins; `setupProject` merges ecosystems. Gate `type` becomes an id string so a third-party gate plugin can be selected; unknown types fail before anything runs.

**Tech Stack:** TypeScript (tsx), Zod 3, `node:test`, c8 (100% lines / 95% branches). No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-01-pluggable-ecosystems-design.md` (Phase 3 and the owner decision "listing a package in `plugins:` is the opt-in").

## Global Constraints

- Run everything with Node 22.23.4 first on PATH: `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH`.
- pnpm 11.5.1 only; 7-day `minimumReleaseAge`, no overrides. No new runtime dependency.
- `pnpm check` must pass (100% line, 95% branch coverage), then `pnpm verify:release`.
- SDK stays `apiVersion: 1`; changes are additive. Existing configs keep working. Exit codes 0/1/2/130 unchanged; a plugin load failure is an execution error (exit 2).
- Plugins are trusted local code and run unsandboxed with the user's permissions. README, `docs/PROJECT_SETUP.md`, `SECURITY.md` and the CLI `setup` output say so.
- Third-party kinds allowed: `parser`, `ecosystem`, `gate`. `audit`, `storage` and `reporter` stay built-in.
- Commit format: Commitizen with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work on branch `features/october31`.

## Review Focus

1. Package name is `../x`, absolute or contains a separator beyond a scope → schema rejects it; nothing is imported (Task 1, 2).
2. Package missing from `node_modules`, entry escaping the package folder, throwing at import, or exporting no manifest → clear `error`, never a crash (Task 2).
3. Duplicate ids: two plugins in one package, two packages, or a clash with a built-in (`junit`, `node`, `command`) → rejected naming the id (Task 2).
4. `apiVersion` other than 1 or a plugin missing its required function → rejected with the field named (Task 2).
5. `setup --plugin` never overwrites an existing config and writes `plugins:` only when given (Task 4).
6. A gate with an unknown `type` fails with `Unknown gate type` before any gate runs (Task 3).

## File Structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/index.ts` (modify) | `plugins` in config, gate `type` as id, `externalPluginSchema`, `pluginPackageSchema` |
| `packages/plugin-sdk/src/index.ts` (modify) | `ExternalPlugin`, `PluginPackage` types |
| `packages/core/src/external.ts` (create) | Resolve, import, validate, dedupe; returns `LoadedPlugins` |
| `packages/cli/src/runner.ts` (modify) | Load plugins in `execute`, merge parsers and gates, unknown-type check |
| `packages/cli/src/setup.ts`, `index.ts` (modify) | `--plugin`, merge external ecosystems, write `plugins:` |
| `tests/fixtures/plugin-package/` (create) | Fixture npm package exporting one parser, one ecosystem, one gate |
| `tests/external-plugins.test.ts` (create) | Loader, runner and setup tests |

---

### Task 1: Schemas and SDK types

**Files:** modify `packages/protocol/src/index.ts`, `packages/plugin-sdk/src/index.ts`; test `tests/external-plugins.test.ts`.

**Interfaces:**
- Produces (protocol): `configSchema.plugins?: string[]` (npm package name regex, max 20, duplicates rejected); `gateSchema.type: string` (id regex, default `command`); `externalPluginSchema` (discriminated by `kind`: `parser` needs `parse`, `ecosystem` needs `detect`, `gate` needs `run`; all need `apiVersion: 1` and a lowercase id); `pluginPackageSchema = { apiVersion: 1, plugins: ExternalPlugin[1..50] }`.
- Produces (SDK): `type ExternalPlugin = ParserPlugin | EcosystemPlugin | GatePlugin`; `interface PluginPackage { apiVersion: 1; plugins: ExternalPlugin[] }`.

- [ ] **Step 1: Write failing tests**: config accepts `plugins: ['qg-plugin-x', '@scope/qg-plugin-y']`; rejects `'../x'`, `'/abs'`, `'a/b'`, `'UPPER'` and duplicates; a gate with `type: 'my-gate'` parses, `type: 'Bad Type'` fails; manifest schema accepts a valid package, rejects `apiVersion: 2`, a parser without `parse`, an unknown kind (`storage`) and an empty plugin list.
- [ ] **Step 2: Run** `node --experimental-test-module-mocks --import tsx --test tests/external-plugins.test.ts` and watch it FAIL.
- [ ] **Step 3: Implement** the schema and types; fix typecheck fallout of `type` widening.
- [ ] **Step 4: Run** the test and `pnpm typecheck` until clean.
- [ ] **Step 5: Commit** `feat(protocol): add plugins list and external plugin schemas`.

### Task 2: Loader and fixture package

**Files:** create `packages/core/src/external.ts`, `tests/fixtures/plugin-package/{package.json,index.js}`; test `tests/external-plugins.test.ts` (extend).

**Interfaces:**
- Produces: `loadExternalPlugins(directory: string, packages: string[], reserved?: Iterable<string>): Promise<LoadedPlugins>` with `LoadedPlugins = { parsers: Record<string, ParserPlugin>; ecosystems: EcosystemPlugin[]; gates: Record<string, GatePlugin> }`. The package is `<directory>/node_modules/<name>`; entry is `exports` (`.` string, `import` or `default`), else `main`, else `index.js`; the entry must stay inside the package folder (symlinks resolved first, as pnpm links packages). The module exports `manifest` or `default`.

- [ ] **Step 1: Write failing tests** with the fixture copied into a temp project's `node_modules`: loads parser, ecosystem and gate; scoped package; `exports` string / object / `main` / default `index.js`; ESM default-export manifest; each Review Focus 2-4 failure with its message (`Plugin package not found`, `entry outside the package`, `Cannot load plugin`, `exports no manifest`, `Duplicate plugin id`, `Invalid plugin package`); `reserved` ids rejected.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core): load external plugin packages from node_modules`.

### Task 3: Runner integration

**Files:** modify `packages/cli/src/runner.ts`; test `tests/external-plugins.test.ts` (extend).

**Interfaces:** `execute` loads `config.plugins` from the config directory with the built-in ids reserved, merges `{ ...builtinParsers, ...external.parsers }` into the command plugin, routes `spec.type` to a built-in or external gate, and throws `Unknown gate type: <type>` (exit 2) before running when neither exists. `loadConfig` stays pure (no plugin code runs when only listing gates).

- [ ] **Step 1: Write failing tests** with a temp project: a gate reading `report: { format: 'fixture-json', ... }` becomes findings through the fixture parser; a gate with `type: 'fixture-gate'` runs the fixture gate; unknown type and missing package give the errors above and run nothing; a project without `plugins` behaves as before (existing tests untouched).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the new tests plus `tests/cli*.test.ts`, `tests/gates.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(cli): run third-party parsers and gates from plugins`.

### Task 4: `setup --plugin`

**Files:** modify `packages/cli/src/setup.ts`, `packages/cli/src/index.ts`; test `tests/external-plugins.test.ts` (extend).

**Interfaces:** `setupProject(configPath, ecosystems = builtinEcosystems, plugins: string[] = [])`: loads the packages, appends their ecosystems after the built-ins, writes `plugins:` into the config (omitted when empty), returns additive `plugins: string[]`. CLI: repeatable `--plugin <package>`, accepted by `setup` only; text output adds a line `Plugins (run unsandboxed with your permissions): ...`; `--json` gains `plugins`.

- [ ] **Step 1: Write failing tests**: fixture ecosystem proposes a gate and the config lists the package; no `--plugin` writes no `plugins` key; missing package → error, no file written; existing config → `EEXIST`; real CLI `setup --plugin fixture --json`; `run --plugin x` → `run does not accept --plugin`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): add setup --plugin`.

### Task 5: Docs and verification

**Files:** modify `README.md`, `docs/PROJECT_SETUP.md`, `SECURITY.md`, `CHANGELOG.md`, `TODO.md`.

- [ ] **Step 1: Document** the `plugins:` key, the manifest shape with a minimal example, `--plugin`, the unsandboxed warning (README, docs, SECURITY.md), CHANGELOG entry; tick T-023 and T-035 in `TODO.md`.
- [ ] **Step 2: Run** `pnpm check` then `pnpm verify:release` (re-run `verify:package` alone once if it flakes after sleep).
- [ ] **Step 3: Record** with `reflect.mjs record`, commit, and `git push` chained with `&&` after both checks pass.

---

## Self-review notes

- Spec coverage (Phase 3): `plugins:` key (T1), resolution from `node_modules` and manifest validation (T2), duplicate rejection (T2), third-party parsers/ecosystems/gates (T3, T4), `setup --plugin` (T4), unsandboxed warning (T5).
- Deliberate simplifications: no lockfile pin, prompt or signature (owner decision; T-045 covers stronger isolation); only the project's own `node_modules` is searched; `audit`, `storage` and `reporter` stay built-in.
