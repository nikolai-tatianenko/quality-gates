# Add QualityGate to an existing project

QualityGate wraps your project's existing commands. The CLI can run in a terminal,
a Git hook, CI or an MCP client; the dashboard is a local interface to those same
checks. The target project can use TypeScript, JavaScript, Python or any tool that
returns a meaningful exit code.

## 1. Build a local CLI package

From the QualityGate checkout, with Node 22.23.4+ and pnpm 11.28.9:

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

`qualitygate setup` generates this file from the built-in ecosystem plugins and appends the
`.gitignore` entries below; it is non-interactive and fails instead of overwriting an existing
config. Review the generated commands: the test command must exit, not run in watch mode.

| Ecosystem | Detected by | Gates |
|---|---|---|
| node | `package.json` scripts | `lint`, `typecheck`, `tests` (`<manager> run <script>`) |
| python | `pyproject.toml` or `requirements*.txt` | `lint` (`ruff check .`), `tests` (`pytest --junitxml`, `junit` report), `typecheck` (`mypy .`, only when mypy is mentioned) |
| unity | `ProjectSettings/ProjectVersion.txt` | `unity-compile` (`unity-log` report) and `unity-tests` (EditMode, `nunit` report) |
| playwright | `playwright.config.*` | `tests` (`playwright-json` report; screenshots, videos and traces as artifacts) |
| maestro | `.maestro/` or `flows/` with `appId:` flows | `e2e-mobile` (`maestro test --format junit`) |

If several ecosystems propose the same id (for example `tests`), each of those gates is renamed
`<ecosystem>-<id>` (`node-tests`, `playwright-tests`); other ids stay as they are. Reports are
written under `.qualitygate/<ecosystem>/`.

Unity gates run `${UNITY:-/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity}`
with the version from `ProjectVersion.txt`; on Windows or Linux set the `UNITY` environment
variable to the editor binary. Before each run the gate removes a stale `Temp/UnityLockfile`, but
fails with "Unity project is open in an editor" if a `Unity` process is running.

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

### Test reports and artifacts

A command gate can add `report` and `artifacts`:

```yaml
gates:
  - id: e2e
    run: pnpm exec playwright test --reporter=json > playwright-report.json
    report: { format: playwright-json, path: playwright-report.json }
    artifacts: [test-results/**/*.png, test-results/**/trace.zip]
```

- `report.format` is one of `junit`, `nunit`, `playwright-json`, `eslint-json`, `unity-log`.
  Failures become findings with file, line and message where the format provides them.
- The command's exit code decides PASS/BLOCK. Non-zero exit and no report: BLOCK, the log is
  the evidence. Exit 0 and no report, an unreadable or unparsable report, or exit 0 with
  error findings in the report: execution `error` (exit code 2).
- `report.path` and artifact globs resolve inside the directory of `.qualitygate.yml`.
  Absolute paths, `..` and symlinks are rejected or skipped. Reports are limited to 5 MB;
  artifacts to 50 files and 50 MB, and a truncation note is appended to the gate output.
- Artifacts (and the report file) are copied into `.qualitygate/<run-id>/` and listed in the
  gate's `artifacts` array in `--json` output and MCP results; text output prints `Artifact:` lines.
  A glob that matches nothing is not an error (a passing Playwright run writes no traces).
- Artifacts can contain secrets or personal data (screenshots, logs); treat the evidence
  folder like the logs it already holds.

### Third-party plugins

**Plugins are not sandboxed.** A package listed under `plugins:` is imported into the QualityGate
process and runs with your user's permissions: it can read files, use the network, spawn processes
and read the environment, including tokens. Listing the package is the only opt-in, so install only
packages you have reviewed, pin their versions, and never enable a plugin from a pull request you
do not trust (CI that runs `qualitygate run` executes it).

```sh
pnpm add -D qg-plugin-example
pnpm exec qualitygate setup --plugin qg-plugin-example   # repeatable; writes the plugins: list
```

```yaml
plugins: [qg-plugin-example]    # resolved from this project's node_modules only
gates:
  - id: e2e
    run: example-runner --out results.json
    report: { format: example-json, path: results.json }   # a parser the package provides
```

A plugin package's entry module exports `manifest` (or a default export):

```js
export const manifest = {
  apiVersion: 1,
  plugins: [
    { apiVersion: 1, kind: 'parser', id: 'example-json', parse: (raw, { gateId, cwd }) => [/* Finding[] */] },
    { apiVersion: 1, kind: 'ecosystem', id: 'example', detect: async directory => null },  // for setup
    { apiVersion: 1, kind: 'gate', id: 'example-gate', run: async (spec, context) => ({ exitCode: 0, output: '' }) },
  ],
};
```

- Kinds: `parser` (a `report.format`), `ecosystem` (proposals for `setup`) and `gate` (selected
  with `type: <id>` on a gate). `audit`, `storage` and `reporter` stay built-in.
- The manifest must declare `apiVersion: 1` and is validated; ids are lowercase letters, digits,
  `-` and `_`. A duplicate id, including a clash with a built-in (`junit`, `node`, `command`...),
  a missing package or an invalid manifest is an execution error (exit code 2) and nothing runs.
- Only `<project>/node_modules/<package>` is searched. An unknown gate `type` also fails before
  any gate runs. Listing gates and viewing runs (`inspect`, dashboard, MCP `list_gates`) does not
  import plugins; `run` does.

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
