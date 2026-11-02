# Check packages/ci before claiming an integration gap

`packages/ci` already updates PR/MR descriptions (GitHub, GitLab, Bitbucket) and the GitHub
template writes the job summary (see docs/CI.md). A gap assessment made from memory said
"no PR integration"; the real gaps are commit status, sticky comment, Slack, sharing (T-028..T-033).
Read `docs/CI.md` and `packages/ci/src` before listing missing integrations.
