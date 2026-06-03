---
id: 1789
title: "standalone/WASI module-level const/let initializers never run before exported functions → TDZ trap on any module-const object access"
status: done
created: 2026-06-03
updated: 2026-06-03
completed: 2026-06-03
priority: high
feasibility: hard
task_type: bugfix
area: codegen, standalone
language_feature: module-code, to-primitive, declarations
goal: standalone-mode
sprint: 58
claimed_by: sd-1665
claimed_at: 2026-06-03
related: [907, 1525, 1525b, 1472, 1759]
---
# #1788 — Standalone module-init runs only via `_start`, so module-const object access from an export traps

## Problem (root cause of the #1781 "876-row ToPrimitive" bucket)

Carved from the #1781 standalone root-cause map's 876-row
"ToPrimitive / object-to-string dispatch residuals" bucket. Investigation
(sd-1665, 2026-06-03) shows that bucket is **not** an OrdinaryToPrimitive
dispatch bug — the valueOf/toString trampoline is emitted correctly natively.
The real defect is **module-initialization ordering under `--target wasi`**.

### Repro

```ts
const o = { valueOf() { return 42; } };
export function test(): number { return (o as any) * 1; }
```

`--target wasi` compiles to an import-free module but **traps at runtime**
(`WebAssembly.Exception`) when `test()` is invoked directly. The emitted
`$test` is:

```wat
(func $test (result f64)
  global.get 3        ;; $__tdz_o  (TDZ guard for `const o`)
  i32.eqz
  (if (then ref.null extern  throw 0))   ;; throw "accessed before init"
  global.get 1        ;; $__mod_o
  call 29             ;; $__anon_0_valueOf  ← correctly emitted, never reached
  f64.const 1  f64.mul  return)
```

`$__module_init` builds the object, stores `$__mod_o`, and sets
`$__tdz_o = 1` — but it is wired **only** into the `_start` export, with **no
Wasm `(start)` section** in WASI mode (deliberately, to avoid double-init —
`src/codegen/declarations.ts:3984` skips `startFuncIdx` when `ctx.wasi`).

The test262 harness (and `WebAssembly.instantiate(bytes, {})`) calls the
exported `test()` **without first calling `_start`**, so `__module_init`
never runs, `$__tdz_o` stays 0, and any read of a non-constant-foldable
module-level `const`/`let` (objects, refs, anything behind a TDZ global)
throws. Plain foldable consts (`const k = 7`) are unaffected because they're
inlined and never read the global.

This is why the bucket's dominant runtime signature is
`Cannot convert object to primitive value` / opaque traps: the binding is
never initialized, so the value the trampoline would coerce doesn't exist.

## Why WASI skips the start section today (#907)

`(start)` runs once at instantiation before any export — exactly ES module
semantics. #907 adopted it for non-WASI (`!ctx.wasi`). WASI was excluded
because `addWasiStartExport` (`src/codegen/index.ts:1429`) makes `_start`
call `__module_init`, and a `(start)` PLUS a `_start`-driven init would run
init twice.

## Fix

Use the Wasm `(start)` section for `__module_init` in WASI mode **as well**,
and make the `_start` wrapper **not** re-call `__module_init` (since `(start)`
already ran it at instantiation). `_start` keeps its WASI-entry role
(microtask drain, proc_exit wiring) but is no longer the init driver.

- `src/codegen/declarations.ts:3984` — set `ctx.mod.startFuncIdx = initFuncIdx`
  unconditionally (drop the `if (!ctx.wasi)` guard), OR set it for WASI and
  adjust `_start`.
- `src/codegen/index.ts:1429` `addWasiStartExport` — when a `(start)` section
  already runs `__module_init`, the `_start` body should NOT call
  `__module_init` again; it should call only the drain helper (and remain a
  valid `() -> ()` WASI entry). When there is genuinely no module init (no
  start section), keep the current behavior.
- Watch the `main`-present branch (declarations.ts ~3940): there `__module_init`
  body is spliced into `main` rather than emitted standalone — that path must
  stay correct (no start section needed when init is inside `main`/`_start`
  proper). Only the "no main()" branch (3955+) needs the start section.

## Acceptance criteria

1. The repro above compiles `--target wasi` and `test()` returns `42` when
   invoked directly (no `_start` call).
2. `const o = { toString() { return "hi"; } }; \`${o}\`` returns `"hi"`.
3. Module init runs exactly once (no double-init): a top-level side effect
   (e.g. incrementing a module-level counter) is observed once after
   instantiation, and once more is NOT added by calling `_start`.
4. No regression: existing WASI `_start` programs (stdout/main-style) still
   run their top-level code exactly once.
5. Non-WASI `--target gc`/standalone behavior unchanged.

## Files

- `src/codegen/declarations.ts` (~3955-3990: the "no main()" module-init /
  start-section branch).
- `src/codegen/index.ts` (`addWasiStartExport`, ~1429).
- New `tests/issue-1788-standalone-module-init.test.ts`.

## Notes

