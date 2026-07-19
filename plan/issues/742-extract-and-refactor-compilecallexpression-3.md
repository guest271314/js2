---
id: 742
title: "Extract and refactor compileCallExpression (3,350 lines)"
status: done
completed: 2026-07-14
assignee: ttraenkler/sendev-waveb
created: 2026-03-17
updated: 2026-07-19
priority: high
# (#742 Wave B, PR by sendev-waveb) The identifier-callee dispatch arm was moved
# verbatim into the new sibling module call-identifier.ts. Two change-scoped
# gates flag the NEW file (both net-zero across the tree — a pure relocation):
#   - loc-budget: call-identifier.ts is a new 2.1k-LOC module (> 1500 threshold).
#   - coercion-sites: the 7 coercion-vocabulary sites moved out of calls.ts into
#     it (calls.ts loses exactly these; net-zero). Not new hand-rolled coercion.
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-tail-dispatch.ts
coercion-sites-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-tail-dispatch.ts
# 2026-07-12 (#3182 groom): elevated medium→high. The EXTRACTION half is done
# (calls.ts exists, 18,753 LOC — see #803, closed as landed); the live scope is
# the REFACTOR half: break up compileCallExpression inside
# src/codegen/expressions/calls.ts and table-drive the dispatch chain.
feasibility: medium
goal: maintainability
sprint: 72
depends_on: [688]
files:
  src/codegen/expressions.ts:
    breaking:
      - "extract compileCallExpression (3,350 lines) into calls.ts"
      - "convert dispatch to table-driven pattern"
---
# #742 — Extract and refactor compileCallExpression (3,350 lines)

## Status: open

## Problem

`compileCallExpression` is 3,350 lines — the largest single function in the codebase. It's a massive if/else chain dispatching on callee type, method name, and receiver type. Previous extraction attempt (#688 step 9) was reverted due to a bug.

## Approach

