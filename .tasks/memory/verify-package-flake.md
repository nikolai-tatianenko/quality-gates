# verify:package can fail once, then pass

`pnpm verify:release` failed at `verify:package` ("pass: invalid run result", empty stdout from
the first real-Chrome audit) when the laptop slept mid-run (step durations ~30 min instead
of ~1 min). Re-running `pnpm verify:package` alone passed in ~60 s with unchanged code, and
the full release check then passed. Same symptom was seen earlier with `pnpm smoke`.
Re-run once on a clean, awake machine before treating it as a regression, and never chain
`git commit`/`push` after it with `;` — use `&&`.
