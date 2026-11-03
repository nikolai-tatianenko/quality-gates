# Resuming a stopped workflow leaves partial work in the tree

A workflow stopped mid-stage (usage limit) left that stage's changes uncommitted. Resuming re-ran the
stage against the leftovers and finished it; completed stages replayed from cache. Check
`git status` and the journal before resuming. Also: parallel sessions append to TODO.md and can
reuse task ids; renumber duplicates after a long run (second section is now T-051..T-066).