This resolves the bulk of the #1781 876-row "ToPrimitive/object-to-string"
bucket because that bucket is gated on module-const object init, not on the
coercion path. #1525b (host-mode trampoline) is already merged (PR #871) and
is orthogonal. Coordinate with sd-1472 (#1472 object runtime) only if the
`_start`/init split touches the open-object init sequence — it should not
(this is purely the start-section wiring, not the object model).

## Attempt 1 (sd-1665, 2026-06-03) — blanket `(start)` for WASI REGRESSES

Tried the obvious fix: set `ctx.mod.startFuncIdx = __module_init` for WASI too
and make `_start` skip re-calling init. **Result: the target repro works**
(`(o as any)*1` returns 42; no double-init — verified a top-level counter runs
exactly once whether or not `_start` is called). BUT it **regresses 14 WASI
stdout tests** in `tests/wasi.test.ts`.

Root of the regression: `__module_init` lumps together TWO kinds of top-level
work:
  1. **Binding initialization** (allocate `const o`'s struct, set its TDZ
     guard global) — must run before ANY export reads the binding.
  2. **Observable top-level side effects** (`console.log(...)`,
     `process.stdout.write(...)`) — must run when the WASI entry (`_start`) is
     invoked, AFTER the embedder has wired its environment.

A blanket `(start)` runs BOTH at instantiation. For (1) that's correct; for (2)
it's wrong — the `runWasi` harness (`tests/wasi.test.ts:43`) intercepts
`console.log` only AFTER `WebAssembly.instantiate`, so a top-level log fired
during `(start)` writes to the un-intercepted real console and is lost. (In
real wasmtime the write goes to actual stdout at instantiation, which is also a
semantics change from "_start drives output".)

Memory is module-internal (`(memory 3)`, exported), so memory access during
`(start)` is fine — the problem is purely **side-effect timing**, not memory.

## Correct design (needs the init-split) — for the implementer

Split `__module_init` into two functions:
  - `__module_bindings_init` — only the binding allocation + TDZ-guard sets
    (the lexically-hoistable initializers needed before any export). Wire THIS
    into the Wasm `(start)` section in **all** modes (WASI included). Idempotent
    / side-effect-free.
  - `__module_toplevel` — the remaining observable top-level statements
    (calls, I/O). Keep this driven by `_start` for WASI (and folded into the
    existing `(start)` for non-WASI, where it already works because the JS host
    sets up imports before instantiation).

Then exported functions reading a module-const see initialized bindings
(via the `(start)`-run bindings-init), while WASI top-level I/O still fires at
`_start`. No double-init, no harness regression.

ALTERNATIVE (smaller but per-call cost): restore the legacy #907 init-done
guard — inject `if (!__init_done) { __init_done = 1; __module_init(); }` at the
top of each **exported** function (not `_start`) in WASI mode only. Simpler to
implement (no init split) but adds a branch to every export and re-introduces
the guard #907 removed.

RECOMMENDATION: the init-split is the right architecture (matches ES module
semantics: lexical bindings initialized at instantiation, top-level statements
run as the module body). It is **hard** — it requires teaching declarations.ts
which top-level statements are pure binding-init vs side-effecting, and
threading two init funcs through `addWasiStartExport` + dead-elimination +
late-import index shifting (`index.ts:7474`). Escalated to tech-lead /
architect for the split design before implementing. Repro:
`$CLAUDE_JOB_DIR/tmp/top1.ts` (valueOf), `top4.ts` (counter double-init guard).

## Resolution (sd-1665, 2026-06-03) — idempotent-init guard (the #907 alternative)

The clean init-split hit a real **complexity wall**: classifying every
top-level statement as pure binding-init vs side-effecting is ambiguous (e.g.
`const o = sideEffect()` is both), and threading two init bodies through the
late-import index-shift machinery is high-risk. Per the tech-lead's
"prefer the split unless you hit a wall" guidance, landed the safer
guard design instead — it satisfies the same correctness with the 14
`wasi.test.ts` stdout tests as a tight regression guard.

**Implementation** (`addWasiStartExport` → new `applyModuleInitGuard`,
`src/codegen/index.ts`):
1. Add an `__init_done` i32 global (0). Prepend a self-guard prologue to
   `__module_init`: `if (__init_done) return; __init_done = 1; …`. This makes
   init **idempotent**.
2. Prepend `call __module_init` to every exported function body (except
   `__module_init` itself). The first entry called — a direct export OR
   `_start` — runs init exactly once; later calls no-op.

Why it satisfies both modes:
- **test262 standalone**: harness calls `test()` directly → its prologue runs
  init → module-const object is initialized → no TDZ trap. (target repro
  `(o as any)*1` now returns 42.)
- **WASI hosts**: `_start` is called first → init (incl. top-level
  `console.log`/stdout) runs at `_start`, exactly as before → all 24
  `wasi.test.ts` tests stay green; observable side-effect timing unchanged.
- **No double-init**: the `__init_done` self-guard caps init to one run
  regardless of how many exports (or `_start`) are invoked (verified with a
  top-level counter: stays 5, not 10).

Cost: one `call __module_init` (cheap, immediately returns after the first
run) at the top of each export — the per-call branch the clean split would
avoid. Acceptable for the correctness it buys; the split remains a viable
future optimization but is not required.

**Files**: `src/codegen/index.ts` (`applyModuleInitGuard` + call in
`addWasiStartExport`), `src/codegen/context/types.ts` +
`create-context.ts` (`moduleInitGuardApplied` flag),
`tests/issue-1788-standalone-module-init.test.ts` (4 tests).

**Validation**: `tests/issue-1788-standalone-module-init.test.ts` (4 pass) +
`tests/wasi.test.ts` (24 pass) + standalone sweep
(issue-1618/1653/1597/1321/1335/865, 46 pass). tsc clean.
