---
id: 3036
title: "Standalone: Promise.allSettled(...).then(cb) callback null-derefs on a late real-Promise microtask (pre-existing, discovered while landing #3035)"
status: ready
created: 2026-07-05
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: async
goal: standalone-mode
sprint: current
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
