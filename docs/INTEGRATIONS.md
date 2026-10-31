# Agent clients and local models

All integrations use the same runner and saved report schema. The MCP service
exposes `list_gates`, `run_gates`, `get_run`; calls never accept arbitrary shell
commands or replacement project paths. Gates are trusted code, not sandboxed.

## Editor / agent clients

```sh
node dist/qualitygate.mjs connect --client claude --config /project/.qualitygate.yml
node dist/qualitygate.mjs connect --client cursor --config /project/.qualitygate.yml
node dist/qualitygate.mjs connect --client codex --config /project/.qualitygate.yml
```

The command **prints** a native configuration snippet with absolute executable and
argument paths; merge it into your settings yourself. It never overwrites files.
`--json` returns `{schemaVersion,client,filename,format,content}`.

| Client | Configuration envelope |
| --- | --- |
| `claude`, `claude-code` | `.mcp.json`, `mcpServers` |
| `claude-desktop` | `claude_desktop_config.json`, `mcpServers` |
| `cursor` | `.cursor/mcp.json`, `mcpServers` |
| `codex` | `.codex/config.toml`, `mcp_servers.qualitygate` |
| `vscode` | `.vscode/mcp.json`, `servers` with `type: stdio` |
| `generic` | Standard `mcpServers` JSON snippet for compatible clients |

Claude Code has a real recorded BLOCK → fix → PASS session in `docs/demo/`.
Other snippets have automated format tests; this session does not claim live
editor interaction tests for every listed client. Codex project configuration
may require project trust. Startup timeout is 20 seconds, tool timeout 600 seconds.

MCP cancellation stops an active command process group and persists an interrupted
run. Disconnect drains execution/evidence writes. Concurrent runs on one service
are rejected; read-only tools remain available. Separate server processes are
independent and must not be assumed to provide a global lock across clients.

References: [Claude Code](https://code.claude.com/docs/en/mcp),
[Cursor](https://cursor.com/docs/mcp), [Codex](https://developers.openai.com/codex/mcp).

## Ollama, vLLM and compatible endpoints

```sh
node dist/qualitygate.mjs ask --provider ollama --model YOUR_TOOL_CAPABLE_MODEL \
  --prompt "Run the gates and explain the findings" --config /project/.qualitygate.yml

node dist/qualitygate.mjs ask --provider vllm --model YOUR_TOOL_CAPABLE_MODEL \
  --base-url http://127.0.0.1:8000/v1 --prompt "Check this project" \
  --config /project/.qualitygate.yml --json

node dist/qualitygate.mjs ask --provider openai-compatible --model YOUR_MODEL \
  --base-url http://127.0.0.1:1234/v1 --prompt "Check this project" \
  --config /project/.qualitygate.yml
```

The Ollama adapter uses `/api/chat`; vLLM and compatible endpoints use
`/chat/completions`. Use a model with tool-calling support. For vLLM this can require
`--enable-auto-tool-choice`, a model-specific `--tool-call-parser` and appropriate
chat template. Merely accepting chat messages does not establish tool compatibility.

For authentication, pass `--api-key-env NAME_OF_ENV_VAR`; values are never embedded
in URLs or stored by the CLI. Only the selected endpoint receives prompts and
invoked tool results. Defaults point to localhost. URL credentials and redirects
are rejected. Limits: 1 MB per model response, 16 tool calls per response, 8 turns
by default (`--max-turns`), 120 seconds per request (`--timeout-ms`).

The adapter connects through actual stdio MCP. Its final process exit code comes
from the validated gate run, even if the model's prose falsely says PASS. No verified
run means an error. A later failed/invalid run invalidates an earlier success.
It can inspect and run declared checks; it has no file-editing or arbitrary-shell
tool. The editor agent performs source fixes outside this bounded model adapter.

HTTP contracts and tool roundtrips are tested with local scripted endpoints for all
three adapters. No Ollama model was installed, and no live vLLM inference server
was available during this session; live model inference remains unverified.

References: [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling),
[vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/).
