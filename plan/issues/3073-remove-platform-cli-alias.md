---
id: 3073
title: remove deprecated --platform CLI alias (#2736 follow-up)
status: done
sprint: 71
priority: medium
horizon: s
assignee: ttraenkler/agent-dev
completed: 2026-07-06
---

# remove deprecated `--platform` CLI alias (#2736 follow-up)

## Problem

`--platform` was introduced in #2736 as a DEPRECATED alias for the unified
`--target {web,node,deno}` host axis, printing a one-line deprecation warning
and feeding the internal `platform` field. The project lead wants the alias
spelling removed now that `--target` is the supported spelling.

## Scope

Remove the js2wasm CLI `--platform` flag alias only. The INTERNAL host-scoping
mechanism (`platform` variable + `...(platform ? { platform } : {})` spread and
the `--target {web,node,deno}` handling that feeds it) is untouched — only the
`--platform` alias spelling is gone.

### Removed (`src/cli.ts`)

- The `--platform <p>` help-text block.
- The `--platform` / `--platform=` argument-parsing branch (incl. its
  deprecation-warning `console.error`). `--platform` now falls through to the
  CLI's `Unknown option` handler (non-zero exit).
- Stale comments describing `--platform` as a live/deprecated alias — reworded
  to describe only `--target {web,node,deno}` as the host-axis flag.

### Kept

- `let platform: "web" | "node" | "deno" | undefined;` and the
  `...(platform ? { platform } : {})` spread — the internal host-scoping field.
- `--target {web,node,deno}` handling that routes host values into `platform`.

Unrelated esbuild `--platform=node` bundler flags (package.json,
scripts/\*) are left untouched.

## Test

`tests/issue-2736-target-axis.test.ts` — the `--target node/deno/web` and
unknown-`--target` tests pass unchanged; the former `--platform node`
deprecation test now asserts `--platform` is REJECTED as an unknown flag
(non-zero exit / `Unknown option: --platform`), mirroring
`tests/issue-2783.test.ts`.
