# QualityGate threat model (T-040)

Method: STRIDE per component. Scope: the CLI and gate runner, the local dashboard, the tunnel
share, the CI publishers (`pr`, `status`, `comment`, `notify`) and plugin loading. Out of scope:
the security of the gate commands you configure, of the tools they call, and of the CI provider.
Related: [SECURITY.md](../../SECURITY.md), [CI trust boundary](../CI.md),
[sharing design](../design/2026-11-02-sharing-and-integrations-design.md).

## Assets

| Asset | Why it matters |
| --- | --- |
| Developer machine and CI runner (user permissions, environment, tokens) | Everything QualityGate runs, runs here |
| `.qualitygate.yml`, `package.json`, lockfile | They decide which commands and plugins execute |
| Run evidence in `.qualitygate/` (logs, reports, screenshots, traces) | May contain secrets and personal data |
| PR-write, `statuses: write` and Slack webhook credentials | Allow changing PR state and posting to a channel |
| The gate verdict and exit code (0/1/2/3/130) | Merge decisions depend on them |

## Trust boundaries

1. Project configuration and the packages it names are trusted. Whoever can edit them can run code.
2. Pull request code is untrusted. It must never reach a job that holds write tokens.
3. The local dashboard trusts only the loopback interface and one configuration chosen at start.
4. A tunnel link is a bearer secret: whoever holds it reads the dashboard.
5. Report files, tool output and artifacts produced by gates are data, never instructions.

## Execution boundary (CLI and gate runner)

| STRIDE | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Spoofing | A malicious config or dependency impersonates a legitimate gate | Config is explicit and reviewable; MCP exposes only declared gates | Config is fully trusted, no signature |
| Tampering | Gate output or a report file forges a PASS | Missing or invalid evidence is a BLOCK or error, never PASS; reports are schema validated (zod) | A gate command can lie about its own result |
| Tampering | Report or artifact path escapes the project (`..`, absolute, symlink) | Paths must resolve inside the config directory; symlinks skipped; 5 MB and 50 MB limits | Time-of-check races on a hostile local filesystem |
| Repudiation | Unclear which run produced a verdict | Each run has an id, timestamps and a stored `run.json` | Local files can be edited by the same user |
| Information disclosure | Logs and evidence contain secrets | Secrets come from environment variables only; Slack and status omit tool output; docs warn to keep `.qualitygate/` out of git | Tool output is stored as produced, no redaction |
| Denial of service | A gate hangs or floods output | Timeouts, process-group cleanup, bounded output, bounded report sizes | A tool can still exhaust CPU or disk within its timeout |
| Elevation of privilege | Gate commands run arbitrary code | Documented as unsandboxed; least-privilege CI advice; confirmation for MCP is the client's job | By design there is no isolation: run in a container for untrusted code |

## Local dashboard

| STRIDE | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Spoofing | A web page in the user's browser calls the local API | Binds 127.0.0.1 only; Host and Origin validated; custom header required for state-changing requests | No user authentication; any local process can connect |
| Tampering | DNS rebinding or CSRF starts a run | Host/Origin checks reject foreign names; `X-Forwarded-*` not trusted | Depends on browser enforcement |
| Information disclosure | Another local user reads runs | Loopback only, one trusted config per instance | Shared multi-user machines expose the port to other local users |
| Denial of service | Repeated run requests | One active run; cancel endpoint | A local process can still queue runs after each finishes |
| Elevation of privilege | Dashboard run button executes gates | Same as CLI: only configured gates | Same as CLI |

## Tunnel share (`pnpm dashboard --tunnel`)

| STRIDE | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Spoofing | Anyone with the URL reads the dashboard | 32-byte random token per start, constant-time compare, `HttpOnly; SameSite=Strict; Secure` cookie, redirect strips the token | The link is a bearer secret; leaking it (chat, history, referrer) leaks access |
| Tampering | Visitor starts or cancels a run | Forced read-only mode: only GET of assets, `/api/project`, `/api/run`; POST returns 405 | None known beyond bugs in the read-only filter |
| Information disclosure | Logs, findings, paths and evidence visible to the link holder | Warning printed before the URL; token dies with the process; tunnel closed on exit | Content is not redacted; the tunnel provider can observe traffic |
| Denial of service | Public traffic saturates the dashboard | Read-only static-style responses only | No rate limiting |
| Elevation of privilege | Tunnel binary is hostile | It is the user's own installed `cloudflared` or `ngrok`; nothing is downloaded | Supply chain of that binary is the user's responsibility |

## CI publishers (`pr`, `status`, `comment`, `notify`)

| STRIDE | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Spoofing | Fork PR code obtains a write token | Explicit `--write`; fork PRs refused (`--head-repository`); publisher runs in a trusted job on the base revision; head SHA must match | A misconfigured workflow that gives tokens to PR code defeats this |
| Tampering | Stale or changed PR is overwritten | Stale-head and closed-PR guards; marker-based sticky comment edits only its own comment | Race between the check and the write |
| Tampering | Injected markup or mentions in generated text | Generated tool text is escaped; Slack `&`, `<`, `>` escaped and capped | Provider markdown quirks |
| Repudiation | Who posted a status | Provider records the token owner | Shared tokens hide the individual |
| Information disclosure | Token or webhook leaks | Env-var only, never printed; Slack URL must be HTTPS with no credentials; messages carry gate ids and a link only | Detailed PR comments include the full report: only use on private repositories |
| Denial of service | Provider outage blocks a merge | Publishers never change the gate verdict or exit code; failures exit 2 for the publisher only | Missing status can block a required check |
| Elevation of privilege | Redirect or SSRF to an internal host | HTTPS API roots (loopback HTTP only in tests); redirects rejected | Operator-chosen API roots are trusted |

## Plugin loading

| STRIDE | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Spoofing | Typosquatted or substituted package | Only packages named in `plugins:` load, from the project `node_modules`; manifest checked (`apiVersion: 1`, known kinds, unique ids, entry inside the package) | No signature, no lockfile pin check by QualityGate (T-045) |
| Tampering | A PR edits `plugins:`, `package.json` or the lockfile | Docs forbid running `run` in CI on untrusted PRs that can change them; 7-day release-age policy for additions | Policy is advice, not enforced by the tool |
| Information disclosure | Plugin reads environment and tokens | None; plugins are trusted local code | Full exposure by design |
| Denial of service | Plugin hangs the process | Only `run` imports plugins; listing and inspection do not | No timeout on plugin import |
| Elevation of privilege | Plugin runs with user permissions, no sandbox | Documented in SECURITY.md; manifest validation is a correctness check only | Accepted until stronger isolation (T-045) |

## Residual risk summary

1. Gate commands and plugins are unsandboxed. Mitigate by running in a container or throwaway CI
   job and by reviewing configuration like code.
2. A tunnel link is a bearer secret over unredacted evidence. Share only short-lived and
   deliberately.
3. The dashboard has no authentication beyond loopback and Host/Origin checks.
4. Evidence is stored unredacted; the export, tunnel and CI uploads inherit that.
5. Dependency advisories that remain are listed in SECURITY.md (`minimatch` through ESLint).

## Follow-ups

- T-045: signed plugin manifests, permission prompts and stronger isolation.
- Optional redaction of known token patterns in stored logs.
- Rate limiting on the tunnel-facing server.
