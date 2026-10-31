# @qualitygate/code-analysis

Local code complexity and code smell analysis for TypeScript/JavaScript and Python.
This workspace package has a reusable `analyze()` API and a `qualitygate-analyze`
CLI. It scans the supplied project; QualityGate also uses it to analyze itself.
It does not implement a new parser or claim to replace SonarQube.

```sh
pnpm --filter @qualitygate/code-analysis build
node packages/code-analysis/dist/cli.mjs 'packages/**/*.{ts,tsx}'
node packages/code-analysis/dist/cli.mjs --language python /path/to/python/project
node packages/code-analysis/dist/cli.mjs --language python /path/to/project --json
```

After a local tarball install, use `qualitygate-analyze` instead of `node …/cli.mjs`.
Exit codes: 0 PASS, 1 findings/BLOCK, 2 execution or input error. `--json` emits an
ESLint-compatible JSON array on stdout for either language; errors go to stderr.
Python inputs are file/directory paths, not shell-expanded glob expressions.

```ts
import { analyze } from '@qualitygate/code-analysis';
const result = await analyze({ cwd: '/path/to/project', patterns: ['src/**/*.ts'] });
// result: {schemaVersion, decision, findings, results}
const python = await analyze({ cwd: '/path/to/project', language: 'python' });
```

Each finding includes file, location when available, rule, severity and message.
`results` retains the underlying ESLint-compatible report. Parsing or execution
errors reject the API promise; they must not be treated as PASS.

## Rules

| Language | Engine | Checks |
| --- | --- | --- |
| TS/JS | ESLint + SonarJS | Cyclomatic complexity ≤15, cognitive complexity ≤15, block nesting ≤4, functions ≤80 nonblank/noncomment lines, parameters ≤4, identical functions, duplicated branches, redundant boolean conditions, collapsible conditionals |
| Python | Ruff | McCabe complexity ≤15 (`C901`), excessive branches/arguments/statements (`PLR0912`, `PLR0913`, `PLR0915`), Pyflakes (`F`), selected syntax/import errors (`E4`, `E7`, `E9`) |

Python requires a Ruff executable on PATH (tested with **0.9.2**). Install a pinned
version with `uv tool install ruff==0.9.2` or `python3 -m pip install ruff==0.9.2`.
The API accepts `ruffPath` and an AbortSignal. Ruff runs without a shell, with a
30-second timeout and a 1 MB output limit. The tool does not install dependencies,
execute scanned Python files, modify code or apply fixes. Repository configs are
ignored to keep the selected policy explicit (`--isolated` for Ruff; fixed ESLint
configuration). In-source lint suppression comments still apply.

This is static analysis, not a sandbox or a proof of correctness. It does not yet
measure cross-file copy/paste duplication, test coverage of the supplied project,
or dependency vulnerabilities. Use the project's own test/coverage gates too.

References: [ESLint complexity](https://eslint.org/docs/latest/rules/complexity),
[SonarJS ESLint plugin](https://github.com/SonarSource/SonarJS/blob/master/packages/jsts/src/rules/README.md),
[Ruff C901](https://docs.astral.sh/ruff/rules/complex-structure/).
