# @qualitygate/dashboard

Local React interface over the same QualityGate service used by MCP. It displays
the configured checks, latest verdict, structured findings, failure output and
saved report path. Run/cancel use the existing execution and cleanup lifecycle.

The interface uses a shadcn-inspired neutral dashboard layout: an inset content
surface, icon navigation, compact cards, outline actions and semantic CSS tokens
such as `background`, `foreground`, `card`, `primary`, `muted` and `border`.
The React/CSS/SVG components are implemented locally; the visual conventions follow
the [shadcn/ui theming guide](https://ui.shadcn.com/docs/theming).
Four overview cards show the actual verdict, configured check count, findings and
elapsed time between the saved run's start/finish timestamps. Section links jump
to checks and evidence; no synthetic analytics are displayed.

From the monorepo root:

```sh
pnpm build
pnpm dev:ui --config /absolute/path/to/project/.qualitygate.yml
```

Open **http://qualitygate.localhost:1355**. A dedicated Vercel Portless 0.12.0
proxy and the dynamically allocated backend both bind to 127.0.0.1. The wrapper
uses the public Portless proxy API and creates no global daemon, hosts entries or
certificates. If port 1355 is occupied, use `PORTLESS_PORT=1356 pnpm dev:ui`.
The pin retains Node 22 support; current newer Portless releases require Node 24.

Direct fallback, without named-host routing:

```sh
pnpm dashboard --config /absolute/path/to/project/.qualitygate.yml --port 4173
# http://127.0.0.1:4173
```

The standalone CLI reads `PORT` and the optional `PORTLESS_URL`; an explicit
`--port` overrides `PORT`. A public origin must be a named `.localhost` HTTP(S)
origin. Only its exact Host (or the loopback backend Host for proxy rewriting)
is accepted; POST still requires that exact public Origin and the custom request
header. Forwarded headers never establish trust. `pnpm smoke:portless` verifies
the named URL in Chrome, valid mutations, CSRF denial and proxy shutdown.
See [project setup](../../docs/PROJECT_SETUP.md#5-open-this-projects-local-dashboard).

The header offers **Light**, **Dark** and **Auto** appearance modes. Auto follows
the operating system, including changes while the dashboard is open. The choice
is stored in this browser's local storage for the dashboard origin; no project
configuration is changed. If storage is blocked, switching still works for the
current session. A small external bootstrap applies the preference before CSS
loads, within the existing Content Security Policy.

Both modes cover the navigation, check table, findings, output and status colors.
Execution errors/interruption appear as the latest status instead of a green PASS.
The mobile layout supports 320px-wide screens, collapsing long commands into
expandable details. `pnpm smoke:dashboard` verifies theme persistence, live OS
changes, selected text contrast (at least 4.5:1), mobile overflow and the real
Python BLOCK → fix → PASS workflow in Chrome. Screenshots are saved under
`.qualitygate/dashboard-smoke/`.

It binds only to 127.0.0.1, has no CORS access and requires a matching Origin and
custom header for mutations. A dashboard instance is tied to one selected config;
the HTTP API accepts no commands, filesystem paths or replacement configuration.
It supports one active run and explicit cancellation. SIGINT/SIGTERM drains active
execution and evidence writes before shutdown.

Configuration and commands are trusted local code, **not sandboxed**. This is not
an authenticated multi-user service: do not expose it through a public proxy
or public interface. The only supported way to share it is the read-only tunnel below. Configured gates keep their existing machine
permissions. Project changes are made in your editor, then checked again here.

## Share through a tunnel (read-only)

```sh
pnpm dashboard --tunnel cloudflare   # runs your installed `cloudflared tunnel --url`
pnpm dashboard --tunnel ngrok        # runs your installed `ngrok http`
```

QualityGate never downloads these tools; if the binary is missing the command exits 2.
It prints `Share: https://.../?token=<random token>`. Tunnel mode is always **read-only**:
`POST /api/run` and `/api/cancel` answer 405 and the run button is hidden. Every request
needs the random per-start token (it becomes an HttpOnly cookie and is stripped from the
address bar). **Anyone with the link can read logs, findings, file paths and evidence**
of the project; send it only to people you trust. Ctrl+C (or the tunnel dying) closes the
tunnel and the dashboard. For a static copy with no live server use `qualitygate export`.

## Team view

Below the overview cards the dashboard shows what a team needs, all derived from `history.sqlite` and the latest stored run
(`GET /api/team`; the bridge serves the same JSON at `GET /v1/team` behind its pairing token):

- **Summary for leads**: current decision and exit code, what changed since the previous run (regressions, new failures,
  fixed, slower), top 3 risks (regressions, blocking, flaky, often failing, slower), gates that block, median time to green.
- **Trends**: runs per week with the blocked share, run duration, time to green (inline SVG, blocked bars hatched so colour is
  not the only signal), most frequently failing and flaky gates.
- **Run history**: table of recorded runs, newest first, with the gates that started to block.
- **Engineer view**: each blocking gate with `file:line` findings and a copyable `qualitygate run --gate <id>` command.
- **Export**: copy or download the summary as Markdown for stand-ups and PR descriptions.

Gate output (`outputTail`), raw reports and evidence paths are never read by this view, so a secret scanner's output cannot
appear in it or in the Markdown. Verdicts are copied from the stored run, never recomputed. Keyboard: every control is a
native button, link or `details`; the history table scrolls in a focusable region. Charts have text names and the table holds
the same numbers. The web page is served by `pnpm dashboard`, not by the bridge; the bridge exposes the data to other clients.
Verified in real Chrome by `pnpm smoke:dashboard` (desktop and 320px layouts, no overflow, copy by keyboard). Clipboard
success depends on the browser; failure is announced and the Markdown preview can be selected by hand. A screen reader pass
and Safari/Firefox were not tested.
