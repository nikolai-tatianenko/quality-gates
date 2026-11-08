# Security policy

QualityGate is an early 0.1.x release. Fixes target the latest version; older releases
do not receive separate security backports.

## Execution boundary

**Gate commands are not sandboxed.**

Commands in `.qualitygate.yml` run through the system shell in the configuration
file's directory, with the current user's permissions and inherited environment.
They can read or modify files, access the network and launch processes. A timeout
and process-group cleanup are lifecycle controls, not a security isolation boundary.
Plugins are trusted local code and also run without a sandbox: a package listed under `plugins:`
in `.qualitygate.yml` (or passed to `setup --plugin`) is imported into the QualityGate process with
your permissions, environment and tokens. See "Third-party plugins" below.

External review methodologies are trusted reference material selected in config.
Source synchronization downloads bare Git objects, disables Git hooks and system/
global Git configuration, and executes no downloaded scripts. Updates are explicit
and pinned in a separate lockfile. This is not an OS sandbox or a guarantee that
upstream instructions are safe. MCP may read pinned methodology files; it cannot
update the lock or select a new repository URL. Review producers are ordinary
unsandboxed gate commands. Cloudflare's audit workflow requires additional agent
capabilities and isolation that this application does not provide.

Review the repository and configuration before running gates, including when an
MCP client or AI agent asks to execute them. The MCP server only exposes gates and
URLs declared in the selected configuration; its tools accept no arbitrary command,
path or URL. This limits the tool interface, but does not make those configured
commands safe. The project configuration itself must be trusted and protected.

Use least-privilege CI jobs. Do not expose secrets to untrusted pull-request code.
Use a container or another isolation boundary you control when running untrusted
checks. Lighthouse opens configured URLs in Chrome; only audit authorized targets.
Raw reports and command logs may contain sensitive project data. Review artifacts
before sharing them or uploading them to public CI storage.

## Third-party plugins

`plugins: [package]` loads code from the project's `node_modules`. Listing a package is the only
opt-in: there is no lockfile pin, signature, permission prompt or sandbox yet (tracked as T-045).
A plugin can read and write files, use the network, spawn processes and read secrets from the
environment, exactly like a gate command. Only `run` imports plugins; listing gates, inspecting
runs and the dashboard do not. Install only reviewed packages with pinned versions (the repository's
7-day release-age policy applies to adding them), and do not run `qualitygate run` in CI on
untrusted pull requests that can change `.qualitygate.yml`, `package.json` or the lockfile.
Names are checked as npm package names before anything is imported (so `setup --plugin ../../evil` is rejected,
before any code runs), and a package whose real path is outside `<project>/node_modules` (pnpm's
`node_modules/.pnpm` store is inside) is refused; workspace `link:` packages must be installed instead.
The loader validates the manifest (`apiVersion: 1`, known kinds, unique ids, entry file inside
the package folder); that is a correctness check, not a security boundary.

## Reports and artifacts

`qualitygate setup` only reads file names and small manifests and writes a config for you to
review; the commands it proposes (including the Unity editor and test runners) are ordinary
unsandboxed gate commands that run with your permissions once you run them. Ecosystem plugins are
trusted local code, like every plugin.

Command gates may read a report file and copy artifact files into the run evidence. Both
paths must resolve inside the project (the directory of `.qualitygate.yml`); absolute paths,
`..` and symlinks are rejected or skipped, reports are limited to 5 MB and artifacts to 50
files and 50 MB. The gate command itself is still trusted, unsandboxed code. Copied artifacts
(screenshots, traces, logs) may contain secrets or personal data: keep `.qualitygate/` out of
version control and review it before sharing a run (export, tunnel or CI upload).

## Local dashboard and analysis

The React dashboard binds only to 127.0.0.1 and validates Host, Origin and a custom
header for state-changing requests. Each instance uses one trusted config selected
at startup. Do not expose it through a public proxy or tunnel; it is a local tool
without user authentication. Browser access does not sandbox the underlying gates.

`pnpm dev:ui` uses Portless's public proxy API on a dedicated loopback listener.
The backend is also loopback-only. Its explicit named `.localhost` origin is
validated; `X-Forwarded-*` headers are not trusted. The wrapper does not enable
LAN/tunnel sharing, install certificates, edit hosts files or reuse a global proxy.
Changing the proxy port uses `PORTLESS_PORT`; stop the wrapper to close both servers.

## Local bridge

