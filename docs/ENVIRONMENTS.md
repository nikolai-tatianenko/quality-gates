# Verified execution environments

Runtime baseline refreshed on 2026-10-31; earlier observations are retained below.
These are observed environments, not a claim that
every OS, browser release or model backend has been tested.

| Environment | Verification |
| --- | --- |
| macOS, Node 22.23.4, Chrome 156.0.8078.74 | Complete release verification, tarballs, Chrome lifecycle, dashboard, Portless and real Husky fixtures |
| macOS, Node 22.19.0, Chrome 156.0.8078.74 | CLI and tarball smoke; real React + Python BLOCK → fix → PASS |
| Linux arm64, local isolated Docker container `mcr.microsoft.com/playwright:v1.63.0-noble`, Node 24.20.0, Chrome for Testing 153.0.8010.12 | Root sandbox startup failure reproduced with captured stderr; explicit `chrome.noSandbox: true` yields a successful real audit |
| Ruff 0.9.2 | Real Python lint/complexity checks and standalone analyzer tarball |
| Native Linux user account | Not verified by this local session |
| Windows | Not verified; POSIX command process-group cleanup is not a Windows support claim |

## Chrome startup

Chrome sandbox remains enabled by default. `chrome.launchTimeoutMs` defaults to
10 seconds and is bounded by the overall audit timeout. Startup errors include
the Chrome launcher's `chrome-err.log` tail when available, before cleanup.

Running Chromium as root in an isolated container without `--no-sandbox` was
locally reproduced as exit 2 with explicit sandbox diagnostics. In a container
you control, opt in through configuration:

```yaml
chrome:
  noSandbox: true
  launchTimeoutMs: 10000
```

This disables Chrome's sandbox; it does not make gate commands sandboxed. Prefer
fixing the host sandbox when possible. Do not apply this automatically to every
user or deployment. The smoke harness supports the explicit environment opt-in
`QUALITYGATE_CHROME_NO_SANDBOX=1` for isolated runners only.
The GitHub-hosted smoke workflow explicitly selects that opt-in; the workflow
was edited/parsed locally and has not been rerun remotely in this session.

```sh
pnpm verify:linux
```

This local Docker verification creates `.qualitygate/linux-repro/`, including an
environment record, a negative startup report and a passing raw Lighthouse report.
It installs runtime dependencies inside the container and never runs GitHub Actions.
The source bundle is mounted read-only and only the artifact directory is writable.

The earlier GitHub failure retained only ECONNREFUSED. Its exact historical cause
cannot be proven from that evidence. The local reproduction establishes one real
failure mechanism and checks the improved diagnostics and explicit container fix.
