# QualityGate

QualityGate runs your project's existing checks and gives developers, CI and AI agents
one **PASS / BLOCK decision**, actionable findings and saved evidence.

**Local-first · CLI + MCP + React dashboard · TypeScript / JavaScript / Python · MIT**

[Quickstart](#try-it-locally) · [Install in your project](#add-to-an-existing-project) ·
[CI](#run-in-ci) · [Husky](#attach-to-git-with-husky) · [Agents](#connect-an-agent) ·
[Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFICATION.md)

![Claude Code receives BLOCK, reads the failed check, fixes the code and gets PASS](docs/demo/qualitygate-claude-code.gif)

**[Watch the 75-second demo](docs/demo/qualitygate-claude-code.mp4)** ·
[Real session transcript](docs/demo/session.json) · [Reproduce the agent loop](examples/agent-fix/)

A recorded Claude Code session, replayed with pauses for readability. The agent
uses QualityGate over MCP, fixes an implementation error and reruns the same checks;
tests and policy stay unchanged.

## Why QualityGate?

Lint, tests and scanners already do useful work. Their commands, thresholds,
exit codes and reports are often spread across scripts, CI jobs and agent prompts.
QualityGate puts the **decision and its evidence** behind one project-owned contract.

- **One configuration:** run the same declared checks locally, in hooks, in CI and through MCP.
- **A reason to act on:** file, line, rule and message when the tool provides structured output.
- **Evidence you can inspect:** keep raw reports and logs alongside the normalized run result.
- **Honest failures:** a failed tool, missing metric or failed report write cannot become a successful CI exit.

The feedback loop is simple: **check → read the cause → fix → check again**.
QualityGate is useful when that loop needs to work consistently across several tools
and interfaces. Your existing tools remain responsible for their own analyses.

## How it works

```mermaid
flowchart LR
    Config[".qualitygate.yml"] --> Runner["QualityGate runner<br/>policy + lifecycle"]
    CLI["CLI / Git hooks / CI"] --> Runner
    Agent["AI agent via MCP"] --> Runner
    UI["Local React dashboard"] --> Runner
    Runner --> Tools["Project commands<br/>ESLint · Ruff · tests<br/>Lighthouse · SonarQube"]
    Tools --> Result["PASS / BLOCK<br/>+ execution status"]
    Result --> Evidence["report.json<br/>raw reports + logs"]
    Evidence --> Feedback["Developer / agent feedback<br/>CI status / PR report"]
```

Checks run sequentially. Execution status and policy decision are separate; errors
have their own exit code and preserve earlier results. Interfaces share the runner
and run schema. See [package boundaries and lifecycle](docs/ARCHITECTURE.md).

## The dashboard

A local workspace for running/cancelling checks, inspecting findings and downloading
the run JSON. The neutral, shadcn-inspired interface supports **Light / Dark / Auto**,
saved browser preferences and mobile layouts.

![QualityGate dark dashboard with a real Python lint finding, gate results and saved evidence](docs/screenshots/dashboard-dark.png)

<details>
<summary>Light theme and mobile screenshots</summary>

![QualityGate light dashboard](docs/screenshots/dashboard-light.png)

<img src="docs/screenshots/dashboard-mobile.png" width="320" alt="QualityGate mobile dashboard in dark mode">

</details>

These are real Chrome captures of the local Python fixture. An unused import causes
BLOCK; removing it produces PASS. The overview cards show actual run data, not
synthetic charts. [Dashboard setup and verification](packages/dashboard/README.md).

## Try it locally

From a checkout of this source, use **Node 22.23.4+** and **pnpm 11.5.1**. The baseline
is pinned in [.nvmrc](.nvmrc) and [package.json](package.json).

```sh
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
uv tool install ruff==0.9.2
pnpm build
pnpm dev:ui
```

Open **http://qualitygate.localhost:1355** and click **Run quality gates** to check
this repository's lint, types, complexity and test coverage. CLI equivalent:

```sh
node dist/qualitygate.mjs run
```

Ruff is needed for this repository's Python adapter/self-tests; another project's
command-only configuration does not require it. Use another Node manager or
[official Ruff installation method](https://docs.astral.sh/ruff/installation/) if
you do not use nvm/uv. Chrome is needed only for URL audits/browser verification.

The UI uses **Vercel Portless 0.12.0**, pinned for Node 22 compatibility. Its proxy
and backend bind to loopback, with a stable named URL and an automatically allocated
backend port. No certificate installation or hosts-file edits are performed.
If port 1355 is occupied, use `PORTLESS_PORT=1356 pnpm dev:ui`. Direct fallback:

```sh
pnpm dashboard --port 4173
# http://127.0.0.1:4173
```

[Portless details, supported arguments and shutdown behavior](docs/PROJECT_SETUP.md#5-open-this-projects-local-dashboard).

## Add to an existing project

The CLI is **not published to npm yet**. Build a local tarball in the QualityGate checkout:

```sh
pnpm build
mkdir -p /tmp/qualitygate-packages
pnpm pack --pack-destination /tmp/qualitygate-packages
```

Then, in the project you want to check:

```sh
mkdir -p tools
cp /tmp/qualitygate-packages/qualitygate-prototype-0.1.0.tgz tools/
pnpm add -D ./tools/qualitygate-prototype-0.1.0.tgz
```

Keep the archive repository-relative so CI can install it. Commit it with the target
manifest/lockfile. Create `.qualitygate.yml` using your project's **actual scripts**:

```yaml
schemaVersion: 1
gates:
  - id: lint
    run: pnpm run lint
  - id: typecheck
    run: pnpm run typecheck
  - id: tests
    run: pnpm run test:ci
    timeoutMs: 300000
outputDir: .qualitygate
```

Or let QualityGate write that file from your `package.json` scripts (`lint`, `typecheck`
/ `type-check`, `test:ci` / `test`), pick pnpm/yarn/npm from `packageManager` or the lockfile,
and add its output folders to `.gitignore`. It never overwrites an existing config:

```sh
pnpm exec qualitygate setup
# without installing first, from a tarball:
npx -p ./tools/qualitygate-prototype-0.1.0.tgz qualitygate setup
```

Use a terminating test command rather than watch mode. Add `.qualitygate/` and
`.qualitygate-ci/` to `.gitignore`, then run:

```sh
pnpm exec qualitygate run
pnpm exec qualitygate run --gate lint --gate typecheck
pnpm exec qualitygate run --json
```

Commands resolve relative to the config file. The packaged CLI does not impose
this source checkout's package manager on consumers. To view another project,
run this from the QualityGate checkout:

```sh
pnpm dev:ui --config /absolute/path/to/project/.qualitygate.yml
```

The dashboard runs from this monorepo; the CLI tarball does not include its server/assets.
[Complete installation guide](docs/PROJECT_SETUP.md) · [Python project example](examples/python-project/).

## Run in CI

**Yes: run the CLI as a normal CI check.** The dashboard and Portless are local
interfaces; no dashboard server is needed to enforce gates in CI.

```sh
HUSKY=0 pnpm install --frozen-lockfile
pnpm exec qualitygate run --json
```

| Platform | Copyable template | Reporting |
| --- | --- | --- |
| GitHub Actions | [Workflow](examples/ci/github-actions.yml) | JSON/evidence artifacts, job summary, separate trusted PR publisher |
| GitLab CI | [Pipeline](examples/ci/gitlab-ci.yml) | JSON/Markdown/evidence artifacts; configure a trusted MR publisher separately |
| Bitbucket Cloud | [Pipeline](examples/ci/bitbucket-pipelines.yml) | JSON/Markdown/evidence artifacts; configure a trusted PR publisher separately |

The templates preserve the gate exit code while saving failure evidence. The report
includes decisions, timings, findings and bounded command output. The PR/MR adapter
preserves handwritten text and replaces only its marked automatic section on reruns;
it checks the current source SHA and skips older runs for that head.

API writes require an explicit `--write` command in a trusted publisher. Keep its
credentials out of target-code jobs. Live provider setup and concurrency limits are
explained in [CI and PR/MR reporting](docs/CI.md). Browser smoke tests can run in CI;
that is different from deploying the local dashboard as a public service.

## Attach to Git with Husky

**Yes: Husky can invoke QualityGate before commits and pushes.** Install Husky in
the target project, then add the gate commands to its hooks:

```sh
pnpm add -D husky@9.1.7
pnpm exec husky init
```

For `.husky/pre-commit`:

```sh
pnpm exec qualitygate run --gate lint --gate typecheck
```

For `.husky/pre-push`:

```sh
pnpm exec qualitygate run
```

Preserve existing hook/prepare-script work when integrating. These commands check
the **working tree**, including unstaged changes. A nonzero result blocks the Git
operation. Hooks are bypassable; CI remains the independent enforcement point.
Set `HUSKY=0` during CI installation and use non-watch test commands.

[Copyable hook files](examples/hooks/README.md) · [Safe setup and troubleshooting](docs/PROJECT_SETUP.md#3-attach-husky-hooks).

## Connect an agent

From a target project with the CLI installed:

```sh
pnpm exec qualitygate connect --client claude --config .qualitygate.yml
```

Merge the printed configuration into the client's settings. The command does not
overwrite them. The client launches a **stdio MCP** process; the dashboard URL is
not an MCP endpoint. Claude Code, Cursor, Codex, VS Code and generic config formats
are supported. [Client setup and local-model adapters](docs/INTEGRATIONS.md).

| MCP tool | Purpose |
| --- | --- |
| `list_gates` | Read configured gate IDs, commands, URLs and thresholds |
| `run_gates` | Run all or selected gates and return the actual verdict/findings |
| `get_run` | Inspect a saved run or the latest result |
| `get_review_methodology` | Read a configured methodology at its pinned Git commit |

Ask the editor agent: **"Run QualityGate. If it blocks, read the findings, fix the
implementation, and run it again. Keep tests and policy unchanged."**

MCP only exposes the selected project configuration. The bounded `ask` model adapter
can inspect/run gates, but has no editing or shell tools; source fixes belong to the
editor agent. Live-model/editor verification limits are listed below.

## Checks you can combine

| Input | What QualityGate records |
| --- | --- |
| Existing project commands | Exit code, timeout/execution status and command logs |
| ESLint JSON | File, line, rule, severity and message, with raw report evidence |
| TS/JS analysis | ESLint/SonarJS complexity and code smells through the reusable analyzer |
| Python analysis/tests | Ruff findings and your declared Python test commands |
| Lighthouse | Performance, accessibility, SEO and best-practices scores on a 0–100 scale |
| SonarQube | The quality gate for the specific scanner analysis, not an old project result |
| Agent review producer | Normalized confirmed/unresolved/rejected findings with methodology provenance |

For URL audits, `qualitygate init <URL> --config web-qualitygate.yml` creates explicit
thresholds without overwriting a file. Missing required metrics block the result.
Start the target app separately before auditing its URL. Command gates and audits
can share a configuration.

For external review methodologies, `sources sync` explicitly updates the lock,
`sources restore` fetches frozen revisions, and `get_review_methodology` reads
local pinned content. Loading Cloudflare's skill
is not a completed audit: a capable review producer and the methodology's required
isolation/verification are separate work. See [SonarQube and security review](docs/SECURITY_REVIEW.md).

[Standalone analyzer](packages/code-analysis/README.md) · [Project-specific rule overrides](docs/CODE_QUALITY.md).

## Results and exit codes

A run saves `.qualitygate/<run-id>/report.json`, raw audit/JSON reports and command
logs. CLI text is readable; `--json` is machine-readable. Reports retain earlier
results when a later check fails. Saving a report is atomic; storage failure remains
an error and cannot guarantee a saved artifact.

| Exit | Meaning |
| --- | --- |
| `0` | Completed, PASS |
| `1` | Completed, BLOCK |
| `2` | Configuration, execution, cleanup or storage error |
| `130` | Interrupted |

Execution errors take precedence over a policy BLOCK. Commands and URLs execute
sequentially; cancellation stops owned processes. [Lifecycle details](docs/ARCHITECTURE.md).

## How it fits alongside existing tools

| Tool | Main role |
| --- | --- |
| [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md) | Lighthouse collection, assertions, report upload/history |
| [SonarQube](https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates) | Code analysis and quality gates for its analysis metrics |
| QualityGate | Orchestration and a shared verdict/evidence contract across existing tools, local workflows, CI and agents |

QualityGate complements these tools. It does not reproduce SonarQube's analysis
platform or Lighthouse CI's history service. Its focus is making a project's existing
quality policy available to people and agents through the same execution path.

## Technology stack

| Area | Technology | Purpose |
| --- | --- | --- |
| Runtime | Node.js 22.23.4 baseline | CLI, service, MCP and dashboard backend |
| Language | TypeScript 5.9.3 | Strict contracts and implementation |
| Workspace | pnpm 11.5.1 | Monorepo, frozen installs and dependency policy |
| Frontend | React / React DOM 19.2.0, CSS/SVG | Local dashboard with semantic theme tokens |
| Local routing | Vercel Portless 0.12.0 | Named `.localhost` URL, loopback proxy |
| Build | esbuild 0.25.10, tsx 4.20.6 | Bundles and source execution |
| Validation | Zod 3.25.76, YAML 2.8.1 | Versioned config/results |
| TS/JS analysis | ESLint 9.37.0, typescript-eslint 8.46.1, SonarJS 4.2.2 | Lint, complexity and code smells |
| Python | External Ruff 0.9.2 and project test commands | Python analysis and checks |
| Browser audits | Lighthouse 13.5.0, chrome-launcher 1.0.0 | Real Chrome audits |
| Agent protocol | MCP SDK 1.32.1 | Stdio tool interface |
| Models | Ollama / vLLM / compatible HTTP adapters | Bounded tool calling; live inference experimental |
| Tests | node:test, jsdom 26.1.0, React act | Unit/integration/UI behavior |
| Coverage | c8 10.1.3 / V8 | Enforced runtime coverage, HTML/JSON/LCOV |
| Browser verification | Puppeteer Core 24.43.1 + Chrome | Real UI and execution workflows |
| Git hooks | Optional target-project Husky 9.1.7 | Pre-commit / pre-push integration |
| CI | GitHub Actions / GitLab CI / Bitbucket Pipelines templates | Native gate exits and report artifacts |
| Evidence | Filesystem + JSON | Per-run reports, logs and raw tool output |

Source installs enforce pinned pnpm and a **seven-day minimum registry release age**,
without age exclusions. These are supply-chain controls, not a malware scan.
[Toolchain setup](CONTRIBUTING.md) · [Workspace](pnpm-workspace.yaml) · [Lockfile](pnpm-lock.yaml).

## Verification and current limits

**Working developer preview.** Verification is local evidence, not a claim that every
provider, OS or deployment has been tested.

| Area | Evidence / boundary |
| --- | --- |
| CLI and packaging | Local tarball installation and exit-contract tests |
| Browser execution | Real Chrome PASS/BLOCK, timeout, cancellation and cleanup checks |
| Dashboard | Light/dark/system behavior, mobile layouts and selected contrast checks in Chrome |
| Portless | Named-origin HTTP routing, CSRF checks, real browser execution and proxy shutdown |
| Git hooks | Real Husky in a disposable Git fixture; blocked/passing commits and local dry-run pushes |
| Agents | Recorded Claude Code demo; generated configs and model adapters have contract tests |
| Still unverified | Live Cursor/Codex sessions, live Ollama/vLLM inference, live SonarQube and all provider deployments |
| Still to build | Complete Cloudflare audit harness/sandbox, exact source-tree binding, richer history/diff policies |

The repository checks itself with the same gate configuration. Runtime coverage
includes the CLI, core, plugins, services, adapters and dashboard TS/TSX; the only
explicit exclusion is the interfaces-only SDK file. CSS/layout are verified in the
browser, outside V8 coverage. No native Windows support claim is made.

```sh
pnpm check                    # Lint, types, complexity, enforced coverage and build
pnpm verify:ci-templates      # YAML + exit/status/publication-boundary checks
pnpm smoke:dashboard          # Real React/Python BLOCK → fix → PASS + theme checks
pnpm smoke:portless           # Named URL + real Chrome + strict origin checks
pnpm verify:hooks             # Real Husky fixtures; no changes to your checkout's hooks
pnpm smoke                    # Real Lighthouse/Chrome lifecycle scenarios
pnpm verify:package           # Local CLI tarball install + browser smoke
pnpm verify:analysis-package  # Independent analyzer tarball
```

[Verification records](docs/VERIFICATION.md) · [Environment matrix](docs/ENVIRONMENTS.md) ·
[Roadmap](TODO.md) · [Product vision](VISION.md).

## Security, contribution and license

**Gate commands are trusted code and are not sandboxed.** They inherit local
permissions and environment. The dashboard has no authentication and is intended
for loopback access; do not expose it as a public service. Raw evidence may contain
project data. [Execution boundary and private reporting](SECURITY.md).

Contributions should preserve explicit policy, versioned results, visible errors
and cleanup guarantees. [Contributing](CONTRIBUTING.md).

QualityGate is [MIT licensed](LICENSE). The original service remains archived under
[`legacy/lighthouse-v1/`](legacy/lighthouse-v1/) with its ISC license and separate
dependencies; it is excluded from the maintained workspace.
