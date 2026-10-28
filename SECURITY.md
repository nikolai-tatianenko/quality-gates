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

## Report a vulnerability

Use GitHub's private reporting page:
https://github.com/example-org/qualitygate/security/advisories/new

Include the affected version, a minimal reproduction, expected versus actual
behavior, and the impact. Remove credentials and private data from attachments.
Do not put exploit details or secrets in a public issue. If private reporting is
unavailable, open an issue that only requests a private contact channel, without
vulnerability details. There is no guaranteed response time for this project.
