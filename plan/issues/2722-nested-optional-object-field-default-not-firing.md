---
id: 2722
title: "Nested OPTIONAL object-field binding default not firing — externref field + f64 struct-getter can't signal field-absent"
status: ready
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: hard
reasoning_effort: high
task_type: fix
area: codegen, type-resolver
language_feature: destructuring, optional-properties
goal: test262-conformance
sprint: 67
parent: 1556
related: [1542, 1543, 1544, 1550, 1556]
owner_role: senior-developer
---
# #2722 — Nested optional object-field destructuring default not firing

**Carved from #1556** (verify-first by dev-1556b, 2026-06-26). #1556's core scope
(the #1543/#1544 illegal-cast cluster + single-level defaults) is **done**. This
is the narrow architectural residual it left behind. Recommended owner:
**senior-developer / architect** — it is a type-resolver representation change,
not a focused dstr-codegen edit. **Do not ship a fragile partial.**

## Repro (verified failing on current `origin/main`)

```ts
function f({ a: { b = 3 } = {} }: { a?: { b?: number } } = {}): number { return b; }
```

| Call | Got | Want |
|------|-----|------|
| `f()`              | 0 | 3 |
| `f({ a: {} })`     | 0 | 3 |
| `f({ a: { c: 1 }})`| 1 | 3 |
| `f({ a: { b: 5 }})`| 5 | 5 ✅ (inner literal HAS the field) |

Contrast — these all PASS today, so the defect is precisely "nested + optional field":

```ts
// required nested field → struct-ref path → works
function g({ a: { b = 3 } }: { a: { b?: number } }): number { return b; }
g({ a: {} })    // => 3 ✅
// single-level optional default → works
function h({ b = 3 }: { b?: number } = {}): number { return b; }
h(); h({});     // => 3 ✅
// array-element nested object default → works
function m([{ b = 3 } = {}]: Array<{ b?: number }> = []): number { return b; }
m(); m([{}]);   // => 3 ✅
```

Harness used: `tests/equivalence/helpers.ts` `compileToWasm`. (`compile` is async
— `await` it.)

## Root cause (WAT + `src/runtime.ts` trace)

1. **`a?` is the union `{b?:number} | undefined`.** `resolveWasmType` of a union
   yields **externref**, so the param-struct field `a` is typed `externref` —
   NOT a `(ref null structB)`. A *required* `a` keeps a struct ref, which is why
   the required twin `g` works.
2. The inner `{}` / `{c:1}` value (whether caller-built or the nested `= {}`
   default) is built as a WasmGC struct that does **not** match the `{b}` struct
   type (`struct-7` in the trace), then boxed to externref (`extern.convert_any`).
3. The destructuring reads `b` via host `__extern_get` → `__sget_b`. The generated
   `$__sget_b`'s else branch (object fails `ref.test (ref 7)`) returns
   `f64.const 0`. So `__extern_get` hands back JS `0`, `__extern_is_undefined(0)`
   is false, and the `b = 3` default never fires (`f({a:{c:1}})` returns `1`
   because field 0 of the `{c}` struct is read instead).
   **An f64-returning struct getter cannot represent "field absent" across the
   host boundary** — the f64 undefined-sentinel (NaN bits) round-trips to JS
   `NaN`, not `undefined`, so even returning the sentinel wouldn't help.
4. The required-field path works because field `a` is a real struct ref →
   `ref.test (ref 7)` succeeds → the struct fast path runs the **in-Wasm**
   `i64.reinterpret_f64` undefined-sentinel check, firing the default with no
   host roundtrip.

Relevant code:
- `src/codegen/index.ts:11559+` — `ensureStructForType` field-type resolution;
  the union/optional → externref widening (and the existing #1468 / #1589A
  externref-widening guards for `undefined`-typed and empty-object fields).
- `src/codegen/destructuring-params.ts:958` — nested-pattern recursion in
  `destructureParamObject`; `:805` — the externref-arm `ref.test`/`__extern_get`
  fast path.
- `src/codegen/statements/destructuring.ts:453` — `emitNestedBindingDefault`
  (builds the nested `= {}` default as a boxed struct).
- `src/runtime.ts:7409` — host `__extern_get` (struct-getter fallback at :7444
  calls `__sget_<key>`, which returns the f64-0 garbage for a non-matching
  struct).

## Path options (architect chooses)

- **Path A (recommended)** — represent optional object fields as **nullable
  struct refs** (`ref null structB`) instead of externref in `ensureStructForType`,
  so the struct fast path with the in-Wasm sentinel check handles them. Requires
  recognising the optional/`T | undefined` member case, registering/using the
  inner struct as nullable, and threading the nullable type through
  `function-body.ts` param-type resolution so the destructure reader sees a
  struct ref, not externref. Issue #1556's estimate: ~150–200 lines. Regression
  gate: full `language/destructuring/*`, `for-of/dstr/`, `for-await-of/`,
  `class/dstr/`, `function/dstr/`, `arrow-function/dstr/` families — net pass ≥ 0
  on every dir.
- **Path B** — build `{}`/partial literals assigned to externref fields as plain
  objects (`__new_plain_object`) so `__extern_get` returns `undefined` for
  missing fields. Touches object-literal codegen (`literals.ts`) + call-site
  coercion — the flagged "150+ regression" surface from #1556.
- **Path C** — struct-getter representation that can signal absence (substrate).
  Broadest blast radius.

## Acceptance criteria

- All four `f(...)` repros above return the spec-correct value (3/3/3/5).
- The `g`/`h`/`m` controls (and the existing #1542/#1543/#1544 guard tests) stay
  green.
- Guard test added at `tests/issue-2722.test.ts` covering: `f()`, `f({})`,
  `f({a:{}})`, `f({a:{c:1}})`, `f({a:{b:5}})`, plus the required/single/array
  controls.
- No net test262 regression on the dstr families (regression gate above).

## Notes

- A focused partial (make `emitNestedBindingDefault`'s `{}` a plain object) would
  fix only the default-built cases (`f()`, `f({})`) and leave caller-built ones
  (`f({a:{}})`, `f({a:{c:1}})`) broken. **Do not ship it** — incomplete + fragile.
- Parent #1556 carries the full verify-first verdict.
