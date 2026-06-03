---
id: 1797
title: "Native Error `.name` / `.message` read → string-op coercion double-convert defect"
status: done
created: 2026-06-03
updated: 2026-06-03
completed: 2026-06-03
priority: high
feasibility: medium
task_type: fix
area: codegen
language_feature: errors
goal: standalone-wasm
sprint: 58
owner: dev-1575
related: [1536, 1104, 1473, 1470]
note: "originally filed as #1791, but #1791 is the canonical node:path issue; renumbered to 1797 to resolve the duplicate-ID collision"
---
# #1797 — Native Error `.name` read into a native string op emits invalid Wasm

## Problem

In standalone / WASI mode, reading a native Error's `.name` (or `.message`)
and feeding the result into a **native string operation** — `e.name === "X"`,
`e.name.length`, template-literal interpolation of `e.name`, etc. — emits
**invalid Wasm** that fails to instantiate:

```
WebAssembly.instantiate(): Compiling function #N:"test" failed:
any.convert_extern[0] expected type externref, found ref.cast null of type (ref null 5)
```

(`type 5` is `$AnyString`.) For `e.name.length` the dual is:
```
struct.get[0] expected type (ref null 5), found struct...
```

### Repro (fails on `main`, target wasi or standalone)

```ts
export function test(): number {
  const e = new TypeError("oops");
  return e.name === "TypeError" ? 1 : 0;   // ← invalid Wasm
}
```

```ts
export function test(): number {
  const e = new TypeError("oops");
  return e.name.length;                    // ← invalid Wasm
}
```

A plain read with no string consumer (`const n = e.name;` then `return 0;`)
compiles and runs — the existing `#1104` Phase 2 tests only exercise that
shape, which is why this defect was latent.

## Root cause

The `.name` / `.message` fast-path reader in
`src/codegen/property-access.ts` (around lines 1058–1080, gated on
`ctx.wasi || ctx.standalone` for built-in Error subclasses) emits:

```
<receiver as externref>
any.convert_extern
ref.cast (ref $Error_struct)
struct.get $Error_struct <fieldIdx>   ;; → externref (the field type)
```

and returns `{ kind: "externref" }`. That part is fine in isolation. The
defect is in the **interaction with the native string consumer**: the
string-eq / `.length` / interpolation lowering then ALSO coerces its
operand externref → `(ref $AnyString)` via `any.convert_extern` +
`ref.cast null (ref null $AnyString)` — but the round-trip is applied
**multiple times** (the emitted WAT shows ~4 repeated
`any.convert_extern` / `ref.cast null (ref null 5)` pairs), and one
`any.convert_extern` receives a `(ref null $AnyString)` instead of the
`externref` it expects → validation failure.

Observed WAT (from `new Error("x").name === "Error"`, `--target wasi`):

```
struct.get 28 2        ;; $name → externref          (OK)
any.convert_extern     ;; externref → anyref         (OK)
ref.cast null (ref null 5)   ;; anyref → (ref null $AnyString)  (OK)
any.convert_extern     ;; ← BUG: operand is (ref null 5), not externref
ref.cast null (ref null 5)
any.convert_extern
...                    ;; repeats — coercion applied multiple times
```

So the `.name` reader and the native-string-eq path **both** insert the
externref→string coercion, double-(quadruple-)wrapping the value. The fix
is to make the two layers agree on the operand type at the boundary: either
the reader should hand the string consumer a value already typed as the
native string ref (and the consumer should not re-coerce), or the reader
should leave a clean externref and the consumer coerce exactly once.

## Scope

- `src/codegen/property-access.ts` — the `.name`/`.message` Error fast-path
  reader (`ctx.wasi || ctx.standalone` branch).
- The native string-eq / `.length` / interpolation lowering that consumes a
  declared-`externref` operand (binary-ops.ts string `===`/`!==`,
  string-ops `.length`, and template-literal substitution).

Likely the cleanest fix: have the Error `.name`/`.message` reader return the
value already as the resolver's native string ref type (`resolveString()`)
in standalone mode — matching what every other native-string producer hands
the string consumers — instead of `{ kind: "externref" }`. Then the
consumer's existing externref→string coercion fires exactly once (or not at
all). Verify the `#1104` Phase 2 tests (plain read, no consumer) still pass.

## Acceptance criteria

1. `new TypeError("x").name === "TypeError"` compiles to valid Wasm and
   evaluates to `true` under `--target wasi` AND `--target standalone`.
2. `new RangeError("x").name === "TypeError"` evaluates to `false`
   (distinct names, no cross-talk).
3. `new Error("x").name.length` evaluates to `4` (host-free).
4. `.message` reads compose with string ops the same way
   (`e.message === "oops"`).
5. No new `env.*` host imports for the error path.
6. Existing `#1104` Phase 1/2, `#1473`, and `#1536` suites stay green.

## Notes

- Unblocked by #1536 (PR #1090), which materialized the `$name` field so the
  value is now non-null and worth reading. Before #1536 this defect was
  masked because `.name` was always `ref.null.extern`.
- The reusable runtime test pattern: compare `e.name === "Literal"` IN-WASM
  (native `string.eq` → i32) and return the bool as a number, so a passing
  `1` proves both the field value and the read/coercion path. (See the
  abandoned comparison tests in `tests/issue-1536.test.ts` — they were
  deferred to this issue.)

## Resolution 2026-06-03 (dev-1575)

The 4× `any.convert_extern` / `ref.cast null (ref null 5)` chain was **not**
emitted during codegen and **not** from `coerceType` — it was spliced in by
`fixCallArgTypesInBody` (`src/codegen/stack-balance.ts`). For the
`__str_flatten` / `__str_concat` call, the backward arg-walk visits the
`.name` reader's `local.get; any.convert_extern; ref.cast; struct.get` chain
and treats **each delta-0 transformer as a separate producer for the same
argument slot** (`argOffset` never advances past 0 since those ops are
pop1/push1). It therefore queued the SAME externref→`$AnyString` coercion 4×
at the same insert position; the 2nd+ `any.convert_extern` then received an
already-cast `(ref null $AnyString)` operand → invalid Wasm.

Two-part fix:
1. **`stack-balance.ts` `fixCallArgTypesInBody`** — dedupe coercion insertions
   by insert-position (a `Set<number>` per call). The forward pass-through
   scan already collapses each delta-0 chain to one `insertPos`, so one
   coercion per slot is exact. This stops the 4× re-coercion for ALL
   externref-producing arg chains, not just Error reads.
2. **`property-access.ts`** — the Error `.name`/`.message` fast-path reader now
   coerces the `externref` field result to `(ref null $AnyString)` once (via
   the guarded `coerceType` path) and returns that ref type in
   nativeStrings/WASI mode, matching every other native-string producer. The
   `string.length` reader likewise coerces an externref receiver before the
   `struct.get $AnyString 0`.

The guarded coercion (`local.tee; any.convert_extern; ref.test; if`) is valid
and idempotent — no bare `any.convert_extern` over a `(ref null 5)` value.

All acceptance criteria pass (`tests/issue-1791.test.ts`, 7 tests). #1104
Phase 1/2/3, #1473, #1536, #1597, #728 suites stay green (47 tests). The
`stack-cleanup-fallthru` / `stack-balance` / `issue-958-concat-chain`
failures observed during validation are **pre-existing on main** (b7eee6522)
and unrelated.
