# Current package boundaries

```mermaid
flowchart TD
  UI[React dashboard] --> HTTP[Local HTTP API]
  HTTP --> Service[QualityGate service]
  Agents[Claude / Cursor / Codex] --> MCP[MCP stdio server]
  Models[Ollama / vLLM / compatible runtime] --> Bridge[Model client]
  Bridge --> MCP
  MCP --> Service
  CLI[CLI run] --> Runner[Config loader + runner]
  Service --> Runner
  Runner --> Core[Core lifecycle]
  Core --> Gates[Command / JSON report gates]
  Gates --> Analyzer[code-analysis package]
  Analyzer --> TS[ESLint + SonarJS]
  Analyzer --> Python[Ruff]
  Core --> Lighthouse[Lighthouse worker + owned Chrome]
  Core --> Policy[Threshold policy]
  Core --> Evidence[JSON reporter + filesystem storage]
```

- **protocol / plugin-sdk:** versioned Zod data and TypeScript plugin contracts.
- **core / policy:** sequential execution, cleanup stack, partial results and
  deterministic decisions. Execution error and quality BLOCK remain distinct.
- **plugins:** trusted tool execution, report parsing and durable evidence.
- **service:** shared list/run/inspect behavior; one active mutation per instance,
  cancellation and disconnect drain. CLI calls the runner directly.
- **code-analysis:** independently installable API/CLI; fixed TS/JS and Python
  analysis policy. It needs no QualityGate core to scan another project. A gate
  wraps its ESLint-compatible output to attach run IDs and evidence paths.
- **dashboard:** React renders server results. The loopback HTTP server fixes the
  project config at startup and delegates runs to the same service as MCP.
- **integrations / model-client:** client configuration emitters and bounded
  tool-calling adapters; model prose cannot override a validated gate verdict.

The repository's `.qualitygate.yml` invokes lint, typecheck, the analysis package
and coverage tests. `verify:project` adds a local documentation URL to that same
policy for a complete command-gates + Lighthouse self-check.

There is no remote account, upload service, untrusted plugin sandbox or global
cross-process scheduling lock. Each run owns its processes and UUID evidence
directory. Commands remain trusted local code; see [SECURITY](../SECURITY.md).
