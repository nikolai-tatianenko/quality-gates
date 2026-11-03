# Sharing and integrations design (T-036)

Scope: T-028..T-032. Shared rules: secrets come from environment variables only, remote URLs are
HTTPS only, nothing here changes exit codes (0/1/2/130), SDK `apiVersion` stays 1, and the
existing `packages/ci` description publisher is reused rather than replaced. Order: T-028 and
T-029 first (local, no credentials), then T-030, T-031, T-032.

## Export format (T-028)

`qualitygate export --out <dir> [--config <path>] [--input <run.json>]` renders one run as a
static report.

- Source: `--input` if given, otherwise the newest run found through `getRun(configPath)`.
  A missing run is an error (exit 2).
- Output: `<dir>/index.html` plus `<dir>/report.json` (the validated run, unchanged). The directory
  is created if needed; existing files with these two names are overwritten, nothing else is touched.
- `index.html` is one self-contained file: inline CSS, no `<script>`, no remote fonts, images or
  stylesheets, and a `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`.
  It supports light and dark themes through `prefers-color-scheme`.
- Content: decision and execution banner, run id and times, gate table, URL audit table, findings,
  bounded output for BLOCK gates, evidence paths as plain text. Every value from the run is
  HTML-escaped (reports and tool output are data). Output tails are capped like the Markdown report.
- Exit codes: 0 on success, 2 on any failure. The exported run's own verdict is printed, not returned.
- Privacy: the report contains command output and file paths. It is written locally only; uploading it
  to Pages, S3 or a CI artifact is the user's choice. Docs say so.

## Tunnel read-only mode and token (T-029)

`dashboard --tunnel cloudflare|ngrok` (in `packages/dashboard`, run as `pnpm dashboard --tunnel ...`).

- Spawns the user's installed binary: `cloudflared tunnel --url http://127.0.0.1:<port>` or
  `ngrok http 127.0.0.1:<port> --log stdout --log-format logfmt`. Nothing is downloaded or installed.
  If the binary is missing (`ENOENT`) the command exits 2 with a clear message naming the binary.
  If no public URL appears within 30 s the tunnel is stopped and the command exits 2.
- The public URL is parsed from the tool's output (`https://...trycloudflare.com`, ngrok `url=`),
  and printed as `<public-url>/?token=<token>`.
- Read-only mode is forced whenever a tunnel is used: the server answers only `GET` of the UI assets,
  `/api/project` and `/api/run`. `POST /api/run` and `/api/cancel` return 405, so a visitor can never
  start a run, and the UI hides the run button (`readOnly: true` in `/api/project`, additive).
- Token: 32 random bytes (base64url) generated per start. A request with `?token=` equal to it
  (constant-time compare) receives an `HttpOnly; SameSite=Strict; Secure` cookie and a redirect to the
  same path without the token; all other requests need that cookie, otherwise 401. The token is never
  logged beyond the printed URL and dies with the process.
- Host check: the public tunnel host is added to the accepted hosts only after the tunnel reports it.
- Warning printed before the URL: logs, findings, file paths and evidence are visible to anyone with
  the link; tunnels are not an authenticated multi-user service; stop with Ctrl+C.
- Lifecycle: the tunnel child is killed on SIGINT/SIGTERM, when the dashboard closes, and when the
  child exits unexpectedly (the dashboard then exits 2).
- Tests fake `spawn`; no tunnel binary is needed.

## Commit status and comment permissions (T-030, T-031)

- Commit status (T-030): `POST /repos/{o}/{r}/statuses/{sha}` with state `success` (PASS), `failure`
  (BLOCK) or `error` (execution error/interrupted), context `qualitygate`, `target_url` = report link
  (HTTPS). Token scope: `statuses: write` (GitHub Actions `permissions: statuses: write`). A check run
  needs `checks: write` and is deferred. Same trusted-job rules as the description publisher:
  explicit `--write`, no fork PRs, head SHA must equal the PR head, otherwise skip with a reason.
- Sticky comment (T-031): an alternative to editing the description. One comment per PR identified by a
  hidden marker `<!-- qualitygate:comment -->`; update it if found, otherwise create it. Needs
  `pull-requests: write` (GitHub), `api` note scope (GitLab), `pullrequest:write` (Bitbucket). Stale-head
  and closed-PR guards are identical to the description publisher.
- Both are separate commands run from a trusted publisher job that holds the token; target-code jobs
  never see it.

## Slack payload (T-032)

- Webhook URL from an environment variable (default `QUALITYGATE_SLACK_WEBHOOK`), HTTPS only,
  no credentials or fragment in the URL; the URL is never printed.
- Sent only for BLOCK or error runs (PASS is silent unless `--always`).
- Payload (`application/json`): `{ "text": "QualityGate BLOCK: 2 of 5 gates failed", "blocks": [ header,
  section with the failing gate ids and top findings (file:line, message, capped at 10), context with
  run id and a link button to the report ] }`. All text is Slack-escaped (`&`, `<`, `>`) and capped at
  3000 characters per block.
- Failure to deliver is reported on stderr and exits 2 only for the notify command itself; it never
  changes the gate verdict.
