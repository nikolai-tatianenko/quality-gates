# Python project checked by QualityGate

Install Ruff 0.9.2 and build the monorepo first:

```sh
uv tool install ruff==0.9.2
pnpm build
node dist/qualitygate.mjs run --config examples/python-project/.qualitygate.yml
pnpm dashboard --config examples/python-project/.qualitygate.yml
```

The first gate runs the code-analysis package's Python adapter, the second runs
the project's real `unittest` suite. Both should PASS. Add `import os` to the top
of `calculator.py` to produce BLOCK with an `F401` finding, filename, line and raw
evidence. Remove it and rerun to restore PASS. A function with more than 15 McCabe
decision paths also produces a `C901` complexity finding.

`type: eslint` selects the shared ESLint-compatible report parser; the command
itself uses Ruff for Python. This does not invoke ESLint on Python source files.
