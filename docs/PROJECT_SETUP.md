# Add QualityGate to an existing project

QualityGate wraps your project's existing commands. The CLI can run in a terminal,
a Git hook, CI or an MCP client; the dashboard is a local interface to those same
checks. The target project can use TypeScript, JavaScript, Python or any tool that
returns a meaningful exit code.

## 1. Build a local CLI package

From the QualityGate checkout, with Node 22.23.4+ and pnpm 11.5.1:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p /tmp/qualitygate-packages
pnpm pack --pack-destination /tmp/qualitygate-packages
```

No package is published to npm by these commands. In your target project:

```sh
mkdir -p tools
cp /tmp/qualitygate-packages/qualitygate-toolbox-0.1.0.tgz tools/
pnpm add -D ./tools/qualitygate-toolbox-0.1.0.tgz
```

Keep the archive at this repository-relative path so another checkout/CI runner
can install it. Commit `tools/qualitygate-toolbox-0.1.0.tgz`, `package.json` and
the target project's lockfile. The CLI package does not include the dashboard
server/assets; the dashboard runs from the QualityGate source checkout.

## 2. Declare the project's checks

Create `.qualitygate.yml` in the target project's root:

```yaml
schemaVersion: 1
gates:
  - id: lint
    run: pnpm run lint
  - id: typecheck
    run: pnpm run typecheck
  - id: tests
    run: pnpm run test:ci
    timeoutMs: 300000
