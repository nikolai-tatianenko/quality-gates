# Local Node for pnpm commands

The shell default here is Node 22.19.0, but `engines` requires >=22.23.4, so every
`pnpm` command (and `npm view`) aborts with "Your Node version is incompatible".
Put the pinned version first on PATH: `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH`.
README already documents the Node floor; check docs before filing a "missing docs" finding.

`npm view` inside this repo fails with EBADDEVENGINES (devEngines pins pnpm); run npm registry
lookups from a neutral directory. The 7-day `minimumReleaseAge` also blocks the newest
release (e.g. lighthouse 13.6.0): pick the newest eligible version, never override the policy.
