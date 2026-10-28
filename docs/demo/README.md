# Claude Code MCP demo

The 75-second GIF and MP4 are paced replays of the real Claude Code session in
`session.json`. They are not screen captures of Claude Code's interactive TUI.
Only actual tool calls, returned results, source reads and edits are used.
The original run took about 13 seconds; replay pauses make each step readable.
Absolute local repository paths are replaced by `<repo>` in the published transcript.
System messages, thinking and authentication data are not exported.

The session demonstrates:

1. Claude Code calls QualityGate `run_gates` through MCP and receives BLOCK.
2. The returned failure explains that shipping was subtracted: 95 rather than 105.
3. Claude reads source/tests and edits `subtotal - shipping` to `subtotal + shipping`.
4. The same MCP tool returns PASS. The recorder verifies tests/config were unchanged.

From the repository root:

```sh
pnpm build
node scripts/demo/record.mjs  # Requires your own configured Claude Code access
node scripts/demo/render.mjs # Requires ffmpeg and a monospace font
```

The recorder runs only the copied fixture in `.qualitygate/demo/workspace` and leaves
`examples/agent-fix/` intentionally broken. Raw events stay under the ignored
`.qualitygate/demo/` directory. The renderer chooses Menlo on macOS or DejaVu Sans
Mono on Linux; set `QUALITYGATE_DEMO_FONT` to another installed monospace font.
Media rendering does not invoke an AI model or manufacture tool results.
