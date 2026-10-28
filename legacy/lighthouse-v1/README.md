# Archived Lighthouse v1

The maintained CLI lives in `packages/cli`. This directory preserves the original
CommonJS implementation for historical reference under its original ISC license.
It is excluded from the pnpm workspace and the distributed CLI package.

To reproduce the old behavior, install dependencies inside this directory with
`npm install`, create `output/`, then run `npm start -- https://example.com`.
These dependencies are old and this service is unmaintained: audit/write errors
can be suppressed and Chrome is only closed on successful audits.
Use the root QualityGate CLI for normal work.