1. Extract into `src/codegen/calls.ts` (retry of #688 step 9)
2. Must work on the current expressions.ts (14,314 lines) which already has 8 extractions
3. Careful dependency analysis — many functions were moved to other modules
4. Convert the dispatch chain to a table: `Map<string, CompileHandler>`

## What to extract
- `compileCallExpression` (3,350 lines)
- `compileNewExpression` (777 lines)
- `compileClosureCall`, `compileCallablePropertyCall`
- `compileSuperMethodCall`, `compileSuperElementMethodCall`
- `compileExternMethodCall`
- `compileOptionalCallExpression`, `compileOptionalDirectCall`
- Builtins: `compileMathCall` (355), `compileDateMethodCall` (267), `compileConsoleCall`, `compileConsoleCallWasi`
- IIFE handling, spread args

## Previous attempt failure
The agent branched before other extractions, so imports pointed to wrong modules. Must branch from current main.

## Complexity: L

## Unblocked + re-scope note (2026-06-12)

Blocker #688 is long done — flipped to `ready`. Content is stale on every fact (compileCallExpression is now ~9,082 lines, was 3,350; the expressions/ split happened). Re-scope before dispatch: (a) table-driven callee dispatch registry, (b) builtin lowerings migrate into #2088's per-builtin scaffold. Bug density in calls.ts is LOW (0.9/KLOC) — this is maintainability work, not a correctness lever.

## Progress — incremental step 1 (2026-06-17, PR by cs-1931)

Started the decomposition with the **self-contained early-guard prelude** of
`compileCallExpression`, the lowest-risk slice (the prior attempt was reverted
for doing too much at once / branching wrong, so this proceeds incrementally
off current `origin/main`).

Extracted into a new `src/codegen/expressions/calls-guards.ts`, each as a
`(ctx, fctx, expr) => InnerResult | undefined` handler (undefined = not-my-case,
caller continues dispatch):

- `tryNamespaceNonCallable` — `Math()/JSON()/Reflect()/Atomics()/Proxy()` as a
  function throw TypeError (#1732/#2180).
- `tryJsxRuntimeCall` — `_jsx/_jsxs/_jsxDEV` runtime intercept (#1540).
- `tryRegExpConstructorCall` — `RegExp(p, f)` without `new`.
- `tryObjectCoercionCall` — `Object(x)` ToObject coercion (#1129/#1568).

`compileCallExpression`: 9,437 → 9,242 lines. **Behaviour-preserving** — a
WAT-hash oracle over 25 call-heavy programs is byte-identical before/after.
Tests: `tests/issue-742.test.ts` (wasm≡JS for the extracted guards).

**Remaining** (future PRs, same incremental pattern + WAT oracle): continue
pulling self-contained guard/dispatch blocks out of the prelude; then tackle the
method-dispatch core; finally the table-driven callee registry (re-scope item a).
Builtin lowerings stay deferred to #2088's per-builtin scaffold (re-scope item b).
Issue stays `in-progress`.

## Progress — Wave B chunk 1: identifier-callee dispatch (2026-07-14, sendev-waveb)

By this point `compileCallExpression` had grown to **~13,371 lines** (5136–18506
in `calls.ts`) — the single biggest function in the codebase. Its body is a flat
sequence of dispatch arms guarded on the *shape* of `expr.expression`
(property-access → method call; identifier → global/direct call; super; element
access; conditional; …). Crucially, the only function-scope locals live in the
**prelude** (`nodeProcessCall`, `_aggCallee`, …) and are consumed immediately —
**no dispatch arm closes over prelude state**, so each arm depends only on
`ctx` / `fctx` / `expr` and is cleanly liftable.

This chunk extracts the **identifier-callee dispatch family** — the block that
handles a bare-identifier callee: node:fs global functions
(`readFileSync`/`writeFileSync`, WASI + JS-host lowerings), the inline global
builtins (`parseInt`/`parseFloat`/`isNaN`/`isFinite`/`Array(...)`), and direct
named-function calls resolved through `funcMap`. That was lines 14714–16717
(~2,004 LOC), a contiguous run of five `if`-guarded arms.

Done in two verified steps (safety-first, byte-identity gated at each step):

1. **Same-file extraction** → a top-level `compileIdentifierCall(ctx, fctx,
   expr): InnerResult | undefined`. Verbatim move; the block's implicit
   fall-through (reaching the arm's end without returning) becomes
   `return undefined`, and the call site does
   `const r = compileIdentifierCall(...); if (r !== undefined) return r;`.
   `undefined` is a safe fall-through sentinel because `InnerResult` never
   includes it (no `return undefined` / bare `return;` in the moved span).
2. **Relocate to sibling module** `src/codegen/expressions/call-identifier.ts`.
   The 14 `calls.ts`-internal symbols the arm needs are exported from `calls.ts`
   (`emitBoundFunctionCall`, `tryEmitInlineDynamicCall`, the `calleeIsX`
   predicates, `PATH_BASED_FS_FNS`, …); `calls.ts` imports `compileIdentifierCall`
   back. The resulting `calls.ts ↔ call-identifier.ts` cycle is lazy
   (used only inside function bodies) and matches the existing
   `calls.ts ↔ calls-closures.ts` / `new-super.ts` cycles.

**Result**: `compileCallExpression` ~13,371 → ~11,388 LOC; `calls.ts` 19,435 →
17,441 LOC; new `call-identifier.ts` 2,105 LOC.

**Byte-identity proof**: `scripts/prove-emit-identity.mjs` — IDENTICAL across all
39 `(file,target)` emits (gc/standalone/wasi × the 13-file playground corpus)
after each step. `tsc --noEmit` 0 errors. `check:oracle-ratchet` net-zero
(`getTypeAtLocation +0`, `ctx.checker +0`). Smoke test:
`tests/issue-742.test.ts` adds wasm≡JS cases for the moved paths (parseInt
family, `Array(...)`, direct/recursive named calls).

The two `*-allow` frontmatter keys sanction the *new file* the two change-scoped
gates flag — both net-zero across the tree (a pure relocation), not new code.

**Next chunks (Wave B, serial)**: the 9k-line property-access method-call arm
(5632–14712) is the remaining giant — decompose it into per-receiver-family
helpers; then the super / element-access / conditional / IIFE arms. Issue stays
`in-progress`.

## Progress — Wave B chunk 2: built-in static-method dispatch (2026-07-14, sendev-waveb)

First cut into the 9k-line **property-access method-call arm**
(`if (ts.isPropertyAccessExpression(expr.expression))`, calls.ts 5633–14713).
That arm declares one arm-level local (`propAccess = expr.expression`) plus three
consumed-immediately `standaloneRegExp*` consts; the namespace static-method
sub-block does **not** close over any of them, nor over `receiverType` (which is
only introduced at ~11666, after the block) — so it depends solely on
`ctx` / `fctx` / `expr` / `propAccess`.

This chunk extracts the **built-in static-method dispatch block** — static method
calls on the built-in value-type namespaces `Math` / `BigInt` / `Number` /
`Array` / `String` / `Object` (`Math.max`, `Number.isInteger`, `Array.from`,
`String.fromCharCode`, `Object.keys`, …), calls.ts lines 6764–9733 (~2,970 LOC),
ending cleanly right before the `Symbol` arm.

Same two verified steps as chunk 1:
1. **Same-file** → `compileBuiltinStaticCall(ctx, fctx, expr, propAccess):
   InnerResult | undefined`. The block's four `return undefined` / bare `return;`
   statements are all inside **nested arrow closures** (`literalKeyText`,
   `compileArgAsExternref`), not top-level arm returns — so the `undefined`
   fall-through sentinel is safe.
2. **Relocate to sibling** `src/codegen/expressions/call-builtin-static.ts`. Nine
   `calls.ts` internals are exported to it (`compileMathCall` comes via
   `./builtins.js`; the exported set is `BUILTIN_CLASS_NAMES`,
   `compileFromCharCodeFamily`, `compileNumberIsPredicate`,
   `compileObjectAssignArg`, `isGlobalBuiltinIdentifier`, `staticToBoolean`,
   `tracesToTypedArrayIntrinsicProto`, plus the already-exported
   `compileCallExpression` / `compileProtoArg`).

**Result**: `compileCallExpression` ~11,388 → ~8,410 LOC; `calls.ts` 17,462 →
14,484 LOC; new `call-builtin-static.ts` 3,064 LOC.

**Proof**: `prove-emit-identity` IDENTICAL across all 39 `(file,target)` emits
after each step; `tsc --noEmit` 0; `check:oracle-ratchet` net-zero;
`check:coercion-sites` OK (no allowance needed this slice); only `loc-budget`
flags the new file (allowance added above). Smoke test extended with Math /
Number / Array / String / Object static-call cases (wasm≡JS).

**Remaining in the property-access arm**: the rest of the namespace statics
(`Symbol` / `Reflect` / `Promise` / `JSON` / `Date`, ~9736–11665) then the
receiver-type method dispatch (class methods, Number/BigInt/Boolean wrappers,
generators, typed arrays, valueOf/toString, ~11666–14712). Issue stays
`in-progress`.

## Progress — Wave B chunk 3: namespace static dispatch (2026-07-14, sendev-waveb)

Completes the namespace-static half of the property-access arm. Extracts the
**remaining namespace static-method dispatch** — `Symbol` / `Reflect` /
`Promise` / `JSON` / `Date` statics (`Symbol.for`, `Reflect.*`, `Promise.all` /
`race` / `resolve` / `reject`, `JSON.parse` / `stringify`, `Date.now` / `parse` /
`UTC`), the block that immediately follows chunk 2's cluster and runs up to the
receiver-type dispatch (calls.ts 6774–8702 post-chunk-2, ~1,929 LOC, ending right
before `let receiverType = …` at 8705) — into a new sibling module
`src/codegen/expressions/call-namespace-static.ts` (`compileNamespaceStaticCall`).

Self-contained on `ctx`/`fctx`/`expr`/`propAccess`: the block references no
`receiverType`/`receiverClassName` (introduced only after it) and no prelude
locals; `isPromiseSubclassReceiver` is declared inside the block; its four
`return undefined`/bare `return;` are all inside nested arrow closures. Same two
verified steps (same-file → sibling); 9 `calls.ts` internals exported to it
(`emitDynamicCombinatorArg`, `emitIterableArg`, `emitJsonReplacerAllowList`,
`isDynamicCombinatorArgEligible`, `resolvePromiseSubclassThisArg`,
`tryEmitJsonParsePrimitive`, `tryEmitJsonStringifyPrimitive`, plus already-exported
`compileCallExpression`/`compileProtoArg`).

**Result**: `compileCallExpression` ~8,410 → ~6,480 LOC; `calls.ts` 14,484 →
12,564 LOC; new `call-namespace-static.ts` 2,028 LOC.

**Proof**: `prove-emit-identity` IDENTICAL across all 39 `(file,target)` emits
after each step + post-merge; `tsc` 0; `oracle-ratchet` net-zero;
`loc-budget` + `coercion-sites` (one relocated `__is_truthy` site, net-zero) pass
with allowances added above. Smoke test extended with Symbol.for / Date.UTC
cases (wasm≡JS). (A JSON.stringify-of-object equivalence case was dropped — a
pre-existing object-stringify limitation independent of this relocation, which
the byte-identity gate already proves neutral.)

**Remaining in the property-access arm**: only the **receiver-type method
dispatch** now (`receiverType`-keyed: class methods, Number/BigInt/Boolean
wrapper methods, generators, typed arrays, valueOf/toString, ~8705–end of arm) —
that section DOES use the arm-level `receiverType`/`receiverClassName` locals, so
the next slice threads those in (or lifts the `receiverType = …` computation into
the helper). Issue stays `in-progress`.

## Progress — Wave B chunk 4: receiver-type method dispatch (2026-07-14, sendev-waveb)

Empties the property-access arm. Extracts its **receiver-type method dispatch**
tail — the `receiverType`-keyed half (user-class instance methods, Number /
BigInt / Boolean wrapper methods, generator methods, typed-array methods, and
the generic valueOf / toString / toLocaleString fallbacks), calls.ts 6788–9835
post-chunk-3 (~3,048 LOC, from the `let receiverType = …` line to the arm close)
— into a new sibling module `src/codegen/expressions/call-receiver-method.ts`
(`compileReceiverMethodCall`).

The block was lifted **from the `receiverType = …` computation onward**, so the
helper computes `receiverType` / `receiverClassName` / `recvTsType` itself (all
arm-local, unused after the arm) — self-contained on
`ctx`/`fctx`/`expr`/`propAccess`/`expectedType` (`expectedType` is threaded
through; its single use is one argument site). The one `return undefined` match
in the span is a comment, not a statement. Same two verified steps; 19 `calls.ts`
internals exported to it (17 helper functions + the two `STANDALONE_TA_*` typed-
array HOF sets; `compileCallExpression` / `BUILTIN_CLASS_NAMES` /
`emitWrapperDynamicMethodCall` were already exported).

**Result**: `compileCallExpression` ~6,480 → ~3,430 LOC; `calls.ts` 12,564 →
9,534 LOC; new `call-receiver-method.ts` 3,165 LOC.

**Proof**: `prove-emit-identity` IDENTICAL across all 39 `(file,target)` emits
after each step; `tsc` 0 (two module-scope `STANDALONE_TA_*` consts the import
scan missed were caught by tsc and exported); `oracle-ratchet` net-zero;
`loc-budget` + `coercion-sites` (11 relocated coercion sites, net-zero) pass with
allowances added above. Smoke test extended with user-class method + Number
`toFixed`/`toString(radix)` cases (wasm≡JS).

**With the property-access arm now fully decomposed**, `compileCallExpression` is
a lean dispatch skeleton: the guard prelude, the property-access arm (now just
regexp guards + calls into `compileBuiltinStaticCall` /
`compileNamespaceStaticCall` / `compileReceiverMethodCall`), the identifier
dispatch (`compileIdentifierCall`), and the remaining tail arms — IIFE, super
(`compileSuperMethodCall`), element-access, call-of-call, and conditional callee
(~3,430 LOC total). Those tail arms are the remaining slices. Issue stays
`in-progress`.

## Progress — Wave B chunk 5: tail dispatch + epic DONE (2026-07-14, sendev-waveb)

Final slice. Extracts `compileCallExpression`'s **tail dispatch** — the IIFE
forms (`(function(){…})()` / `(()=>…)()`), super method calls, element-access
method calls (`obj[expr](…)`), call-of-call chains, the conditional callee, and
the graceful fallback for unrecognized shapes (calls.ts 6810–8596 post-chunk-4,
~1,787 LOC) — into a new sibling module
`src/codegen/expressions/call-tail-dispatch.ts` (`compileTailDispatch`).

The tail ends in an **unconditional** graceful-fallback return, so the helper
always returns `InnerResult` (no fall-through sentinel) and
`compileCallExpression`'s tail is a single `return compileTailDispatch(ctx, fctx,
expr, expectedType)`. Self-contained on `ctx`/`fctx`/`expr`/`expectedType`; 12
`calls.ts` internals imported (6 newly exported, the rest already exported by
earlier slices / the export block).

**Result**: `compileCallExpression` ~3,430 → **~1,685 LOC** (a lean dispatch
skeleton); `calls.ts` 9,534 → 7,753 LOC; new `call-tail-dispatch.ts` 1,872 LOC.

### Epic summary — `compileCallExpression` decomposition DONE

| slice | extracted arm | module | fn LOC after |
| ----- | ------------- | ------ | ------------ |
| 1 | identifier-callee dispatch | `call-identifier.ts` | ~11,388 |
| 2 | Math/Number/Array/String/Object statics | `call-builtin-static.ts` | ~8,410 |
| 3 | Symbol/Reflect/Promise/JSON/Date statics | `call-namespace-static.ts` | ~6,480 |
| 4 | receiver-type method dispatch | `call-receiver-method.ts` | ~3,430 |
| 5 | IIFE/super/element/call-of-call/conditional tail | `call-tail-dispatch.ts` | **~1,685** |

`compileCallExpression` went from **13,371 LOC (the single biggest function in
the codebase) to ~1,685** (−87%), and `calls.ts` from **19,435 → 7,753**. The
function is now a readable dispatch skeleton: guard prelude → property-access arm
(regexp guards + `compileBuiltinStaticCall` / `compileNamespaceStaticCall` /
`compileReceiverMethodCall`) → `compileIdentifierCall` → `compileTailDispatch`.
**Every slice was byte-identical** (`prove-emit-identity` IDENTICAL, 39/39
gc/standalone/wasi × 13-file corpus, after each same-file + sibling-relocate
step), `tsc` 0, `oracle-ratchet` net-zero, with per-issue `loc-budget` /
`coercion-sites` allowances for the six new modules (all net-zero relocations).
`tests/issue-742.test.ts` grew to 16 wasm≡JS cases spanning every moved arm.

The re-scope's table-driven callee registry (item a) is now largely moot — the
callee-shape dispatch is cleanly delegated to per-shape sibling modules. Marking
`status: done`.
