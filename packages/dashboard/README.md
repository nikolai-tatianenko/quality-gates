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
an authenticated multi-user service: do not expose it through a public proxy,
network tunnel or public interface. Configured gates keep their existing machine
permissions. Project changes are made in your editor, then checked again here.
