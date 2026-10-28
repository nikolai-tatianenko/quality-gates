# QualityGate prototype

The first deliverable is a local CLI for sequential Lighthouse audits of HTTP(S)
URLs, explicit category thresholds, durable evidence, and CI exit codes.

## Acceptance criteria

- `qualitygate init` creates configuration without overwriting a file.
- `qualitygate run --config .qualitygate.yml [--json]` audits all URLs.
- Scores use 0–100; absent required scores BLOCK. Execution and policy are separate.
- Each run stores raw Lighthouse JSON and an atomic summary in a unique directory.
- Exit codes: PASS 0, BLOCK 1, execution/config/storage error 2, interrupt 130.
- Timeout, interruption and failures always clean up Chrome; errors remain visible.
- Install, lint, typecheck, unit tests, build, local Chrome smoke and tarball install pass.

## Historical defects in Lighthouse v1

The legacy service suppressed audit and write errors, only killed Chrome on success,
and relied on a transitive chrome-launcher dependency. The former workflow had no trigger,
used an unsupported Node release and referenced a nonexistent entrypoint. There were
no tests. That implementation is now archived in `legacy/lighthouse-v1/`, outside
the main workspace; the root CLI is QualityGate.

## Scope

Only protocol, plugin SDK, core, policy, CLI, Lighthouse, JSON reporter and filesystem
storage packages. Plugins are trusted local code, without sandbox protection.
Dashboards, dedicated ESLint/Vitest plugins, Ink and desktop are outside this prototype. Command gates and the MCP server were added after the
prototype as the MVP (T-007, T-008). QualityGate now uses MIT; the archived implementation retains ISC.
The original local-only commit restriction has been removed. Commits, GitHub Issues,
repository metadata and the v0.1.0 tag may be published for this release.
Publishing a package to npm remains a separate action.

## Demonstration

See README for init, passing/blocking runs and `pnpm smoke` against a local fixture.

## Plugin lifecycle and evidence

The core accepts an audit, storage and reporter plugin through the version-1 SDK.
It rejects duplicate IDs and incompatible API versions. An audit registers cleanup
before acquiring resources; core awaits cleanup in reverse order even on failure.
The test audit plugin demonstrates extension without Lighthouse coupling in core.

The Lighthouse adapter owns its Chrome instance and terminates its audit worker on
completion, timeout or interruption. Launch settlement is awaited before cleanup;
Chrome startup can add up to roughly three seconds to a timeout. Each URL has a
separate result, including skipped URLs after interruption. Lighthouse runtime
errors retain their raw evidence. Evidence failures and cleanup errors are visible
separately from the threshold decision. Storage uses a unique run directory and
same-directory temporary files followed by atomic rename. If storage is unavailable,
results remain in memory for CLI output, with an execution error and no report path.

## CLI contract

`qualitygate init [URL...] --config <path>` writes explicit defaults with exclusive
creation. Without URLs it uses https://example.com. `qualitygate run --config <path>`
resolves outputDir relative to that configuration file. Unknown options and invalid
configuration exit 2. `--json` writes one JSON value to stdout (run result, init
result, help or error envelope); terminal text is excluded. SIGINT and SIGTERM mark
the run interrupted and preserve completed and skipped results before returning 130.
