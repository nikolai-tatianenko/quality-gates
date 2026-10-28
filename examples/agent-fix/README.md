# Claude Code + QualityGate demo

This project deliberately has one failing test: shipping is subtracted rather than
added to the subtotal. It is excluded from the root test command. No npm install,
Chrome or third-party test runner is needed for this fixture.

From the repository root, build QualityGate and run the real Claude Code recording:

```sh
corepack pnpm build
node scripts/demo/record.mjs
```

Requires an installed, configured Claude Code CLI. The recorder copies these files
to `.qualitygate/demo/workspace`, so the published broken fixture is never edited.
It starts QualityGate's MCP server bound to that copy. Claude Code can read/edit
the copied source and invoke the MCP tools; it has no shell tool in this session.
The prompt requires a first BLOCK, an implementation fix without changing the test
or config, and a second MCP run that returns PASS. The script verifies that sequence.
Raw session data stays in the ignored `.qualitygate/demo/`; only selected text,
tool calls and tool results are exported to `docs/demo/session.json`.

The README animation/video are a rendered replay of that actual session with pacing
adjusted for readability, not a recording of the interactive Claude Code TUI.
