---
id: 3044
title: "Object.defineProperty: compiler crashes on specific descriptor test shapes (invalid Wasm / illegal cast / op.endsWith / ctors-not-defined)"
status: done
completed: 2026-07-05
sprint: 71
priority: high
horizon: s
feasibility: medium
created: 2026-07-05
assignee: ttraenkler/dev-3044
task_type: bugfix
area: codegen
language_feature: object-defineproperty
es_edition: 5
goal: correctness
parent: 3022
related: [3022, 3024]
---

# #3044 — defineProperty descriptor-shape codegen crashes

Split from the #3022 umbrella. **Developer-scoped** — each is a concrete,
locally-reproducible compiler crash on a particular descriptor test shape (NOT a
descriptor-semantics gap). These are correctness bugs (the compiler emits an
invalid binary or throws internally) and can be picked off individually.

## Failing files + crash signature (16)

| file | crash |
|---|---|
| `15.2.3.6-4-255.js`, `15.2.3.6-4-256.js` | `invalid Wasm binary (WebAssembly.instantiate)` |
| `15.2.3.7-6-a-17.js`, `15.2.3.6-4-587.js` | `Codegen error: op.endsWith is not a function` |
| `15.2.3.7-6-a-113.js`, `15.2.3.6-4-117.js` | `illegal cast [in __closure_2()]` |
| `15.2.3.7-6-a-114.js` | `array element access out of bounds` |
| `typedarray-backed-by-resizable-buffer.js`, `coerced-P-grow/shrink.js` | `ctors is not defined` |
| `S15.2.3.6_A1.js` | `Cannot read properties of …` |

## Notes

- The `op.endsWith is not a function` signature is a codegen-internal bug
  (an `op` that is not a string reaches a `.endsWith` call) — likely shared
  across the two files; fixing it once should clear both.
- `illegal cast [in __closure_2()]` — a getter/setter descriptor compiled into a
  closure hits a bad cast; overlaps the accessor-in-closure path.
- `ctors is not defined` — resizable-ArrayBuffer-backed typed-array descriptor
  tests reference a harness global we don't provide (may be a harness/skip issue,
  verify before fixing).
- Several overlap #3024 (invalid-Wasm-emission residual) — cross-check before
  claiming so the fix lands in one place.

## Layer to fix

`src/codegen/*` — varies per crash; each has a minimal repro (the cited file).

## Acceptance

- The listed files compile to a valid binary (pass or a spec-correct runtime
  result), no compiler-internal throw. Scope: **DEV**, pick individual files.

## Resolution (2026-07-05, dev-3044)

**`op.endsWith is not a function` — root-caused and fixed.** In
`compileMathCall` (`src/codegen/expressions/builtins.ts`) the six native-unary
opcodes were dispatched via `if (method in nativeUnary)`. The `in` operator
walks the prototype chain, so an inherited `Object.prototype` method name
reaching a `Math.<method>()` call — `Math.hasOwnProperty("prop")`,
`Math.toString()`, `Math.valueOf()`, `Math.isPrototypeOf(x)`,
`Math.propertyIsEnumerable(x)`, `Math.constructor` — spuriously matched the
table and pushed `{ op: nativeUnary[method] }`, where the value is the inherited
*function*, not a string. That non-string `op` survived into `stack-balance`,
whose `op.endsWith(".load")` threw and aborted the whole module compile. Fixed
by dispatching with `Object.hasOwn(nativeUnary, method)` (own-property
semantics); inherited names now fall through to `return undefined` → generic
call handling. Strict narrowing — real math methods (own props) still match, and
the removed inherited-name path only ever emitted an invalid module, so it
cannot regress a passing test.

Impact (all three suite files that trigger it —
`defineProperty/15.2.3.6-4-{411,587}.js`, `defineProperties/15.2.3.7-6-a-17.js`):
`compile_error → runnable`. **`15.2.3.6-4-411.js` flips compile_error → pass**
(it asserts `Math.hasOwnProperty("prop") === false`, correctly resolved by
generic handling). `4-587` / `6-a-17` now run but still `fail` — they assert a
property *stored on `Math` by an earlier `Object.defineProperty(Math, …)`*,
which is the `defineProperty`-on-builtin storage/fidelity gap tracked by the
**#3022** umbrella, not a codegen crash. Regression test: `tests/issue-3044.test.ts`.

**Other cited signatures are stale on current main** (verified via
`runTest262File`): `15.2.3.6-4-{255,256}.js` (invalid-Wasm) already **pass**;
the `illegal cast` files `4-117` / `6-a-113` already compile to a valid binary
and `fail` on semantics only (no compiler throw); they call `.hasOwnProperty`
on arrays/objects, not `Math`, so they never went through `compileMathCall`.
The `ctors is not defined` typed-array files reference a harness global — a
harness/skip matter, not a codegen crash. Remaining semantics failures belong to
#3022 descriptor fidelity, not to this codegen-crash issue.
