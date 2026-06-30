---
id: 2892
title: "Standalone: string-ELEM native generator `.next().value as string` mis-types the result value (typeIdx mismatch) — fails wasm validation"
status: done
created: 2026-06-30
completed: 2026-06-30
assignee: ttraenkler/sr-genframe
priority: medium
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: Backlog
horizon: m
related: [2864, 2171]
umbrella: 2860
---

# Standalone: string-elem generator result `.value` read fails wasm validation

## Problem

A native generator whose yields are all **strings** (the #2171 native-string
carrier) compiles, but reading its result `.value` as a string in
`--target standalone` fails wasm validation:

```
WebAssembly.compile(): Compiling function #N:"test" failed:
type error in fallthru[0] (expected (ref null 40), got (ref null 35))
```

### Reproduction (current main, surfaced during #2864 F1b)

```ts
function* g() {
  yield "aa";
  yield "bbb";
}
export function test(): number {
  let it = g();
  let a = (it.next().value as string).length;
  let b = (it.next().value as string).length;
  return a + b;
}
```

Compiles with **zero host imports** but throws `CompileError` at instantiate —
the produced result-struct `value` field type (`ref null 35`) does not match the
type the consumer reads it back at (`ref null 40`). Both are native-string-ish
vec/array refs, but at different type indices.

This is **independent of spills** — it reproduces with a zero-spill string
generator (`yield "aa"; yield "bbb"`), so it is NOT the #2864 F1b spill-typing
path. It is in the #2171 string-carrier open result reader
(`tryCompileNativeGeneratorResultProperty` / `ensureNativeGeneratorResultType`),
where the `value` field's native-string ref typeIdx is minted differently from
the typeIdx the `.value` extraction coerces to.

## Root cause (suspected)

The string-elem generator's result struct `value` field is registered at one
native-string array/vec typeIdx, while the `.value` property read resolves the
expected string type to a _different_ registered native-string typeIdx (e.g. the
`$AnyString` ref vs a `__vec_<elem>` ref, or two separately-registered array
types for the same element). The two must resolve to the **same** reserved
typeIdx (reserve-once, like the F1 result-struct singleton per elem type).

## Where to look

- `src/codegen/generators-native.ts`:
  - `ensureNativeGeneratorResultType` (per-elem result struct minting),
  - `tryCompileNativeGeneratorResultProperty` (the open `.value`/`.done` reader),
  - `defaultElemValueInstr` / `genCarrierFieldType` for the string carrier.
- Cross-check against the native-string type registration
  (`native-strings.ts` `nativeStringType`, `getOrRegisterArrayType` /
  `getOrRegisterVecType`) — the result `value` field and the consumer read must
  share one reserved typeIdx.

## Test plan

Standalone CE/validation-fail → pass:

- `function* g(){ yield "a"; yield "b" }` read via `.next().value` (length / `===`).
- string-elem generator consumed via `for-of` (verify it already works — the
  for-of reader may use a different path than `.next().value`).
- `test/language/statements/generators/**` string-yield cases.

gc (JS-host) mode unchanged. Full `merge_group`.

## Notes

Surfaced while implementing #2864 F1b (typed spills). F1b deliberately scoped
AROUND this: F1b enables string LOCAL spills in _numeric_-elem generators (which
work), and string-elem generators with spills inherit this pre-existing reader
bug regardless of spilling.

## Resolution (2026-06-30)

**Actual root cause was the open `.next()` DISPATCH, not the result reader.**
When the iterator local is statically opaque (`let it = g()` types `it` as
`externref`, the common shape), `it.next()` lowers through the OPEN dispatch
(`buildNativeGeneratorDispatch`), not the direct path. That function hard-coded
its enclosing-block result type to the **f64 IteratorResult singleton** for any
non-`any`-carrier module:

```ts
const resultType = hasAny ? { kind: "eqref" }
                          : { kind: "ref", typeIdx: ensureNativeGeneratorResultType(ctx) }; // f64 singleton!
```

But each per-generator branch produces `struct.new info.resultTypeIdx` — for a
string generator that is the native-string `__NativeGeneratorResult_refN`
(typeIdx 35 in the repro), not the f64 singleton (41, which this very call
spuriously minted). So `if` branches typed `ref 35` flowed into a block declared
`ref 41` → `type error in fallthru[0] (expected (ref null 41), got (ref null 35))`.

**Fix** (`buildNativeGeneratorDispatch`): key the block type on the result
structs actually present rather than always the f64 singleton:
- any boxed-`any` carrier present, OR generators with **distinct** result
  structs (e.g. a numeric AND a string generator in one module) → `eqref`
  (the common `eq` supertype);
- all generators share ONE result-struct typeIdx → `ref <that idx>`. This covers
  both the dominant numeric-only case (every numeric generator shares the f64
  singleton — **byte-identical** to before) and the single-string-elem case.

For the single-string-generator case the dispatch now yields `ref <stringResult>`,
so the downstream `.value`/`.done` read takes the existing DIRECT reader path and
reads the value at the correct native-string typeIdx — no reader change needed.

**Verified host-free + correct** (`result.imports == []`): `.next().value as
string).length`, `=== "aa"`, annotated `Generator<string>` iterator, string
generator with a `return` value, `.done` after exhaustion, and a numeric
`.next().value` regression case. Tests: `tests/issue-2892-string-gen-value-reader.test.ts`
(6 cases). gc (JS-host) mode validates unchanged; numeric path emits identical bytes.

**Out of scope (pre-existing, separate path):** `for-of` over an *un-annotated*
string generator returns 0 on `origin/main` too — that is the documented #2171
loop-var-typing limitation (the loop var must be statically `string`), not this
reader/dispatch bug. Mixed numeric+string generators now *validate* (eqref) but
the open `.value` reader's string arm is still unimplemented — a strict
improvement over the prior CE; a narrow follow-up if needed.