outputDir: .qualitygate
```

These are your own scripts, not scripts installed by QualityGate. Ensure the names
exist in your `package.json`. Use a terminating test command, for example
`vitest run`, `jest --ci` or `python3 -m unittest discover -v`, instead of watch mode.
For Python-only projects, gates can invoke Python commands directly; Node is still
needed for the QualityGate CLI. See the [Python example](../examples/python-project/).

`qualitygate setup` generates this file from the matching `package.json` scripts and appends
the `.gitignore` entries below; it fails instead of overwriting an existing config. Review the
generated test command: it must exit, not run in watch mode.

Add these entries to the target project's `.gitignore`:

```gitignore
.qualitygate/
.qualitygate-ci/
.qualitygate-review-sources/
```

Run the checks:

```sh
pnpm exec qualitygate run
pnpm exec qualitygate run --gate lint --gate typecheck
pnpm exec qualitygate run --json
```

Commands run relative to the configuration file. `0` is PASS, `1` is BLOCK, `2`
is a configuration/execution/storage error and `130` is interruption. Each run
saves its JSON report and evidence beneath `.qualitygate/<run-id>/` when writable.
For an ESLint JSON report with file/line/rule findings, use `type: eslint` and an
actual command such as `pnpm exec eslint . --format json`. A generic command gate
uses its exit code and saves output; it does not infer source locations from text.

## 3. Attach Husky hooks

QualityGate supplies the gate runner. [Husky](https://typicode.github.io/husky/get-started.html)
connects it to Git events. Husky is optional and is installed in the target
project, not enabled automatically in this repository.

For a project that does not already have Husky:

```sh
pnpm add -D husky@9.1.7
pnpm exec husky init
```

`husky init` creates a default pre-commit hook and sets the `prepare` script.
Merge with an existing `prepare` script if necessary; preserve its current work.
For a project with existing hooks, add the commands below to those files instead
of replacing their contents. Keep the hook command's failure status; do not append
an unconditional successful command that hides a failed gate.

Fast `.husky/pre-commit`:

```sh
pnpm exec qualitygate run --gate lint --gate typecheck
```

Full `.husky/pre-push`:

```sh
pnpm exec qualitygate run
```

The IDs must match your configuration. Selecting gate IDs skips URL audits;
this keeps the pre-commit hook focused on quick checks. The full pre-push command
also runs tests and configured URL audits. If you audit an app URL, start the app
separately first; neither hook starts an application server automatically.
Copyable files are in [examples/hooks](../examples/hooks/README.md). The hook bodies
use the current Husky command format; deprecated `husky.sh` boilerplate is not needed.

These check the **working tree**, including unstaged changes. They do not create a
staged snapshot. Hooks can be bypassed (`HUSKY=0`, `--no-verify`); CI must run the
required gates independently. Avoid recursion: do not make a gate run a script
that calls `qualitygate run` again. An optional script named `qualitygate:check`
can call QualityGate; your `lint`/`typecheck`/`test:ci` scripts should call their tools.

Test the configuration directly before enabling hooks, then commit the hook files,
config and manifest changes to your own project. On another checkout,
`pnpm install` runs the project's `prepare` script to install Husky's Git wrappers.

## 4. Use the same checks in CI

CI runs the CLI, not the long-running dashboard or a publicly hosted UI.
Set `HUSKY=0` for installation so CI does not install local Git hooks:

```sh
HUSKY=0 pnpm install --frozen-lockfile
pnpm exec qualitygate run --json
```

The gate's exit code decides the CI job result. Do not use `|| true` to turn a
BLOCK into success. Use the [CI templates](CI.md) for GitHub Actions, GitLab CI and
Bitbucket Pipelines: they preserve the gate exit code while producing Markdown
and uploading failure evidence. PR/MR description publishing uses a separate
trusted credential boundary.

The CLI does not require Chrome for command-only configs. URL audits require
Chrome and a reachable app; Python analysis requires the configured Python/Ruff
toolchain; SonarQube gates need a scanner/server/token. Provide these explicitly
in CI. Use the documented Chrome sandbox opt-in only in an isolated runner you
control. A runner timeout or cancellation can interrupt artifact upload.

## 5. Open this project's local dashboard

From the QualityGate checkout:

```sh
pnpm build
pnpm dev:ui --config /absolute/path/to/target/.qualitygate.yml
```

Open **http://qualitygate.localhost:1355**. The Vercel Portless proxy and backend
both bind to 127.0.0.1. The backend port is allocated automatically; the front URL
stays stable. If proxy port 1355 is occupied, choose another unprivileged port:

```sh
PORTLESS_PORT=1356 pnpm dev:ui --config /absolute/path/to/target/.qualitygate.yml
```

This integration uses Portless's public proxy API with a private, fixed route.
There is no proxy daemon to install or stop separately. Ctrl+C closes the proxy
and drains the dashboard service. It does not install a CA, edit `/etc/hosts`, or
change your system/global Portless configuration. HTTP on a named `.localhost`
origin is intentional. Portless 0.12.0 is pinned for Node 22 compatibility; newer
Portless releases currently require Node 24.

Use a browser that resolves `.localhost` names (verified in Chrome). The direct
fallback needs neither Portless nor local hostname resolution:

```sh
pnpm dashboard --config /absolute/path/to/target/.qualitygate.yml --port 4173
```

Open http://127.0.0.1:4173. The standalone server also respects `PORT`; `--port`
overrides it. `PORTLESS_URL` is accepted only as an explicit named `.localhost`
origin, never as an arbitrary external address; forwarded headers are not trusted.
The UI supports Light/Dark/Auto modes, with preferences stored per browser origin.
Rebuild with `pnpm build:dashboard` after editing dashboard source; Portless supplies
routing, not a frontend hot-reload compiler.

## 6. Attach an agent

From the target project with the CLI installed:

```sh
pnpm exec qualitygate connect --client claude --config .qualitygate.yml
```

Merge the printed snippet into the client's settings; the command does not write
client configuration. The client launches a stdio MCP process, independently of
the dashboard. See [agent integrations](INTEGRATIONS.md) for other clients/providers.

## Verify the examples locally

From the QualityGate checkout:

```sh
pnpm check
pnpm smoke:portless
pnpm verify:hooks
pnpm verify:ci-templates
```

Portless verification uses an actual loopback proxy and Chrome. Hook verification
installs Husky 9.1.7 in a disposable Git fixture and links the actual built CLI.
It checks blocked/successful commits and full pre-push checks via dry-run pushes
to a temporary local bare repository; it does not change this checkout's hooks or
push to a remote service. Gate commands remain trusted code, not sandboxed.
