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
