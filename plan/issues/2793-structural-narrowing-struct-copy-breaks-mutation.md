---
id: 2793
title: "[ARCH][SUBSTRATE] Structural-narrowing struct COPY at call boundary breaks reference semantics (mutation through interface/structural-class param lost)"
status: ready
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: structural-typing
goal: correctness
parent: 2791
depends_on: [2773]
---

# Structural-narrowing struct COPY at call boundary breaks reference semantics

Spun off from **#2791** (hybrid audit Row 4 investigation). Row 4's READ side is
discharged; this is the **genuine silent miscompile** that investigation
surfaced. It is **NOT** in the Row-4 lane (`resolveStructName` /
`emitNullGuardedStructGet`) — it lives in the call-argument coercion / param
typing, and overlaps the substrate `$Object`/externref value-rep work (**#2773**),
so route it to the **architect / substrate lane**.

## Symptom (silent wrong value)

Passing a value to a parameter whose declared type is a **different nominal
struct type** — a structurally-compatible _distinct class_, or an `interface` —
and then **mutating through that parameter** silently loses the write. JS
reference semantics are violated (objects are passed by reference; the compiler
copies).

```ts
class A {
  x: number;
  constructor() {
    this.x = 1;
  }
}
class B {
  x: number;
  constructor() {
    this.x = 2;
  }
} // structurally identical, DISTINCT Wasm struct
function setX(o: A, v: number): void {
  o.x = v;
}
const b = new B();
setX(b, 9);
b.x; // JS: 9.   Compiler: 2  (write went to a copy)
```

Interface params are the more idiomatic trigger and fail identically:

```ts
interface I {
  v: number;
}
class A implements I {
  a: number;
  v: number;
  constructor() {
    this.a = 0;
    this.v = 1;
  }
}
class B implements I {
  v: number;
  constructor() {
    this.v = 2;
  }
}
function setV(o: I, x: number): void {
  o.v = x;
}
const a = new A(),
  b = new B();
setV(a, 100);
setV(b, 200);
a.v * 1000 + b.v; // JS: 100200.   Compiler: 1002  (both writes lost)
```

Runnable repro + `it.fails` locks: `tests/issue-2791.test.ts` (the
"KNOWN write miscompile" describe block — flip `it.fails` → `it` when fixed).

## Root cause (verified via WAT, origin/main df78324)

The call site emits a **structural-narrowing struct COPY**: it reads the
source's fields and builds a fresh `struct.new <paramType>`, passing the copy.
The callee's `struct.set` then mutates the copy; the caller's original object is
never touched.

```
;; test():  setX(new B(), 9)
call 2            ;; new B() -> $B
struct.get 4 0    ;; b.__tag
struct.get 4 1    ;; b.x
struct.new 1      ;; *** fresh $A copy from B's fields ***
f64.const 9
call 4            ;; setX(<copy>, 9)   -- mutates the copy, not b
... struct.get 4 1  ;; return b.x -> still 2
```

Code path: `src/codegen/type-coercion.ts` — `getStructNarrowInfo` /
`emitStructNarrowBody` (the "Case 3: destination fields are a subset of source
fields" narrowing, ~L760-855). The `struct.set` inside the callee
(`assignment.ts:2912-2961`) and the Row-4 read dispatch are both _locally
correct_; the bug is the copy upstream.

## Why it has been latent

- **Not in test262**: test262 is JS — it has no `interface` / structural-class
  types, so this never appears in conformance. It bites **TS-typed user code**
  (interface/structural params with mutation — very common), central to the
  `npm-library-support` and self-hosting/dogfood goals.
- The Row-4 read path's runtime `ref.test` multi-dispatch masks the _read_ half,
  so values read correctly — only mutation is lost, which is easy to miss.

## Why no Row-4-lane fix works

By the time the callee's field write runs, the receiver is already a
disconnected copy. Gating `resolveStructNameForExpr` (the audit's prescribed
Row-4 fix) cannot reconnect it. Union/`any` params already route to the safe
dynamic path (they pass _by reference_ as externref — and indeed mutation
through union/`any` params works correctly today); the breakage is specific to
params typed as a _single different nominal struct_ that triggers the narrowing
copy.

## Recommended fix direction (architect / substrate)

The SAFE machinery already exists (multi-dispatch read + `emitAlternateStructSetDispatch`
write). Route structural/interface receivers through it by **not materializing a
narrowed struct copy**:

- **Preferred:** type a parameter (or binding) whose declared type is an
  `interface`, or a class that has a structurally-distinct assignable type, as
  **`externref`/`anyref`** rather than a narrow `ref $T`. The call-site coercion
  becomes `extern.convert_any` (share the ref) instead of the
  `emitStructNarrowBody` field-copy, and the callee's reads/writes use the
  existing SAFE multi-dispatch. Param typing lives in the function-signature
  lowering (`declarations.ts` / wasm param-type resolution); the copy is gated
  in `type-coercion.ts`.
- **Soundness condition for keeping the copy:** the narrowing field-copy is only
  sound when the source value's identity is NOT observed after the conversion (a
  fresh temporary / pure value-narrowing). Distinguishing aliased-and-mutated
  from value-narrowed needs escape/aliasing analysis — which is why this is
  architect-scoped, not a localized patch, and why a blanket "never copy" is
  itself unsound (it would change return-value / value-copy semantics).
- **Overlap with #2773:** the externref/`$Object` value-rep substrate work is
  the natural home for "share the ref + dynamic field access" — coordinate so
  the param-typing change and the substrate reader/writer land coherently.

## Validation (broad-impact)

- Flip the `tests/issue-2791.test.ts` `it.fails` write cases to `it` (must pass,
  host + standalone) and add: nested/aliased mutation, mutation visible to a
  second alias, array-of-interface element mutation, return-of-narrowed-value
  (must still value-copy where identity is not observed).
- Broad-impact → full `merge_group` test262 + standalone-floor authoritative; do
  NOT scoped-sweep.
