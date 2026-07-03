---
id: 2905
title: "Standalone/WASI Promise carrier: resolveWasmType(Promise<T>) must lower to externref (stored/typed promise contract)"
status: done
created: 2026-07-01
updated: 2026-07-03
completed: 2026-07-01
assignee: ttraenkler/sendev-promise
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: 69
horizon: m
related: [2867, 2895, 2865, 1313, 1727, 1936]
umbrella: 2860
architect_spec: authored
blocks: [2895]
---

# Promise type contract: `resolveWasmType(Promise<T>) → externref` under the native carrier

## Problem

Under the native `$Promise` carrier (the `isStandalonePromiseActive(ctx)` gate —
today `ctx.wasi`, widened to `ctx.standalone` by #2895 slice 1d), an async call
`f()` leaves a **real `$Promise` (externref)** on the stack — produced either by
`wrapAsyncReturn` (synchronously-compiled async fn,
`expressions.ts:378-389`) or by the drive layer's result-promise
(`emitAsyncFrameStateMachine`, `function-body.ts:1159-1173`).

But the **type contract for a stored/typed `Promise<T>`** disagreed:
`resolveWasmType(ctx, Promise<T>)` unwrapped the promise to `T` at
**`src/codegen/index.ts:12044-12054`** (comment: "Async functions are compiled
synchronously, so Promise<T> is just T at the Wasm level" — **false under the
carrier**). So every place that typed a *value as `Promise<T>`* resolved to
`f64`/`i32`/etc., and storing the externref `$Promise` into that slot coerced
`externref → f64` via `__unbox_number($Promise)` = **NaN** (or `ref.cast` into a
struct slot = illegal-cast trap).

PR for #2401 fixed only the **inline** `f().then()` / `await f()` path (the type
flows straight from the call expression, never through a `Promise<T>`-typed
slot). The **stored / typed** path was still corrupted:

```ts
const p = f();            // p : Promise<T>  → f64 slot  ← NaN
p.then(cb);               // receiver typed Promise<T>   ← any.convert_extern on f64
async function g(q: Promise<T>) { await q; }  // param typed Promise<T> ← NaN
interface H { p: Promise<T> }                  // field typed Promise<T> ← NaN
function h(): Promise<T> { return Promise.resolve(x); }  // non-async return ← NaN
```

## Implementation Plan (authored — read-only analysis of current `main`)

[Full architect spec retained — see below for the as-built notes that supersede
the gating mechanism the spec left open.]

### The fix (one focused change)

**File: `src/codegen/index.ts`** — `resolveWasmType`, the `Promise` branch.
Carrier-gate the unwrap so a `Promise<T>` value slot lowers to `externref` when
`isStandalonePromiseActive(ctx)`; the host/GC unwrap-to-`T` path is unchanged.

### Signature-stability guard (the −16/−29 hazard)

The three sites that compute a function's **own** wasm return via
`resolveWasmType(retType)` **without** the async unwrap
(`declarations.ts:1655` `findCallSignature`, `:3742` `module.exports = function`,
`:3804` CJS named export) were guarded: an async fn's own wasm result is the
**unwrapped `T`** (its body returns raw `T`; `wrapAsyncReturn` boxes to
`$Promise` only at the *call* site), so declaring `externref` for a
synchronously-compiled async fn whose body returns `f64` would be **invalid
Wasm**. Each site now pre-unwraps async returns to match the four main
async-return sites.

## As-built implementation notes (sendev-promise) — WHY, not just WHAT

### Gating decision: import the predicate, do NOT inline `ctx.wasi === true`

The spec advised **against** importing `isStandalonePromiseActive` into
`index.ts` (and `declarations.ts`), fearing an import cycle because
"`async-scheduler.ts` imports `getOrRegisterPromiseType` etc. FROM `index.ts`".
**That premise is false** — verified on current `main`:

- `getOrRegisterPromiseType` is **defined in** `async-scheduler.ts:255`, not
  imported from `index.ts`.
- `async-scheduler.ts` contains **no `import … from "./index"`** at all (the only
  `index.ts` mention is a comment at line 1425).
