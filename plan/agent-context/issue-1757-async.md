# #1757 — async compile() API migration (context for review/resume)

**Status: implementation COMPLETE, CI GREEN, held DRAFT pending user/tech-lead review.**
Do NOT enqueue yet — user wants to review this 769-file breaking public-API change
deliberately, and the merge queue is being stabilized (auto-enqueue disabled).

## Coordinates
- **Branch:** `issue-1757-async-compile-v2` (pushed to origin)
- **PR:** #992 — `feat(#1757): migrate compile() API to async (embed binaryen, GH #986)`, base `main`, **DRAFT**
- **Worktree:** `/workspace/.claude/worktrees/agent-a205e81d02cf3a15a`
- **Head SHA:** `7d90670a0393c13199851f62797b2f101602fc24` (already merged with origin/main incl. #1730)
- **Issue file:** `plan/issues/1757-async-compile-api-migration.md` (status: done — set in the impl PR per self-merge convention; flip back to in-review if review stalls)

## CI state (on head SHA 7d90670a0) — ALL GREEN
- `cheap gate (main-ancestor + lint)`: pass
- `quality`: pass
- `equivalence-gate`: pass
- `merge shard reports`: pass (PR-level stub; the real 50-shard test262 regression gate runs in the merge_group/queue)
- `cla-check`: pass
- 115 test262 shards: all pass
- Total: 133 pass, 1 skipping, 0 failures

## What it does (4 impl commits + 2 merges)
Makes the public compile pipeline async so the optional Binaryen optimizer loads via
`await import("binaryen")` and can be embedded in a `bun build --compile` / `deno compile`
standalone binary (binaryen has a top-level await a sync require can't load — the #986 root cause).
- **Phase 1 source:** `compileSource`/`compileMultiSource`/`compileFilesSource` async; `index.ts`
  public wrappers (`compile`/`compileMulti`/`compileFiles`/`compileToWat`/`compileProject`/
  `createIncrementalCompiler().compile`) async; `runtime.ts`/`runtime-instantiate.ts`/`cli.ts` +
  the 3 test262/compiler workers await. New synchronous `compileSourceSync` core (no wasm-opt)
  for the inherently-synchronous `eval` host shim (`runtime-eval.ts`).
- **Phase 2 codemod:** ts-morph AST codemod over `tests/**/*.ts` — 2142 awaits, 1189 fns async,
  769 files. `(await call)` wrapping for member-access precedence; fixpoint propagation through
  named helpers (incl. `Promise<T>` return-type rewrite). Codemod kept at
  `.tmp/codemod-async-compile.mjs` (gitignored) — re-runnable/idempotent.
- **Phase 3 embed:** fixed residual sync `require("binaryen")` in `optimizeWithBinaryenPackage`
  to use `process.getBuiltinModule("node:module")` -> `createRequire` so bundlers don't statically
  follow it (the real bundling blocker). README + CHANGELOG breaking note.
- Same codemod over playground/scripts/benchmarks consumers.

## Validation done
- `tsc --noEmit` whole project: 0 errors after every stage (incl. post-merge).
- Full `npm test` on this branch vs a clean `origin/main` checkout: **identical failure profile —
  118 failing cases across the same 14 files** (all pre-existing on main). Zero regressions.
- Bundling with binaryen NOT externalized: errored before the fix, 13.8 MB embedded bundle after.
- `compile(..., {optimize:3})` end-to-end loads binaryen via `await import`, optimizes, runs.

## How to enqueue LATER (after review approval + queue re-enabled)
1. In the worktree, re-merge to be current: `git fetch origin && git merge origin/main --no-edit`.
   If origin/main added/changed any `tests/**/*.ts`, re-run the codemod (idempotent):
   `node .tmp/codemod-async-compile.mjs 'tests/**/*.ts'` then `tsc --noEmit`. Push.
2. Wait for CI green on the new SHA.
3. Mark ready: `gh pr ready 992`.
4. Enqueue via GraphQL (NOT `gh pr merge --auto`, NOT `--admin`):
   `PRID=$(gh pr view 992 --json id -q .id); gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' -f id="$PRID"`
   then verify it appears in the queue. The merge_group run does the authoritative 50-shard test262 gate.

## Review-risk read
Codemod risk LOW (AST-based, idempotent, zero-regression-verified, tsc-clean). The reviewable
surface is small — the source change is `src/compiler.ts`/`src/index.ts`/`src/optimize.ts` +
~9 caller sites; the 769 test files are mechanical `await` insertions.
