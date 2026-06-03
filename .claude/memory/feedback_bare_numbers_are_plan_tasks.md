# Bare Number References

When the user refers to a bare number like `1742`, treat it as a local plan
issue/task under `plan/issues/` by default. Only look it up as a GitHub issue
when the user explicitly says "GitHub issue"; only look it up as a PR when the
user explicitly says "PR" or "pull request".
