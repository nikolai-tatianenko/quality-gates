# @qualitygate/dashboard

Local React interface over the same QualityGate service used by MCP. It displays
the configured checks, latest verdict, structured findings, failure output and
saved report path. Run/cancel use the existing execution and cleanup lifecycle.

From the monorepo root:

```sh
pnpm build
pnpm dashboard --config /absolute/path/to/project/.qualitygate.yml --port 4173
```

Open **http://127.0.0.1:4173**. Use the exact address; the server validates Host.
It binds only to 127.0.0.1, has no CORS access and requires a matching Origin and
custom header for mutations. A dashboard instance is tied to one selected config;
the HTTP API accepts no commands, filesystem paths or replacement configuration.
It supports one active run and explicit cancellation. SIGINT/SIGTERM drains active
execution and evidence writes before shutdown.

Configuration and commands are trusted local code, **not sandboxed**. This is not
an authenticated multi-user service: do not expose it through a reverse proxy,
network tunnel or public interface. Configured gates keep their existing machine
permissions. Project changes are made in your editor, then checked again here.
