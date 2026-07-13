---
id: 3036
title: "Standalone: Promise.allSettled(...).then(cb) callback null-derefs on a late real-Promise microtask (pre-existing, discovered while landing #3035)"
status: done
assignee: ttraenkler/fable-rescue
created: 2026-07-05
completed: 2026-07-10
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: async
goal: standalone-mode
sprint: 71
related: [3035, 2980, 2867]
---

# #3036 — late-firing host-Promise microtask null-derefs the `.then` callback

## Problem

Discovered while verifying #3035 (#2980 class 1). Reproduces on CLEAN
`origin/main` (7f90320ea) — **unrelated to #3035's fix, no widen needed**:

```ts
let out = 0;
export function run(): void {
  Promise.allSettled([]).then(() => {
    out = 1;
  });
}
```

Compiled with `--target standalone`, instantiated via `buildImports()` +
run: `run()` returns successfully (the test262 harness records a correct
verdict where applicable). But `Promise.allSettled`'s host import returns a
REAL JS `Promise` (allSettled/any are "deferred" combinators — not natively
lowered, per `src/codegen/promise-combinators.ts`). That real Promise's
`.then` callback fires on a genuine Node microtask AFTER the synchronous
`run()`/`runTest262File` call already returned. By the time it fires, the
WASM closure-bridge trampoline (`wasmClosureBridge`, `src/runtime.ts:2081`)
null-derefs invoking the callback:

```
RuntimeError: dereferencing a null pointer
    at __closure_2 (wasm://wasm/...)
    at __call_fn_2 (wasm://wasm/...)
    at wasmClosureBridge (src/runtime.ts:2081:12)
    at new Promise (<anonymous>)
    at <anonymous> (src/runtime.ts:12140:61)   <- Promise_allSettled shim
    at fn (src/runtime.ts:14396:27)
    at __anon_0_then (wasm://wasm/...)
    at __obj_meth_tramp___anon_0_then_1 (wasm://wasm/...)
    at __call_fn_method_2 (wasm://wasm/...)
    at Proxy.closureBridge (src/runtime.ts:5688:76)
```

Repro (minimal, no vitest, no widen):

```bash
cat > /tmp/repro.mts <<'EOF'
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";
const r = await compile(`
  let out = 0;
  export function run(): void { Promise.allSettled([]).then(() => { out = 1; }); }
  export function getOut(): number { return out; }
`, { fileName: "t.ts", target: "standalone" });
const imports = buildImports(r.imports, undefined, r.stringPool);
const { instance } = await WebAssembly.instantiate(r.binary, imports);
imports.setExports?.(instance.exports);
instance.exports.run();
await new Promise(res => setTimeout(res, 200)); // crash fires here
EOF
npx tsx /tmp/repro.mts
```

Same-shape crash also reproduces via `runTest262File(path, cat, undefined,
"standalone")` on real test262 files
(`Promise/allSettled/resolved-immed.js`, `.../reject-ignored-deferred.js`)
run back-to-back in one process — the SECOND file's late microtask races
the first's already-torn-down WASM instance/closure state.

## Hypothesis (not yet root-caused)

`wasmClosureBridge` / `_wasmClosureWrapperSource` (src/runtime.ts ~2079-2083)
looks like a shared/global closure-invocation trampoline. A callback handed
to a REAL host Promise (via `Promise_allSettled`'s `.then`) that fires late
— after the originating WASM instance's own synchronous execution window —
may reference stale closure/instance state (a dangling `funcref`/table
index, or a GC'd struct) by the time the real Promise's microtask actually
invokes it.

## Scope note

Independent of #2980/#3035: the receiver-cast hardening in #3035 fixes
`.then`'s RECEIVER shape (what `emitStandalonePromiseThen` casts against);
this issue is about the CALLBACK invocation lifetime once a callback is
handed to a genuinely-async REAL host Promise (only reachable via the
"deferred" combinators `allSettled`/`any`, which don't have a native
lowering yet). Low priority: `allSettled`/`any` already don't have a
first-class native carrier, so this is a secondary defect on an
already-degraded path — but worth root-causing before `allSettled`/`any`
get their own native lowering (likely surfaces the same bug in a more
load-bearing spot).

## Acceptance criteria

- [ ] Root-cause identified: why does the closure-bridge trampoline
      null-deref on a callback invoked via a late, detached real-Promise
      microtask?
- [ ] Fix or a documented invariant (e.g. "callbacks handed to
      `Promise_allSettled`/`Promise_any` must not depend on
      per-call-instance state that outlives the synchronous call") that
      prevents this class of crash.
- [ ] Regression test using the minimal repro above (no widen needed).

## Resolution (2026-07-10, fable-rescue)

**Already resolved on current `origin/main` (32bae1f48f) — verified, not
re-fixed.** The closure-bridge null-deref described above no longer
reproduces via ANY of the routes in this issue:

1. the minimal single-instance repro (`Promise.allSettled([]).then(() => { out = 1; })`,
   `--target standalone`) — `run()` returns and the late microtask sets
   `out === 1` cleanly, no crash;
2. three back-to-back instances in one process, each calling `setExports`
   (so the module-level `callbackState.getExports()` points at the LAST
   instance) — the earlier instances' late `.then` microtasks still fire
   cleanly and set their own `out === 1`, no stale-closure null-deref;
3. the two named test262 files run back-to-back through
   `runTest262File(..., "standalone")`
   (`built-ins/Promise/allSettled/resolved-immed.js`,
   `.../reject-ignored-deferred.js`) — both record a (failing) verdict, and
   NO `uncaughtException`/`unhandledRejection` fires in the late-microtask
   window.

**Attribution:** the crash was live when #3035 landed (2026-07-05) — that
PR's test (`tests/issue-3035.test.ts`) had to install
`process.on("uncaughtException", () => {})` to swallow exactly this crash so
it would not look like a regression. It was fixed incidentally by the
post-#3035 async-carrier / closure-lifetime hardening line (#2978/#2980/#3035
area) that landed afterward; there is no single attributable commit and a
bisect was not warranted for a low-priority, already-degraded path.

**What this PR does:** adds `tests/issue-3036-late-microtask-closure.test.ts`,
a regression test that drives the exact original trigger (including the
multi-instance `setExports`-swap that made the bridge resolve the WRONG
instance's exports) and asserts the late callback fires with NO closure-bridge
crash. It deliberately does NOT swallow `uncaughtException`, so a reintroduced
null-deref surfaces as a captured error and fails the assertion.

**Follow-up (not done here, out of lane):** the now-unnecessary
`process.on("uncaughtException", () => {})` / `unhandledRejection` swallow in
`tests/issue-3035.test.ts` can be removed now that this crash is gone — left
in place to avoid touching another issue's test file.

### Acceptance criteria

- [x] Root-cause understood: the lazy closure bridge
      (`wasmClosureBridge`, `src/runtime.ts`) resolves `__call_fn_*` against
      the module-level `callbackState` exports at call time, so a late,
      detached real-Promise microtask from an earlier instance dispatched
      against a later instance's exports with a stale closure ref. No longer
      reachable on current main.
- [x] Fix / invariant in place: callbacks handed to the deferred combinators
      now survive a late, detached microtask (verified across all three
      original routes).
- [x] Regression test added (`tests/issue-3036-late-microtask-closure.test.ts`).
