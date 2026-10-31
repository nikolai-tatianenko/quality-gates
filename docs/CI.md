# CI reports and managed PR/MR descriptions

QualityGate runs the same project configuration on GitHub Actions, GitLab CI and
Bitbucket Pipelines. The CI exit code enforces the gate; JSON, Markdown and raw
files remain downloadable artifacts even when a gate blocks.

CI invokes the CLI directly; it does not host the local dashboard or require
Portless. The templates set `HUSKY=0` during installation. Local hooks and CI can
share the same gate configuration; see [project installation and Husky setup](PROJECT_SETUP.md).

## Install in a target repository

The package is not published to npm yet. Build a tarball from the local QualityGate
checkout with `pnpm build`, `mkdir -p /tmp/qualitygate-packages` and
`pnpm pack --pack-destination /tmp/qualitygate-packages`.
For CI, copy that tarball into the target repository and install the repository-local
path, rather than an absolute path under `/tmp`:

```sh
mkdir -p tools
cp /tmp/qualitygate-packages/qualitygate-prototype-0.1.0.tgz tools/
pnpm add -D ./tools/qualitygate-prototype-0.1.0.tgz
```

Commit the tarball, package manifest, pnpm lockfile and `.qualitygate.yml` to your
own repository. Review the archive before sharing it. Pin your package manager
in `package.json`; the GitHub example reads `packageManager`. This repository is
still local-only in this development session: these instructions do not publish it.
Node 22.23.4+ is required. Projects supply their own lint/typecheck/test commands;
use non-watch commands in CI. Chrome/Ruff/SonarScanner are separate prerequisites
only when the selected configuration requires them. The supplied Node container
images do not include Chrome, Ruff or a SonarQube server.

For configurations with `reviewSources`, commit `qualitygate.sources.lock.json`
and add `pnpm exec qualitygate sources restore` after dependency installation and
before the gates. This restores the reviewed revisions on a fresh runner. CI
should not run `sources sync` automatically and activate new upstream instructions.

## Copy a pipeline template

| Platform | Example to copy | Destination |
| --- | --- | --- |
| GitHub Actions | [github-actions.yml](../examples/ci/github-actions.yml) | `.github/workflows/qualitygate.yml` |
| GitLab CI | [gitlab-ci.yml](../examples/ci/gitlab-ci.yml) | `.gitlab-ci.yml` or a local include |
| Bitbucket Cloud | [bitbucket-pipelines.yml](../examples/ci/bitbucket-pipelines.yml) | `bitbucket-pipelines.yml` |

Merge these with existing jobs/stages rather than overwriting your pipeline.
Add `.qualitygate/` and `.qualitygate-ci/` to the target repository's `.gitignore`.
All templates preserve the `run` exit code and upload `.qualitygate-ci/result.json`,
`.qualitygate-ci/report.md` and `.qualitygate/` evidence on failure. A configuration
or startup error may produce only the CLI error JSON; it is retained but cannot be
published as a completed run. The GitHub template also appends the Markdown report
to the job summary and publishes same-repository PR descriptions using a separate
job. It does not publish on fork PRs, and does not trigger on description edits.

GitLab/Bitbucket templates perform checks and upload reports. Configure their
publisher separately in a **trusted** job/pipeline with the commands below; they do
not silently enable PR-write credentials in a target-code job. For GitLab this can
be a protected downstream project/pipeline. For Bitbucket use a controlled publisher
pipeline/deployment with repository permissions. Choose a mechanism supported by
your account/plan; no downstream project, webhook or deployment is provisioned here.

## Render a detailed report

```sh
pnpm exec qualitygate run --json > result.json
# Run this even when run returned BLOCK/error; keep the original exit code in CI.
pnpm exec qualitygate report --input result.json --output report.md
```

`report` returns zero when rendering succeeds, regardless of the gate verdict.
It never changes a PR. The report includes gate/audit decisions, execution status,
exit codes, timings, scores, findings with locations/rules, bounded output and
paths to raw evidence. Run errors are headed ERROR/INTERRUPTED, even if individual
quality metrics passed. Markdown summaries are bounded (60 KB locally, 16 KB in a
PR); the complete JSON and raw evidence remain in CI artifacts. Tool-provided text
is escaped to prevent marker/HTML injection and literal mentions.

## Preview and update a description

```sh
pnpm exec qualitygate pr \
  --provider github --repository owner/repo --number 42 \
  --head <exact-source-commit-sha> --input result.json
```

Default mode reads the PR and prints the proposed description, without writing.
Add `--write --json` in the trusted publisher to apply it. JSON output reports
`changed`, `write`, and a reason. `stale-head`, `closed`, `older-run` and `unchanged`
are non-writing outcomes, not publication failures. Network, validation, permission
and malformed-marker errors exit 2. No PR publishing tools are exposed through MCP.

