# Security policy

QualityGate is an early 0.1.x release. Fixes target the latest version; older releases
and the `legacy/lighthouse-v1/` archive do not receive separate security backports.

## Execution boundary

**Команды гейтов не в песочнице. Gate commands are not sandboxed.**

Commands in `.qualitygate.yml` run through the system shell in the configuration
file's directory, with the current user's permissions and inherited environment.
They can read or modify files, access the network and launch processes. A timeout
and process-group cleanup are lifecycle controls, not a security isolation boundary.
Plugins are trusted local code and also run without a sandbox.

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

## Local dashboard and analysis

The React dashboard binds only to 127.0.0.1 and validates Host, Origin and a custom
header for state-changing requests. Each instance uses one trusted config selected
at startup. Do not expose it through a public proxy or tunnel; it is a local tool
without user authentication. Browser access does not sandbox the underlying gates.

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

CI publication is an explicit `qualitygate pr --write` action, outside MCP and the
gate runner. Keep PR-write tokens in a trusted serialized publisher, never in
target-code check jobs. Read the [CI trust boundary and concurrency limits](docs/CI.md)
before enabling description updates. Provider API roots are HTTPS (loopback HTTP
only for tests), redirects are rejected, and generated tool text is escaped.

## Report a vulnerability


Use GitHub's private reporting page:
https://github.com/example-org/qualitygate/security/advisories/new

Include the affected version, a minimal reproduction, expected versus actual
behavior, and the impact. Remove credentials and private data from attachments.
Do not put exploit details or secrets in a public issue. If private reporting is
unavailable, open an issue that only requests a private contact channel, without
vulnerability details. There is no guaranteed response time for this project.