`qualitygate bridge` (see [docs/BRIDGE.md](docs/BRIDGE.md)) is the one local interface meant for clients other than
the terminal (a planned browser extension and desktop shell). It binds only to 127.0.0.1 and checks `Host` against the
bound port (DNS rebinding) and `Origin` against an allow list: `chrome-extension://<id>`, the Tauri origins and
`http://127.0.0.1:4173`; extra origins are exact and limited to those shapes. Nothing can run without a bearer token. A
token is obtained by typing a one-time, ten-minute pairing code that is printed only in the terminal (five wrong guesses
burn it), is pinned to the origin that paired, expires after 30 days and can be revoked. Only SHA-256 hashes are stored,
in a `0600` file under `outputDir` (not enforced on Windows). Requests are rate limited and capped at 4 KiB, CORS answers
the exact origin, and the API accepts no command, path or configuration: a run names gates that already exist in
`.qualitygate.yml`, a scan names an `http(s)` URL without credentials. Gate logs (including secret scanner output), raw
gate reports and absolute paths are never returned. The bridge is not a sandbox: the approved gates still run as your
user, and software running as you can read the project directory and token file. Do not forward the port. The scan
endpoint makes your local Chrome load the given URL, so the client must obtain consent first. This is implemented and
tested on the server side only; no extension or desktop client exists yet, and nothing was tested on Windows.

The code-analysis package scans TS/JS with fixed ESLint/SonarJS rules and Python
with Ruff's isolated configuration. It does not execute scanned Python code or
apply fixes. Ruff is a trusted executable from PATH (or an explicit API path), run
without a shell, with bounded output and a timeout. Analysis can process untrusted
source data, but the analyzer/runtime itself is not a security sandbox.

`qualitygate ask` sends prompts and invoked tool results to the explicitly selected
model endpoint. Ollama/vLLM defaults point to localhost; a custom endpoint may be
remote. Review the destination and logs before using private projects. API keys
come from a named environment variable; never store them in URLs or project files.

## CI publication

CI publication (`qualitygate pr|status|comment|notify --write`) is an explicit action, outside MCP and the
gate runner. Keep PR-write tokens in a trusted serialized publisher, never in
target-code check jobs. Read the [CI trust boundary and concurrency limits](docs/CI.md)
before enabling description updates. Provider API roots are HTTPS (loopback HTTP
only for tests), redirects are rejected, and generated tool text is escaped. Fork PRs are refused:
`--write` requires `--head-repository` and aborts when it differs from `--repository`. The sticky comment
publisher only trusts marker comments written by a bot (or by `--author`), so other users cannot pin or
block it. The Slack webhook URL is a secret read from an environment variable, must be
HTTPS and is never printed; messages carry gate ids and a report link only.

## Report a vulnerability


Use GitHub's private reporting page:
https://github.com/nikolai-tatianenko/lighthouse-nodejs-cicd/security/advisories/new

Include the affected version, a minimal reproduction, expected versus actual
behavior, and the impact. Remove credentials and private data from attachments.
Do not put exploit details or secrets in a public issue. If private reporting is
unavailable, open an issue that only requests a private contact channel, without
vulnerability details. There is no guaranteed response time for this project.

The STRIDE analysis for the CLI, dashboard, tunnel share, CI publishers and plugin loading is in
[docs/threat-model/](docs/threat-model/README.md).

## Known dependency advisories

`pnpm audit --prod` (2026-11-03) reports one advisory; `pnpm audit` adds five dev-only ones.

- Resolved: `zod` is on 4.6.7 (the memory-exhaustion advisory is fixed in 4.6.6), and the
  repository's own `pnpm` is 11.28.9 (the pnpm tooling advisories are fixed in 11.11). A second
  zod 3.x copy remains only under `puppeteer-core` (a development dependency, not shipped).
- Accepted: `minimatch` (denial of service via glob amplification) reaches the runtime through
  ESLint in `@qualitygate/code-analysis`. ESLint 9 requires `minimatch` 3.x, the patched line
  (11.x) is a different major, and the policy forbids dependency overrides. Patterns come from
  the project's own configuration, not from network input. Revisit when ESLint moves to a
  patched `minimatch`.
- Accepted, development only: `glob` and `minimatch` under `c8`; `extract-zip` and `basic-ftp`
  under `puppeteer-core` (`@puppeteer/browsers`). They run in our test and verification
  tooling, not in the published CLI.

These are re-checked on each release; the 7-day release-age policy applies to every upgrade.

## Licences

`@qualitygate/code-analysis` depends on `eslint-plugin-sonarjs` (LGPL-3.0-only) as
a normal runtime dependency. It is installed alongside the package, not copied
into it or into the CLI bundle.

## Sharing a run

`qualitygate export` writes command output, findings and evidence paths into a static HTML file;
treat it like the logs themselves before uploading it anywhere. `pnpm dashboard --tunnel
cloudflare|ngrok` exposes a **read-only** dashboard through a public tunnel protected only by a
random per-start token in the URL: anyone holding the link can read logs, findings and evidence.
The tunnel offers no run-triggering endpoints, the tunnel process is stopped when the dashboard
exits, and tunnel tools are the user's own installed binaries (they run with your permissions).