| Provider | Repository argument | Number | Default token variable | API default |
| --- | --- | --- | --- | --- |
| `github` | `owner/repo` | PR number | `GITHUB_TOKEN` | `https://api.github.com` |
| `gitlab` | numeric project ID or `group/subgroup/project` | MR IID | `GITLAB_TOKEN` | `https://gitlab.com/api/v4` |
| `bitbucket` | `workspace/repo_slug` | PR ID | `BITBUCKET_TOKEN` | `https://api.bitbucket.org/2.0` |

`--token-env NAME` selects another environment variable; never pass token contents
as a command argument. Tokens must authorize reading and updating the selected
PR/MR. GitHub Actions needs `pull-requests: write`; GitLab commonly uses a scoped
project access token with the required API permissions. Bitbucket supports a
Bearer OAuth/repository access token with pull-request read/write permissions;
email/API-token Basic authentication is not implemented by this adapter.
`--api-url` supports custom GitHub/GitLab API roots using HTTPS. HTTP is allowed only
on loopback for local testing. Bitbucket Data Center has a different API and is not
supported by this first adapter.

Typical trusted publisher commands:

```sh
# GitLab: source SHA must match the analyzed revision. CI_COMMIT_SHA is suitable
# for a detached MR pipeline; a merged-results pipeline has a different commit.
pnpm exec qualitygate pr --provider gitlab --repository "$CI_PROJECT_ID" \
  --number "$CI_MERGE_REQUEST_IID" --head "$REVIEWED_SOURCE_SHA" \
  --input result.json --write --json

# Bitbucket Cloud: carry the original source SHA from the check job into the publisher.
pnpm exec qualitygate pr --provider bitbucket --repository "$BITBUCKET_REPO_FULL_NAME" \
  --number "$BITBUCKET_PR_ID" --head "$REVIEWED_SOURCE_SHA" \
  --input result.json --write --json
```

Carry the repository, PR ID, source SHA and artifact identity through trusted CI
metadata; do not accept routing or credentials from the JSON report. A publisher
must run a trusted, reviewed QualityGate package, never one supplied by the PR.
The GitHub example checks out the trusted base revision for this reason; that base
must already contain the installed CLI and lockfile. Preserve that boundary when
adapting it. Keep write tokens out of check jobs and untrusted fork pipelines.

## Manual and automatic sections

On the first publication, a description without QualityGate tags is treated as
handwritten content in its entirety and moved into the manual section. For example:

```markdown
## Manual description
<!-- qualitygate:manual:start -->
The author's existing description stays here.
<!-- qualitygate:manual:end -->

<!-- qualitygate:auto:start -->
<!-- qualitygate:metadata {"head":"...","finishedAt":"...","runId":"..."} -->
## QualityGate: BLOCK
...generated report...
<!-- qualitygate:auto:end -->
```

Subsequent runs replace only the automatic block. Manual content, including edits
made after a previous run, remains intact. Text outside an already managed block
is preserved too. Deleting/editing generated text is temporary; the next report
regenerates it. Removing all tags makes the entire current description handwritten
again. Malformed, duplicated or overlapping tags, an unclosed Markdown fence or a
result exceeding 32 KB abort publication; handwritten text is never truncated.
Markers in fenced code examples are treated as ordinary text.

The generated block displays the reviewed source SHA. Each update checks the current PR head against `--head`, skips closed PRs and
refuses older report timestamps for the same head. Before writing it reads the
current description again and rebases on intervening edits (up to three attempts).
Serialize publishers per PR: GitHub `concurrency`, GitLab `resource_group` or an
appropriate Bitbucket publisher lock. The APIs offer no portable atomic
compare-and-swap for descriptions: an edit between the last read and write can
still race. The adapter does not provide a cross-provider transactional guarantee.
The source SHA is supplied by CI; the run JSON itself is not cryptographically
bound to a source tree. Timestamps are a freshness guard, not an authenticity proof.

## Verification and API references

`pnpm verify:ci-templates` parses all three templates and executes their report
shell blocks against a fixture CLI, checking preservation of exits 0/1/2/130 and
renderer failures. It also checks the GitHub publication trust boundary. This
verification runs in the repository CI; no external pipeline is triggered locally.

Local tests cover migration, repeated replacement, manual edits, fenced markers,
stale commits, older runs, write denial, bounded responses, escaping and concurrent
edits. Provider contracts use fixture responses; CLI publishing is exercised against
a localhost HTTP server. No live GitHub/GitLab/Bitbucket description has been changed
or remote CI pipeline run during this implementation.

Official contracts: [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls),
[GitLab merge requests](https://docs.gitlab.com/api/merge_requests/),
[Bitbucket Cloud pull requests](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).
