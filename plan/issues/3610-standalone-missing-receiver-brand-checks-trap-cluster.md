---
id: 3610
title: "Standalone builtins are missing receiver brand checks — 65-test trap cluster (illegal_cast/null_deref/oob) unmasked by the #3592 de-vacuification"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
goal: standalone-gap
related: [3592, 3596, 3601]
created: 2026-07-25
---

## Problem

The #3592 RC2 de-vacuification (`__apply_closure` dispatching at
`max(argc, declaredArity)`) made previously-skipped harness callbacks actually
run — and 65 previously-(vacuously)-passing tests now reach **genuine
pre-existing trap defects** in the standalone lane: uncatchable `illegal_cast`
(43), `null_deref` (21), and `oob` (1) where the spec requires a catchable
`TypeError`/abrupt completion.

These are **real bugs that were invisible behind fake passes**. They are
gate-excused on the #3592 landing PR (loopdive/js2#3601) via the named
`standalone-devacuification-allow` trap tier so the honest-floor landing is not
blocked — but the excusal is NOT a fix. This issue tracks the defects.

## Root cause — precisely characterised (measured, not assumed)

**Standalone builtin prototype methods/accessors skip the receiver brand check
and cast unconditionally.** Where the spec says "if `this` does not have
[[TypedArrayName]] / [[DateValue]] / … throw TypeError", the standalone
lowering emits a direct `ref.cast` (→ `illegal_cast` trap) or a null field
access (→ `null_deref` trap). A trap aborts the module and escapes
`try`/`catch`, so `assert.throws(TypeError, …)` can never observe the
expected TypeError.

One-line repros, arity-clean (NO under-applied call anywhere; verified to
reproduce on a pre-#3592 compiler build, so unambiguously pre-existing):

```ts
// illegal_cast cluster (12x TypedArrayConstructors/*/prototype/not-typedarray-object.js):
const b = Uint8ClampedArray.prototype.buffer; // → wasm trap: cast failure (spec: TypeError)

// null_deref cluster (Date.prototype.* on a non-Date receiver):
const t = Date.prototype.getTime(); // → wasm trap: null reference (spec: TypeError)
```

Discriminator evidence (2026-07-25, #3601 park partition):

- All 65 flips: widening-OFF **pass** (vacuous — callee never ran),
  widening-ON **trap**, innermost wasm frame is the CALLEE
  (`__closure_NN` / `C_method` / `toString` / …), never the dispatcher
  (`__call_fn_method_N`): 0 of 65.
- 20/20 shape-representative correct-arity bypass controls (explicit third
  argument so dispatch is exact-arity, widening DISABLED) trap **identically**
  — same trap class, same innermost frame, same source line. The dispatcher is
  exonerated; the callee code is genuinely defective.
- Full per-file table: `## #3601 park partition` in
  `plan/issues/3592-standalone-vacuous-asserts-arity-and-toplevel-throw.md`.

## Clusters (65 files)

| cluster                                                                                                                                                                                                                                                                                                                                        | count | trap         | shape                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `TypedArrayConstructors/*/prototype/not-typedarray-object`                                                                                                                                                                                                                                                                                     |    12 | illegal_cast | prototype accessor (`.buffer` etc.) on the plain prototype object — missing [[TypedArrayName]] brand check  |
| `Array.prototype.{findLast,findLastIndex,find,fill,copyWithin}` return-abrupt                                                                                                                                                                                                                                                                  |    11 | illegal_cast | abrupt completion from poisoned `length`/property — harness `assert.throws` internals cast the thrown value |
| eval-code/direct `*arguments-lex-bind*`                                                                                                                                                                                                                                                                                                        |     6 | illegal_cast | SyntaxError-expectation path                                                                                |
| `Date.prototype.*` non-Date receiver (`no-date-value`, `toString`, `setFullYear`, `Symbol.toPrimitive`)                                                                                                                                                                                                                                        |     5 | null_deref   | missing [[DateValue]] brand check                                                                           |
| `Proxy/getOwnPropertyDescriptor` + `deleteProperty` invariant checks                                                                                                                                                                                                                                                                           |     5 | null_deref   | trap-result invariant violation path                                                                        |
| `TypedArray.prototype.join` return-abrupt-from-separator (+BigInt)                                                                                                                                                                                                                                                                             |     4 | illegal_cast | abrupt separator                                                                                            |
| class/dstr `gen-meth-*-ary-init-iter-get-err-array-prototype`                                                                                                                                                                                                                                                                                  |     4 | illegal_cast | poisoned `Array.prototype[Symbol.iterator]`                                                                 |
| `Function.prototype[Symbol.hasInstance]` poisoned/non-object prototype                                                                                                                                                                                                                                                                         |     3 | null_deref   | OrdinaryHasInstance error paths                                                                             |
| class elements private-field errors (`private-fields-proxy-default-handler-throws`, `privatefieldset-evaluation-order-1`)                                                                                                                                                                                                                      |     2 | mixed        | private-field access on invalid receiver                                                                    |
| `String.prototype.replaceAll` replaceValue-call-abrupt (+tostring)                                                                                                                                                                                                                                                                             |     2 | illegal_cast | abrupt replaceValue                                                                                         |
| `escape`/`unescape` to-primitive-err                                                                                                                                                                                                                                                                                                           |     2 | illegal_cast | abrupt ToPrimitive                                                                                          |
| singles: `Array.prototype.with` (oob), `ArrayBuffer maxByteLength invoked-as-accessor`, `Iterator.concat non-constructible`, `Object.defineProperty 15.2.3.6-4-117`, `String.split valueOf limit`, `Symbol.for to-string-err`, `ThrowTypeError`, `Function/15.3.5.4_2-97gs`, `DisposableStack move`, `derived-class-return-override-with-null` |    10 | mixed        | various error paths                                                                                         |

(Exact 65 paths: the `tests:` list under `standalone-devacuification-allow` in
issue #3592's frontmatter — machine-consumed by `scripts/diff-test262.ts`.)

## Why this matters beyond the 65

A trap is strictly worse than a wrong answer (crash-free goal,
`plan/goals/goal-graph.md`): it aborts the whole module and poisons every
assertion after it. The 65 are only the tests whose FIRST newly-executed
assertion hits the defect — the same missing brand checks likely underlie part
of the pre-existing standalone trap population (282 null_deref / 377
illegal_cast baseline rows).

## Acceptance criteria

- [ ] Receiver brand checks on standalone builtin prototype methods/accessors
      throw catchable TypeError instead of trapping (start with the two proven
      clusters: TypedArray prototype accessors, Date.prototype methods).
- [ ] The two one-line repros above return 2 (caught TypeError) instead of
      trapping, host-free.
- [ ] The 65 cluster tests flip trap → honest fail or pass; the #3189 trap
      categories shrink accordingly.
- [ ] No `oracle_version` bump needed (codegen change, not verdict logic).
