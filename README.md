# QualityGate prototype

[Product vision](VISION.md) · [Verification](docs/VERIFICATION.md)

A local CLI that runs Lighthouse sequentially, checks explicit category thresholds,
saves evidence and returns a CI exit code. Node **22.19+**, **pnpm 11.5.1**, and an
installed Chrome are required. Set `CHROME_PATH` to an executable if discovery fails.

```sh
pnpm install --frozen-lockfile
pnpm check
node dist/qualitygate.mjs init https://example.com
node dist/qualitygate.mjs run
node dist/qualitygate.mjs run --config .qualitygate.yml --json
```

`init` creates `.qualitygate.yml` without replacing existing files. Configure one or
more HTTP(S) URLs. Scores and thresholds use 0–100; all four thresholds are required.
Paths in outputDir are relative to the configuration file, independent of your cwd.

```yaml
schemaVersion: 1
urls:
  - http://127.0.0.1:4173
thresholds:
  performance: 0
  accessibility: 0
  seo: 0
  best-practices: 0
outputDir: .qualitygate
timeoutMs: 120000
```

A zero threshold is useful for a passing demonstration; a missing metric still blocks.

To try the fixture locally, keep `pnpm fixture` running in another terminal. Run
`node dist/qualitygate.mjs init http://127.0.0.1:4173 --config demo.yml`, then edit
all thresholds to zero and run `node dist/qualitygate.mjs run --config demo.yml`.
This passes with exit 0. Change `seo` to **100** and run again: the fixture deliberately
omits a meta description, so it blocks with exit 1. The smoke test also evaluates
the same saved scores under both threshold sets to verify deterministic policy.

Every run creates `.qualitygate/<runId>/report.json` and an indexed raw Lighthouse
JSON per URL. Ordinary output shows scores, errors and evidence paths. `--json`
writes exactly one JSON value to stdout. Run results follow `runResultSchema` in
`packages/protocol/src/index.ts`; init/help and pre-run failures have versioned
schemas there too. Execution status is separate from the PASS/BLOCK decision.

| Exit | Meaning |
| --- | --- |
| 0 | Completed, PASS |
| 1 | Completed, BLOCK (including missing required metrics) |
| 2 | Configuration, browser, audit, cleanup or storage error |
| 130 | Interrupted with SIGINT or SIGTERM |

Errors take precedence over BLOCK. Completed results are preserved when later URLs
fail. Interruptions skip remaining URLs, stop the audit worker, kill the owned Chrome
process group and save a summary. Timeout includes startup; waiting for Chrome startup
to settle and cleanup may add roughly three seconds. Unavailable storage is explicit
in the JSON result; no saved report is promised when the filesystem rejects writes.

```sh
pnpm verify:clean    # Fresh pnpm install, lint, typecheck, tests and build
pnpm smoke           # Real Chrome: PASS/BLOCK, multi-URL failure, timeout, Ctrl+C, storage
pnpm verify:package  # Pack locally, install in temp dir, repeat smoke using installed CLI
```

Smoke evidence remains under `.qualitygate/smoke-*`. CI installs the lockfile, runs
checks/build, provisions Chrome and runs both workflows, then uploads the evidence.
Its Chrome setup uses the documented [setup-chrome action](https://github.com/browser-actions/setup-chrome).
Nothing is published to npm. To install a local package manually:

```sh
npm pack
npm install --prefix /tmp/qualitygate-demo ./qualitygate-prototype-0.1.0.tgz
/tmp/qualitygate-demo/node_modules/.bin/qualitygate --help
```

In the repository, the original CommonJS service is retained as `pnpm start <URL...>` (or
`npm start -- <URL...>`), using legacy dependency aliases. Its known defects are
listed in [prototype scope](docs/PROTOTYPE.md). The new CLI does not use that service.
Plugins are trusted local code and provide no sandbox boundary. Dashboards, Ink,
desktop and visual regression are deferred. License: ISC.

## Command gates

Any check that signals failure with its exit code can be a gate: type checks, linters,
tests, coverage scripts, `npm audit`. Exit 0 is PASS; anything else (including a killed
or missing command) BLOCKs. `urls` and `thresholds` are optional when `gates` is set.

```yaml
schemaVersion: 1
gates:
  - id: lint
    run: pnpm lint
  - id: test
    run: pnpm test
    timeoutMs: 300000      # default 5 minutes
urls: [https://staging.example.com]   # optional Lighthouse audit, same verdict
thresholds: { performance: 80, accessibility: 90, seo: 90, best-practices: 90 }
```

Commands run through the shell in the directory of the config file. Their full output
is stored as `gate-<n>-<id>.log` in the run directory; the report keeps the last 4 KB.
Run a subset with `qualitygate run --gate lint --gate test`. A timeout or Ctrl+C kills the
command's whole process group. Gate commands are trusted config, not sandboxed code.
This repository gates itself: `.qualitygate.yml`, then `node dist/qualitygate.mjs run`.

## MCP: the same verdict for AI agents

`qualitygate mcp --config <path>` serves three tools over stdio:

| Tool | Does |
| --- | --- |
| `list_gates` | Gate ids and commands, URLs and thresholds from the config |
| `run_gates` | Runs all gates, or `gates: [ids]`; returns the PASS/BLOCK result, with output only for failing gates |
| `get_run` | A stored run by `runId`, or the latest |

Agents can run only what the config declares: no tool accepts a command, path or URL.
Claude Code (`.mcp.json` in your project, after `pnpm build`):

```json
{ "mcpServers": { "qualitygate": {
  "command": "node", "args": ["/abs/path/to/dist/qualitygate.mjs", "mcp", "--config", ".qualitygate.yml"]
} } }
```

Then ask the agent to run the quality gates before it reports a task as done.
