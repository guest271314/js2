---
id: 2816
title: CLI default output dir should be the cwd, not next to the input
status: done
sprint: 69
priority: medium
area: cli
related: [389]
completed: 2026-06-29
assignee: ttraenkler/agent-dev
---

## Problem

`src/cli.ts` defaulted the output directory to the **input file's directory**
when `-o`/`--out` was omitted:

```ts
const name = basename(absInput, ".ts");
const dir = outDir ? resolve(outDir) : dirname(absInput);
```

Two footguns followed:

1. **Artifacts dumped into `node_modules`.** The examples ship *inside* the
   installed package (`node_modules/@loopdive/js2/examples/...`). Compiling one
   without `-o` wrote `.wasm`/`.wat`/`.d.ts`/`.imports.js`/`.wit` straight into
   `node_modules` — exactly what the loopdive/js2#389 reporter hit.
2. **Double extension for non-`.ts` inputs.** `basename(absInput, ".ts")` only
   strips `.ts`, so a `.js` input yielded `nm_deno.js.wasm`.

## Fix

- Default `dir` to `process.cwd()` (overridable with `-o <dir>`).
- Strip the full source extension from the output name:
  `basename(absInput).replace(/\.(ts|mts|cts|js|mjs|cjs)$/i, "")` so
  `nm_deno.js` → `nm_deno.wasm`.
- Updated the `-o` help text in `src/cli.ts` and the `-o` section of
  `docs/cli.md` (default is now the cwd).
- Removed the now-unused `dirname` import.

## Blast-radius audit

`git grep` of CLI invocations (`cli.ts`/`cli.js`, `js2wasm`,
`build-standalone-cli`) across `scripts/`, `.github/`, `playground/`,
`package.json`, `docs/` found **no production callers** that compile without
`-o` expecting output beside the input. The only affected callers were test
files. Tests that read emitted artifacts back from the input directory or that
would otherwise pollute the repo root now pass an explicit `-o <tmpdir>`:

- `tests/issue-1043.test.ts` (2 invocations) — read `dir/input.wat`
- `tests/issue-1751.test.ts` — read `dir/native-messaging-host.wit`
- `tests/issue-1590-cli-run-hint.test.ts`
- `tests/issue-2520-host-import-warning-verbosity.test.ts`
- `tests/issue-1554-cli-flag-exclusion.test.ts`
- `tests/issue-2783.test.ts`

(`tests/issue-1950`, `tests/issue-2603`, `tests/issue-2736` already passed `-o`.)

## Verify

- `js2wasm <file>.ts` with no `-o` writes `<name>.wasm` into the cwd.
- A `node_modules/...` input writes to the cwd, not into `node_modules`.
- `nm_deno.js` → `nm_deno.wasm` (no double extension).
- `-o <dir>` still overrides.
- CLI tests pass.