- `index.ts` **already** imports from `./async-scheduler.js` (the
  `enableStdinReactor`/`ensureTimerHeap` block).

So the dependency is strictly one-way `index → async-scheduler`. Importing
`isStandalonePromiseActive` into both `index.ts` and `declarations.ts` adds **no
cycle**, and is strictly better than inlining `ctx.wasi === true`: it keeps a
**single source of truth**, so when #2895 slice 1d widens the predicate to
`ctx.standalone` it widens here automatically — **no lockstep two-place edit**,
which is exactly the failure mode the spec's "keep in sync" comment was trying to
guard against.

### Own-return guard is carrier-gated too (defends GC byte-identity by construction)

The spec's literal `isAsync ? unwrapPromiseType(retType) : retType` is correct
under the carrier but would **change off-carrier bytes for the
async-`Promise<void>` edge** at these three sites (today
`resolveWasmType(Promise<void>) → externref`; the bare unwrap would yield `[]`).
To make GC byte-identity hold **by construction** rather than by argument, the
guard is gated on the carrier as well:

```ts
const effRet = isStandalonePromiseActive(ctx) && isAsync
  ? unwrapPromiseType(retType, ctx.checker)
  : retType;
```

Off-carrier `effRet === retType` **always** → byte-identical. On-carrier: async
fns pre-unwrap to `T` (matches the raw-`T` body), non-async `Promise<T>` returns
stay `Promise<T>` → `resolveWasmType` → `externref` (correct — their body returns
a real promise). For site 1655 `isAsync` is derived from
`sig.getDeclaration()` via `hasAsyncModifier` (same pattern as
`expressions.ts:194`); sites 3742/3804 read `hasAsyncModifier(fnExpr)` directly.

### Verification (local, verify-first)

- **GC byte-identity (hard gate): PASS.** Compiled a 5-case corpus
  (stored-binding, `Promise<T>` param, interface field, non-async `(): Promise<T>`
  return, `Promise<T>[]`) at `target: "gc"` before/after — **bytes identical**
  (629 / 418 / 974 / 628 / 1271 each lane).
- **WASI carrier (the fix is exercisable today, no #2895 1d needed):** all five
  cases compile + `WebAssembly.validate` true on both lanes.
- **Mechanism proof (WAT diff of `$test` for `const p = f(); p.then(cb)`,
  `--target wasi`):**
  - *Before:* `(local $0 f64)`; `local.set $0 (call $__unbox_number (… struct.new
    $Promise …))` — the `$Promise` is unboxed to f64 = `Number($Promise)` = **NaN**,
    then re-`__box_number`'d and `ref.cast (ref $Promise)` of a boxed-number =
    **illegal cast**.
  - *After:* `(local $0 externref)`; the `$Promise` is stored **directly (no
    `__unbox_number`)**; `.then` reads it via `any.convert_extern (local.get $0);
    ref.cast (ref $Promise)` — a **valid** cast. NaN round-trip and illegal cast
    both eliminated.
- **AG0 value-consumer fails (#2895-owned):** untouched — `await asyncCall()` /
  `asyncCall() as number` skip `wrapAsyncReturn` and never flow through a
  `Promise<T>` slot, so they neither regress nor get fixed here (as designed).
- **Authoritative gate:** full `merge_group` standalone/test262 report
  net-positive (CI).

### Files changed

- `src/codegen/index.ts` — import `isStandalonePromiseActive`; carrier-gate the
  `Promise<T>` branch of `resolveWasmType` to `externref`.
- `src/codegen/declarations.ts` — import `isStandalonePromiseActive`; carrier-gate
  the own-return unwrap at the three `resolveWasmType(retType)` signature sites
  (`findCallSignature`, default-export function-expression, CJS named export).

## Cross-references

- #2867 — umbrella standalone Promise/microtask carrier.
- #2895 — async-frame drive layer; **this issue unblocks #2895 slice 1d** (the
  standalone gate widen), plus carrier gaps 3/4/5.
- #1313/#1727/#1936 — the call-site async contract this type contract agrees with.
