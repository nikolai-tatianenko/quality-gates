# Local bridge (QG-802 / QG-903)

`qualitygate bridge` starts an authenticated HTTP API on `127.0.0.1` so a client other than the terminal can list the
gates a project approved, run some of them, follow the run and read its results. It exists for the Chrome
extension ([CHROME_EXTENSION.md](CHROME_EXTENSION.md), T-066) and the desktop prototype ([DESKTOP.md](DESKTOP.md), T-065) and works for
any local client that can send an `Origin` header. The extension is built and was exercised against this bridge in real
Chrome (`pnpm smoke:extension`); the desktop host was exercised against this bridge (it presents the `tauri://localhost` origin), but the Tauri shell is **not built**
and nothing here has been tested against a Tauri webview or the Chrome Web Store.

It reuses `QualityGateService`, the same runner the MCP server and the dashboard use, so a run started through the
bridge is an ordinary run: same gates, same evidence, same history entry, same verdict and exit code.

## Start it

```bash
qualitygate bridge [--port 4180] [--origin <exact origin>...] [--config .qualitygate.yml]
# QualityGate bridge: http://127.0.0.1:4180
# Pairing code: K7QM-4TXD (single use, valid for 10 minutes)

qualitygate bridge --revoke-all     # delete every stored token; clients must pair again
```

`--port 0` picks a free port. The default is 4180. The bridge stops on Ctrl+C or SIGTERM (exit code 130 after SIGINT).
The pairing code goes to the terminal only; no HTTP endpoint returns it. A restart issues a new code. Tokens survive a
restart, so a client pairs once.

## Who may connect

Every request must carry an `Origin` header from this list, and a `Host` of `127.0.0.1:<port>` or `localhost:<port>`
(this blocks DNS rebinding). Anything else gets `403`, without CORS headers.

| Client | Origin |
| --- | --- |
| Chrome extension | `chrome-extension://<32 letters a-p>`; any id may attempt pairing, unless you name one with `--origin`, then only that id |
| Tauri desktop shell | `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost` |
| Web dashboard | `http://127.0.0.1:4173` (`pnpm dashboard` default); other ports only through `--origin http://127.0.0.1:<port>` |

`--origin` accepts only these shapes. Wildcards, `null`, `localhost` names and other sites are refused at startup.
CORS answers with the request's exact origin and `Vary: Origin`, never `*`.

## Pairing and tokens

1. The person reads the code from the terminal and types it into the client.
2. `POST /v1/pair {"code": "K7QM-4TXD", "label": "Chrome"}` returns `{token, tokenId, origin, expiresAt}`.
3. The client sends `Authorization: Bearer <token>` on every other request.

A code works once, expires after 10 minutes and is spent by 5 wrong guesses. A token is 256 random bits, is **pinned to
the origin that paired** (the extension id is recorded at pairing; the same token from another origin is `401`), expires
after 30 days and can be revoked: `DELETE /v1/token` revokes the caller's own token, `qualitygate bridge --revoke-all`
revokes all. Tokens are stored as SHA-256 hashes in `<outputDir>/bridge-tokens.json`, mode `0600` (directory `0700`),
replaced atomically; loose permissions on an existing file are tightened when the bridge starts. Keep `.qualitygate/`
out of version control. File modes are not enforced on Windows (unverified there).

## Limits

120 requests per minute per origin (`429` with `Retry-After`), pairing attempts 12 per minute per origin, request bodies
4 KiB (`413`), JSON only (`415`), unknown fields rejected (`400`). Only GET, POST, DELETE and the OPTIONS preflight exist.

## Endpoints

