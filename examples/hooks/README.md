# QualityGate + Husky

Install the CLI into your target project and define the actual lint/typecheck/test
scripts first; follow [project setup](../../docs/PROJECT_SETUP.md).

- `.qualitygate.yml` declares the three example gate IDs.
- `pre-commit` runs only lint and typecheck.
- `pre-push` runs the full configuration.

For a new Husky setup, install `husky@9.1.7` and run `pnpm exec husky init`.
Copy/merge the hook commands into `.husky/pre-commit` and `.husky/pre-push`.
Preserve any existing hook and prepare-script work; do not blindly overwrite it.
Checks operate on the working tree. Configure non-watch commands, ignore generated
`.qualitygate/` reports, and set `HUSKY=0` during CI dependency installation.
The required enforcement belongs in CI because local hooks can be bypassed.
