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

## Existing defects

The legacy service suppresses audit and write errors, only kills Chrome on success,
and relies on a transitive chrome-launcher dependency. The workflow has no trigger,
uses an unsupported Node release and references a nonexistent entrypoint. There are
no tests. Legacy `pnpm start <url>` remains available during migration.

## Scope

Only protocol, plugin SDK, core, policy, CLI, Lighthouse, JSON reporter and filesystem
storage packages. Plugins are trusted local code, without sandbox protection.
MCP, dashboards, ESLint/Vitest integrations, Ink, desktop and license changes are
outside this prototype. The ISC license remains. All commits stay local.

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
