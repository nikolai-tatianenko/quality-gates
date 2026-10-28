# Contributing to QualityGate

QualityGate runs declared project checks and gives developers, CI and MCP clients
the same verdict and evidence. See [VISION.md](VISION.md) for scope and direction.

## Set up

Use Node 22.19+ and pnpm 11.5.1 (the version in `packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm check
node dist/qualitygate.mjs run
```

`pnpm check` runs lint, strict TypeScript checks, tests and the build. The repository's
`.qualitygate.yml` defines its own command gates. MCP clients use the built CLI;
rebuild after changing source code. Gate commands execute on your machine: review
configuration before running it. See [SECURITY.md](SECURITY.md).

For changes to browser execution, cancellation, storage or packaging, also run:

```sh
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
