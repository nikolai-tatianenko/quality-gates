# Prototype verification — 2026-10-27

Environment: macOS, Node 22.19.0, pnpm 11.5.1, Lighthouse 12.8.2,
Chrome 156 (host user agent recorded in raw evidence).

## Checks

- `pnpm check`: lint, strict typecheck, 13 tests and bundled CLI/worker build pass.
- `pnpm verify:clean`: fresh temporary workspace, frozen-lockfile pnpm install,
  all 13 tests, lint, typecheck and build pass.
- `pnpm smoke`: real Chrome against the local fixture; JSON output parses against
  the protocol schema and matches the persisted report.
- `pnpm verify:package`: builds and packs locally, installs the tarball with npm in
  an isolated temporary directory, checks the executable and init command, then
  runs the real Chrome smoke suite using the installed CLI and worker.

## Observed workflow

| Scenario | Exit | Result |
| --- | --- | --- |
| Two valid local URLs, all thresholds zero | 0 | PASS, separate scores and raw evidence |
| Same fixture, SEO threshold 100 | 1 | BLOCK |
| Valid URL followed by an inaccessible URL | 2 | Both results retained; audit error takes precedence over BLOCK |
| Missing Chrome | 2 | Explicit browser error, summary saved |
| Hanging navigation with a 2.5-second timeout | 2 | Timeout recorded, Chrome cleaned |
| SIGINT during hanging navigation | 130 | Interrupted summary; next URL skipped; Chrome cleaned |
| Output path occupied by a regular file | 2 | Storage error; completed audit still returned in JSON |
| Invalid config | 2 | Versioned JSON error envelope |

The smoke suite records owned Chrome PIDs during each CLI run and checks that they
no longer exist after exit. Raw Lighthouse JSON and the summary are preserved in
`.qualitygate/smoke-*`; every run has a unique ID.

Unit/integration coverage additionally verifies incompatible plugin versions,
duplicate registration, independent custom audit plugins, required missing metrics,
identical saved scores under passing/blocking thresholds, exclusive config creation,
unknown CLI arguments, an executable with a nonexistent interpreter, cleanup errors,
real atomic-report rename failure, interruption during report writing, and simultaneous
audit/evidence errors. Scores are rounded to integer percentages to avoid floating
point boundary errors such as 0.58 becoming 57.99999999999999.

The GitHub Actions workflow has been updated and its YAML parsed locally. It was
not executed on GitHub: this work intentionally has no push, PR or publication.
The ISC license, legacy CLI entrypoint and existing uncommitted user materials remain.
