# Preparing a GitHub update

The current scope is a **developer preview**: a working local CLI, React workspace,
TS/JS and Python analysis, Lighthouse and MCP. A GitHub update does not need to wait
for a dashboard history service, desktop app or every possible model provider.
Describe unverified editor/model integrations as experimental.

## Local acceptance check

With Node 22.23.4+, pnpm 11.5.1, Ruff 0.9.2 and Chrome installed:

```sh
pnpm install --frozen-lockfile
pnpm verify:release
```

The release command runs these steps sequentially:

1. Lint, typecheck, code analysis, all tests with coverage floors, and workspace builds.
2. Standalone analyzer tarball install: executable/API, TS and Python BLOCK → PASS.
3. CLI tarball install: real Chrome, errors, timeout, interruption and cleanup.
4. The documented `pnpm dashboard` command in real Chrome: Python BLOCK → source
   fix → PASS, desktop/mobile screenshots and no browser JS errors.

Summary: `.qualitygate/release-check.json`. Coverage and browser evidence stay in
`coverage/` and `.qualitygate/`. None of these commands pushes commits, publishes
packages or triggers a remote workflow. For dependency/workspace changes, also run
`pnpm verify:clean` and `pnpm smoke` to check the locked source graph as well as
the independently resolved consumer install; for browser platform changes, use `pnpm verify:linux`.

## Before making the update public

- Review `git diff --check`, staged changes, README and CHANGELOG.
- Commit source/docs/tests/lockfile, excluding generated artifacts and credentials.
- Keep existing tags intact; choose a new version/tag only for an actual release.
- After a separately authorized push, inspect the GitHub Actions result. Local
  checks and a parsed workflow are not a claim that the remote workflow is green.

The configured CI covers checks/coverage, analyzer and CLI tarballs, and the React
browser workflow. `pnpm smoke` uses the source workspace's age-checked lockfile;
`verify:package` tests the consumer installation's separately resolved graph.
Both matter when the source graph intentionally delays newly published versions.

Live Cursor/Codex editor sessions, live Ollama/vLLM inference and native Windows
process cleanup remain outside the verified support matrix. See
[environments](ENVIRONMENTS.md) and [integrations](INTEGRATIONS.md) for exact limits.
