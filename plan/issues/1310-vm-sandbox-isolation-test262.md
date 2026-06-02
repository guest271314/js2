---
id: 1310
title: "vm.createContext sandbox isolation for test262 global contamination"
status: done
created: 2026-05-07
updated: 2026-06-02
completed: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test-infra
area: runtime, tests
language_feature: vm-sandbox, test262
goal: test262-conformance
sprint: 50
related: [1160]
---
# #1310 — vm.createContext sandbox isolation for test262 global contamination

## Background

Some test262 tests mutate JS built-ins via the `__extern_set` host import
(e.g. `Array.prototype.push = brokenFn`). `resolveImport` in
`src/runtime.ts` resolves `declared_global` intents at `buildImports`
call time via `(globalThis as any)[intent.name]`. Once test A clobbers
`Array.prototype.push`, test B's subsequent `buildImports` captures the
already-mutated `Array`, and B's downstream code then exhibits a
spurious failure that has nothing to do with B itself.

This is documented in the `_safeSet` comment in `src/runtime.ts`
(near line 882, "#1160 follow-up"). The proposed remediation is to
thread a `globalSandbox` (a fresh `vm.createContext`) through
`buildImports` so test-A's mutations land on a sandbox that the runner
discards before running test B.

## Implementation

### `src/runtime.ts`

- Added optional `globalSandbox?: Record<string, any>` parameter to
  `resolveImport`. The `declared_global` and `globalThis` cases now
  resolve against `globalSandbox ?? globalThis` so when the caller
  supplies a sandbox the resolved built-ins point into the sandbox copy.
- Added `globalSandbox` to `buildImports`'s `options` object and threaded
  it through to `resolveImport`.

Behaviour without `globalSandbox` is unchanged — falls through to the
real host `globalThis`.

### `tests/test262-runner.ts`

- Imported `createContext` and `runInContext` from `node:vm`.
- Added a `getTestSandbox()` helper that maintains a shared sandbox
  per shard worker, with a sentinel-keyed dirty check after each test:
  if any tracked built-in (`Array.prototype.push`,
  `Object.prototype.hasOwnProperty`, `Function.prototype.call`,
  `String.prototype.slice`, `Promise.prototype.then`) has been replaced,
  the sandbox is rebuilt with a fresh `createContext` so the next test
  starts from clean built-ins.
- The sandbox is built by `createContext(emptyObject)` then populated
  by pulling each well-known built-in name out of the realm via
  `runInContext("Array", ctx)` etc. — `vm.createContext({})` does not
  expose realm built-ins as properties on the host object directly,
  so the architect's original sketch (`_sandbox.Array`) wouldn't have
  worked without this materialization step.
- Both `buildImports(...)` call sites in `runTest262File` now do
  `getTestSandbox()` immediately before, so the dirty check catches
  pollution from the previous test, and pass the sandbox via
  `{ globalSandbox }`.

## Test Results

`tests/issue-1310.test.ts` — 6/6 PASS:
- sandbox-resolved `Array` is the sandbox's `Array`, not host's.
- without `globalSandbox`, falls through to host `globalThis`.
- `globalThis` intent resolves to the sandbox object.
- `getTestSandbox()` returns the same sandbox when no built-in mutated.
- replaces the sandbox when `Array.prototype.push` is rebound.
- subsequent calls return the new sandbox until another mutation.

`tests/issue-1298.test.ts` — 9/9 active PASS (2 skipped, unrelated).

`npx tsc --noEmit` — no new TypeScript errors.

Pre-existing equivalence-test infra failures (helpers.js missing on
two test files) reproduce on `origin/main` before this change.

## Files

- `src/runtime.ts` — `resolveImport` (extra param + sandbox-aware
  resolution), `buildImports` (options + threading).
- `tests/test262-runner.ts` — sandbox manager + import + both
  `buildImports` call sites updated.
- `tests/issue-1310.test.ts` — 6 new tests covering the contract.

## Why this matters

Without sandbox isolation, a single test that mutates built-ins
poisons every subsequent test in the shard, producing flaky
"regression" signals on PRs that touch unrelated code. With #1310
landed, the test262 runner becomes deterministic with respect to
prototype mutation tests, and the existing `__extern_set`-related
"#1160 follow-up" gap noted in `runtime.ts` is closed.

## Follow-up: sharded worker + standalone lane coverage (2026-06-02)

The original implementation only covered the `runTest262File` path in
`tests/test262-runner.ts`. The 57-shard host+standalone CI rollout exposed
that the full sharded path uses `scripts/test262-worker.mjs` directly, so its
`buildImports(...)` calls were still unsandboxed. Both matrix targets share
that worker; standalone usually has no host imports, but any import-backed
standalone execution should use the same dirty-check guard as JS-host.

Follow-up changes:

- Added the VM sandbox manager to `scripts/test262-worker.mjs` and threaded it
  through all worker `buildImports(...)` calls.
- Applied the same sandbox to the rare in-process fixture branch in
  `tests/test262-shared.ts`.
- Applied the same guard to the legacy `scripts/wasm-exec-worker.mjs` executor.
- Expanded sentinels beyond the original minimal set to cover Array iterator
  methods, RegExp methods, and `Uint8Array` methods seen in the catastrophic
  prototype-poisoning cluster.

Verification:

- `node --check scripts/test262-worker.mjs`
- `node --check scripts/wasm-exec-worker.mjs`
- `pnpm exec prettier --check scripts/test262-worker.mjs scripts/wasm-exec-worker.mjs tests/test262-runner.ts tests/test262-shared.ts`
- `pnpm exec tsc --noEmit --pretty false`
- `pnpm exec vitest run tests/issue-1310.test.ts --reporter=dot`
- `TEST262_TARGET=standalone ... TEST262_PATH_FILTER='language/comments/hashbang/statement-block.js' ... tests/test262-chunk1.test.ts` — 1/1 pass
- `TEST262_TARGET=gc ... TEST262_PATH_FILTER='language/comments/hashbang/statement-block.js' ... tests/test262-chunk1.test.ts` — 1/1 pass
