# Code style and quality policy

QualityGate has explicit repository defaults. A target project owns its own policy;
it does not have to adopt QualityGate's lint rules or coverage thresholds.

| Requirement | Current configuration | Enforcement |
| --- | --- | --- |
| Type safety | `tsconfig.json` | Strict TypeScript, unchecked index access |
| Basic lint | `eslint.config.mjs` | Recommended TypeScript rules, unused variables |
| Complexity / smells | `packages/code-analysis/src/index.ts` | Cyclomatic/cognitive complexity 15, nesting 4, 80 function lines, 4 parameters and selected SonarJS rules |
| Python checks | `packages/code-analysis/src/python.ts` | Ruff lint, complexity and excessive branches/arguments/statements |
| Runtime test coverage | `.c8rc.json` | 100% statements/lines/functions, 95% branches |
| Checks to execute | `.qualitygate.yml` | Commands, gate types, timeouts and report directory |
| Web thresholds | Project `.qualitygate.yml` | Explicit category minimums, missing scores BLOCK |

There is no complete formatter policy yet: indentation, quote style and line wraps
are not all enforced by Prettier or an equivalent configuration. The analyzer's
fixed complexity defaults are also not yet a shared, overridable JSON policy.

## Use the target project's own ESLint rules

Create `eslint.config.mjs` in that project, for example:

```js
export default [{
  files: ['src/**/*.js'],
  rules: {
    complexity: ['error', 10],
    'max-depth': ['error', 3],
    'max-params': ['error', 4],
  },
}];
```

Then run the project's own executable/configuration through QualityGate:

```yaml
schemaVersion: 1
gates:
  - id: project-lint
    type: eslint
    run: pnpm exec eslint src --format json
  - id: project-tests
    run: pnpm test
```

For TS/React, use that project's TypeScript ESLint parser/plugins too. The gate
parses JSON findings but the project decides the rules and tool versions. For
Python, a command gate such as `ruff check . --config pyproject.toml` likewise
uses that project's rules; a command gate retains output and exit status.

For explicit preset composition, the analyzer package also exports its `rules`
object. A project ESLint config can spread it and override selected entries, such
as `rules: { ...qualitygateRules, complexity: ['error', 10] }`. That config must
register the TypeScript parser and SonarJS plugin used by the preset; run it through
the project's ESLint gate. The standalone analyzer CLI does not load that config.

The standalone `qualitygate-analyze` command deliberately uses its fixed policy,
ignoring executable ESLint project config and using Ruff `--isolated`. Using it
does not automatically merge the project's own lint configuration. This distinction
keeps the chosen policy explicit. Gate commands and project configs remain trusted
local code, not a sandbox.
