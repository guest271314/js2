---
id: 3052
title: "IR `class.call`: void instance method in statement position"
status: done
assignee: opus-classcall
completed: 2026-07-05
sprint: 71
created: 2026-07-05
updated: 2026-07-13
priority: medium
horizon: s
feasibility: medium
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: classes
goal: ir-full-coverage
parent: 3000
related: [3000, 2855, 1370]
---

# #3052 — IR `class.call`: void instance method in statement position

Banked in #3000-C's Implementation Notes. A class body (constructor **or** plain
method) that calls a **void** instance method as a **statement**
(`this.add(x);` / `obj.tick();`) demoted the whole caller **post-claim** with:

```
ir/from-ast: void method <Class>.<method> used in expression position (<caller>)
```

The caller fell back to legacy (byte-inert, correct runtime, but **no IR
emission**). This blocked genuine IR emission of any class body that invokes a
method in statement position — a common shape (mutating helpers, chained
setters, ctor delegation to `this.init()`).

## Root cause (verified `upstream/main` @ 2ca9a852a)

`irCompiledFuncs` measure-first on a flat class whose method calls a void method
as a statement:

```
class Counter { #n; constructor(s){this.#n=s;} add(d):void{this.#n=this.#n+d;}
                run():number{ this.add(5); this.add(3); return this.#n; } }
```

- `Counter_add` (the void method itself) **IS** IR-emitted — its body is fine.
- `Counter_run` is **ABSENT** from `irCompiledFuncs` and **PRESENT** in
  `irPostClaimErrors` with `{kind:"build", func:"Counter_run",
  message:"ir/from-ast: void method Counter.add used in expression position"}`.

The **selector already CLAIMS** this shape (a statement-expression whose
expression is a method call — the same path non-void statement calls take), so
it reaches `from-ast`. The class-method arm of `lowerMethodCall`
(`src/ir/from-ast.ts` ~L3469) then threw **unconditionally** for a void method,
ignoring the `statementPosition` flag the function already receives — unlike the
already-correct `super.method()` arm (L3266) and extern-class arm (L3431), which
both gate the throw on `!statementPosition`.

## Fix

Honour `statementPosition` in the class-method arm — a **two-line** change
mirroring the sibling arms:

```ts
if (method.returnType === null && !statementPosition) {   // was: === null
  throw new Error(`... used in expression position ...`);
}
const r = cx.builder.emitClassCall(recv, methodName, args, method.returnType);
if (method.returnType !== null && r === null) {           // was: r === null
  throw new Error(`... class.call produced no result ...`);
}
return r;
```

No new IR instr is needed — the `class.call` instr, `emitClassCall` builder, and
`lower.ts` `class.call` case **already** carry a null result through:

- `emitClassCall(..., null)` emits `{kind:"class.call", result:null,
  resultType:null}`.
- The `class.call` lowering emits `call $<Class>_<method>`; a void method's Wasm
  slot leaves **nothing** on the operand stack.
- `emitBlockBody`'s `result === null` in-place path emits it **balanced** — no
  drop needed. (A **non-void** method call whose result is discarded in
  statement position was already handled by the `useCount === 0 &&
  isSideEffecting` emit+**drop** path; only the void case was blocked at the
  from-ast gate.)

## Proof (non-vacuity + safety)

- **Genuine emission**: post-fix `Counter_run` (and the chained
  `Counter_tickTwice`) appear in `irCompiledFuncs` in **both** lanes (host
  externref + native `$AnyString`) with **zero** `irPostClaimErrors`. The
  before/after on the telemetry (ABSENT+demoted → PRESENT+clean) is the
  differential proof.
- **Runtime parity**: chained void calls `run() → tickTwice() → add()`
  round-trip exactly (`10 + 5 + 3 = 18`); a non-`this` receiver
  (`a.push(4); a.push(6);`) also emits + runs (`10`).
- **Byte-inert**: identical source produces byte-identical wasm on base vs fix
  for a non-class program (`8ef3e1e3`) and a class with no void
  statement-position call (`5786d800`). The change is purely additive gating;
  the typeIdx-parity guard (`integration.ts:715`) still gates every slot
  overwrite → worst case a clean legacy fallback, never a miscompile (#3000
  precedent).
- **Guard preserved**: a void method used in **expression** position
  (`const y = this.bump();`) still cleanly demotes (test asserts the demotion +
  correct legacy runtime).
- **Blast radius**: the full class equivalence suite (18 files, both lanes) has
  **identical** pass/fail on base vs fix — 61 pre-existing failures unchanged
  (raw-`WebAssembly.instantiate` `string_constants`/`wasm:js-string` harness
  noise + the #582 struct.new test; both #3034-class harness issues, not
  compiler regressions); the only delta is **+5 passes** = this issue's new
  `tests/issue-3052.test.ts`.

## Corpus / fallback-bucket delta

`pnpm run check:ir-fallbacks`: no bucket change. The `class-method` bucket was
already driven to **0** by #3000-E and post-claim demotions were already
`(none)` on the playground corpus — this exact void-statement-position shape is
not present in `playground/examples/`, so the fix shows no corpus count delta
(and, importantly, no regression). The improvement is proven by the dedicated
`#3052` test + `irCompiledFuncs` telemetry, not a corpus number.

## Files

- `src/ir/from-ast.ts` — `lowerMethodCall` class-method arm honours
  `statementPosition` (2-line guard change).
- `tests/issue-3052.test.ts` — genuine-emission proof (both lanes), chained +
  non-`this` runtime parity, and the expression-position-demotion guard.

## Provenance

Banked by #3000-C (opus-3000c, 2026-07-04): "void `this.method()` in statement
position … the `class.call` void path does not honour statement position …
Recommend a dedicated issue." Verified pre-existing on `upstream/main` — affects
plain methods, not just constructors.