All responses are JSON unless noted. `auth` means a bearer token is required.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/ping` | no | `{name, apiVersion}`; origin and host are still checked |
| `POST /v1/pair` | no | exchange the code for a token |
| `DELETE /v1/token` | yes | revoke this token |
| `GET /v1/gates` | yes | `{gates: [{id, type}], scan: {available, thresholds}}`; command lines are not returned |
| `POST /v1/runs {"gates": ["lint"]}` | yes | run the selected gates (at least one, all must exist in the config); `202` with a job |
| `POST /v1/scans {"url": "https://..."}` | yes | audit one page with the configured Lighthouse thresholds; `202` with a job; `409` if the project has no thresholds |
| `GET /v1/jobs/:jobId` | yes | `status` is `running`, `cancelling`, `finished`, `cancelled` or `error`; when done: `runId`, `decision`, `execution`, `exitCode` |
| `POST /v1/jobs/:jobId/cancel` | yes | stop the job (`202`; `409` if it already ended) |
| `GET /v1/runs/:runId` or `latest` | yes | run summary: verdict, exit code, step registry, URL audit scores, per-gate result |
| `GET /v1/runs/:runId/findings` | yes | findings (message, file, line, rule, help URL) |
| `GET /v1/runs/:runId/artifacts` | yes | files a client may download: gate artifacts and Lighthouse reports |
| `GET /v1/runs/:runId/artifacts/:name` | yes | one listed file, as an attachment |
| `GET /v1/visual` | yes | visual-regression comparison of the latest run (`?run=<runId>` for another): `{enabled, runId, gateId, baselineDir, items: [{name, status, width, height, diffPixels, diffRatio, threshold, images}], warning?}`; `{enabled: false, items: []}` when the optional plugin left no `visual/visual.json`; no file paths |
| `GET /v1/visual?run=<runId>&name=<item>&image=approved\|current\|diff` | yes | one screenshot that run lists, as `image/png`; by item name only, links and non-PNG files are refused (`404`, `415`), 10 MB cap, header size must equal the item and stay under 40 megapixels (`422`) |
| `GET /v1/history?limit=20` | yes | recent runs and the comparison of the newest with the previous one |
| `GET /v1/trends?limit=50` | yes | blocks per week, failing and flaky gates |
| `GET /v1/team?limit=50` | yes | team view: decision, changes since the last run, top 3 risks, time to green, blocking gates with file:line findings and a reproduce command, and `markdown`; no gate output; an unreadable history is a `warnings` entry, not an error |

Only one run or scan is active at a time; a second request gets `409`. The `decision` and `exitCode` of a job and of
`GET /v1/runs/...` are the stored run's own (0 PASS, 1 BLOCK, 2 error, 3 timeout, 130 interrupted); the bridge cannot
change them, and a client has no way to mark a run passed. A scan is not written to the project's run history, because
an arbitrary page would distort trends.

## What a client never gets

- No shell, command, path or config input exists: a run names gate ids from the config, a scan names an `http(s)` URL
  without credentials (`file:`, `javascript:`, `chrome:`, `data:` and the like are `400`).
- No gate output. `outputTail`, `*.log` files and raw gate reports are never returned, so a secret scanner's log cannot
  reach a browser. Gate command lines and absolute local paths are also left out.
- Artifacts are served only if the run's report lists them, by file name, with `lstat` (a symlink in the run folder is
  refused), names containing `/`, `\`, NUL or a leading dot are `400`, and run ids must be UUIDs.

## Limits of this work

- The Chrome extension exists (QG-901/902/904-906, partly; see CHROME_EXTENSION.md). The desktop client's TypeScript side exists (QG-801 to QG-805, see DESKTOP.md); its Rust shell builds on macOS but is unsigned and not clicked through.
- A scan opens the page with the local Chrome through the configured Lighthouse gate, from the user's machine and
  network; it can reach any host that machine can reach. The extension shows the URL and asks for consent first (QG-902); other clients must do the same.
- Plain HTTP on loopback; any other local program of the same user can try to connect, but needs a valid Origin and a token
  that only an origin that paired holds. The bridge does not defend against malware running as the same user, who can read
  the project directory anyway.
- Run progress is state only (`running` until done); there is no log stream.
