# Contributing to QualityGate

QualityGate runs declared project checks and gives developers, CI and MCP clients
the same verdict and evidence. See [VISION.md](VISION.md) for scope and direction.

## Set up

Use Node 22.23.4+ and pnpm 11.28.9 (the version in `packageManager`).
The development baseline is pinned in `.nvmrc`. npm uses `.npmrc`; pnpm 11 uses
the matching engine/version settings in `pnpm-workspace.yaml`.
Use pnpm 11.28.9 for checkout installs and scripts. Native developer-engine checks
and a local preinstall guard enforce it; the checks are repository-scoped.
New registry dependency versions must be at least seven days old, including
transitives. Do not bypass the cutoff with overrides/exclusions to make an install
pass: select an eligible compatible version and regenerate/review the lockfile.

```sh
nvm install
nvm use
pnpm install --frozen-lockfile
uv tool install ruff==0.9.2
pnpm check
node dist/qualitygate.mjs run
```

Ruff 0.9.2 is required for the Python adapter tests. If you do not use uv, choose
another method from the [Ruff installation docs](https://docs.astral.sh/ruff/installation/).

`pnpm check` runs lint, strict TypeScript checks, complexity/code smell analysis,
tests with enforced coverage thresholds, and all workspace builds. Open
`coverage/index.html` for uncovered lines/branches; JSON and LCOV are also emitted.
The only coverage exclusion is the SDK's interfaces-only file. New runtime files
are included even before a test imports them. See `.c8rc.json` for the exact floors.

`pnpm analyze` checks product code with the standalone `@qualitygate/code-analysis`
workspace package. Refactor a reported hotspot rather than raising its threshold.
Tests are outside the complexity scan, but remain linted and typechecked. The repository's
`.qualitygate.yml` defines its own command gates. MCP clients use the built CLI;
rebuild after changing source code. Gate commands execute on your machine: review
configuration before running it. See [SECURITY.md](SECURITY.md).
See [CODE_QUALITY.md](docs/CODE_QUALITY.md) for the exact defaults and how another
project uses its own lint/test policy. Formatting is not yet fully standardized.

For local UI development, build once and run `pnpm dev:ui` at
http://qualitygate.localhost:1355. Portless is pinned to a Node-22-compatible release;
its proxy and backend remain loopback-only. `pnpm dashboard --port 4173` remains
a direct fallback. Rebuild dashboard source with `pnpm build:dashboard`.
See [project setup](docs/PROJECT_SETUP.md) for attaching the CLI to another app,
CI and optional Husky hooks. This checkout's hooks are not installed automatically.

For changes to browser execution, cancellation, storage or packaging, also run:

```sh
pnpm smoke:portless # Named-origin UI/CSRF/cleanup in Chrome
pnpm verify:hooks   # Real Husky in an isolated temporary Git repository
pnpm smoke          # Requires an installed Chrome; CHROME_PATH may select it
pnpm verify:clean   # Fresh workspace install and checks
pnpm verify:package # Local tarball install and real Chrome smoke
```

## Send a change

Open an issue for substantial behavior or contract changes. A small fix can go
straight to a pull request. Explain the concrete problem, the resulting behavior,
and the checks you ran. Keep a PR focused and add a regression test for changed
behavior. Update examples and documentation when configuration or output changes.
Do not commit generated run directories, secrets or private project logs.

New checks belong in plugins; keep tool-specific execution out of core. Preserve
versioned protocol validation, deterministic policy evaluation, error visibility,
and resource cleanup. Test extension through the SDK with an independent plugin.
Do not turn missing evidence or failed execution into a successful result.

The maintained source lives under `packages/`. `legacy/lighthouse-v1/` is a historical
archive with its own ISC license and separate dependency installation; it is excluded
from the workspace. QualityGate contributions are made under the root MIT license.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public issue.
