---
id: 2130
title: "delete o.prop is a no-op and `in` answers against the static struct shape — post-delete / dynamic-key / object-rest all wrong"
status: ready
sprint: 61
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [1821, 492, 1112, 1991]
renumbered_from: "residual of #1821 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2130 — `delete` / `in` ignore runtime object shape (static-struct resolution)

## Problem

`in` is resolved at **compile time** against the source object's struct shape,
and `delete` on a literal object is a no-op on the underlying struct. So any
object whose runtime shape differs from its declared struct (post-delete
objects, object-rest objects) answers `in` wrong, and the deleted value is
still readable.

```ts
// delete is a no-op on the struct: value survives AND `in` stays true
const o: any = { a: 1, b: 2 };
delete o.a;
o.a                      // wasm: 1      node: undefined
"a" in o                 // wasm: true   node: false

// dynamic-key delete also a no-op
const k = "a";
delete o[k];
"a" in o                 // wasm: true   node: false

// object-rest: rest has no `e`, but `in` answers from the SOURCE struct shape
const { e, ...rest } = { e: 3, f: 4 };
"e" in rest              // wasm: true   node: false
// (rest CONTENTS are correct: rest.e === undefined, Object.keys(rest) === ["f"])
```

## Root cause

`in` lowering resolves the key against the receiver type's struct fields at
compile time and emits an `i32.const` (`src/codegen/binary-ops.ts:486-583`,
the `InKeyword` path). It never consults the runtime `__delete_prop` /
presence sidecar, so a property that was deleted at runtime — or never existed
on a rest object whose declared type still carries the field — is reported
present. The `delete` codegen for literal objects similarly doesn't clear the
struct field or mark the sidecar (#1821 fixed only the literal-key
`__delete_prop` sidecar for the *dynamic-key element-access* read path, not
the struct-field case, and not `in`).

This is the **false-positive** mirror of **#1991** (`in` never consults the
prototype chain → false negatives for inherited members). A unified fix would
route `in` through a runtime presence check that combines: own struct fields,
the runtime presence/delete sidecar, and (per #1991) the prototype chain.

## Acceptance criteria

- `const o:any={a:1,b:2}; delete o.a; o.a` → `undefined`
- `… "a" in o` after `delete o.a` → `false`
- dynamic-key `delete o[k]` removes the property (`in` → `false`, read →
  `undefined`)
- `const {e,...rest}={e:3,f:4}; "e" in rest` → `false` while
  `Object.keys(rest)` stays `["f"]`
- No regression on `in` for present own properties or array index `in`
- Equivalence tests under `tests/`

## Notes

`feasibility: hard` — touches the `in` lowering, `delete` lowering, and the
runtime presence model; coordinate with #1991 so both directions land on one
presence predicate rather than two divergent paths. Verified on main
`c19a2e9c1` via `.tmp/triage.mts` / `.tmp/triage2.mts` (branch
`po-1971-triage`). JS-host mode, default options.

---

## Implementation Plan (joint with #1991 — shared presence predicate)

> **The canonical shared design lives in `#1991`'s `## Implementation Plan`.**
> Read it first. This issue is **Stage A + Stage B** of the staged landing
> order defined there; #1991 is Stage C. Stage A is the shared refactor that
> #1991 also depends on, so land A before C.

### Root cause (recap — full version in #1991)

Two faces of one defect. The `in` operator and `delete` operate against the
**static struct shape**, never the runtime presence/delete sidecar:

- `in` on an `any`/cast receiver routes to `__extern_has`
  (`src/runtime.ts`, ~line 6343), which — unlike `__hasOwnProperty`
  (~line 8781) — **never consults the delete tombstone**
  `_wasmStructDeletedKeys`. So `delete o.a; "a" in o` stays `true`.
- `delete o.a` on a struct **field** sets a NaN/ref-null sentinel
  (`typeof-delete.ts:32` `emitDeleteSentinel`) only on the **static
  struct-field arm** (`typeof-delete.ts:115-196`). For an `any`/cast
  receiver that arm is skipped and delete falls to the `__delete_property`
  runtime arm (`typeof-delete.ts:267-342`), which records the tombstone but
  **cannot clear the struct field** — so the subsequent read `o.a` reads the
  unchanged field via `__sget_a` and returns the stale value (`1`).

Ground truth (this PR's branch, `c19a2e9c1`, JS-host, `setExports` wired):

```
const o:any={a:1,b:2}; delete o.a;
  o.a        → 1      (want undefined)   ← field uncleared
  "a" in o   → true   (want false)       ← tombstone ignored
  "b" in o   → true   (correct)
const k="a"; delete o[k]; "a" in o → true (want false)   ← dyn-key no-op
const {e,...rest}={e:3,f:4}; "e" in rest → true (want false)
```

### Stage A — the `in` false-positive fix (shared; blocks #1991 Stage C)

Implement the shared predicate refactor from #1991's plan:

**File: `src/runtime.ts`**
- Extract `_wasmStructHasOwn(obj, key, exports)` from `__hasOwnProperty`'s
  WasmGC branch (~line 8791-8817) — tombstone-absent AND (sidecar OR
  descriptor OR struct-field). Re-point `__hasOwnProperty` at it (pure
  extraction, no behavior change).
- Rewrite the `__extern_has` arm (~line 6343-6386) so its WasmGC-struct
  branch is `_wasmStructHasOwn(...) || _wasmStructHasInherited(...)` (the
  inherited half is #1991 Stage C; for Stage A landing alone, call
  `_wasmStructHasOwn` and keep the existing inline `_OBJECT_PROTO_KEYS`
  check). The key Stage-A effect: the tombstone is now consulted, so
  `"a" in o` after `delete o.a` returns `false`, and object-rest `"e" in
  rest` returns `false` (the rest struct never had `e` written, and if the
  source struct's typeIdx leaks the field, the tombstone/own-check on the
  *rest* object — which has its own struct shape — answers correctly; verify
  the rest object is a distinct struct, see Stage B object-rest note).

This alone fixes acceptance criteria #2 and the object-rest criterion.

### Stage B — delete actually removes the property (read + dynamic-key)

**(B1) Clear the struct field on the runtime delete path.**

**File: `src/codegen/typeof-delete.ts`** — the `__delete_property` runtime
arm (`267-342`) records the tombstone but leaves the struct field holding
its old value, so reads return stale data. Two options:

- **Preferred:** when the receiver *can* be resolved to a struct type even
  through an `any`/cast (consult `ctx.widenedVarStructMap.get(ident.text)`
  the same way the static arm does at `typeof-delete.ts:118-119`), take the
  static field arm (sentinel `struct.set` + `__delete_property`) instead of
  the pure-runtime arm. The static arm at lines 115-196 already does exactly
  the right thing — extend its **guard** so it fires for widened-`any`
  identifiers, not only for receivers whose TS type resolves to a struct.
  This makes `delete (o as any).a` clear the field AND set the tombstone.
- **Fallback (covers truly opaque receivers):** make the read side
  tombstone-aware. The `__sget_<key>` getter path in property reads should
  return `undefined` when `_wasmStructDeletedKeys.get(obj)?.has(key)`. This
  is a runtime-only guard but adds a tombstone check to every dynamic struct
  read — heavier. Prefer the codegen-side field clear (B1 preferred) and use
  this only for receivers with no resolvable struct type.

**(B2) Dynamic-key delete `delete o[k]`.**

The element-access runtime arm (`typeof-delete.ts:304-324`) compiles the key
as externref and calls `__delete_property`, which DOES set the tombstone
keyed by `String(k)`. So after Stage A, `"a" in o` post `delete o[k]`
already returns `false` (tombstone consulted). The remaining gap is the
**read** `o.a` returning stale — same fix as B1 (the field isn't cleared
because a dynamic key can't be resolved to a static field index). For the
dynamic-key case the read-side tombstone guard (B1 fallback) is the only
option, since the field index isn't known at compile time. Scope: add the
tombstone guard to the dynamic element-read runtime helper
(`__extern_get` / `__sget` dispatch) so a tombstoned key reads `undefined`.

**(B3) `__for_in_keys` tombstone filter.**

**File: `src/runtime.ts`** — `__for_in_keys` (~line 8834) collects struct
field names (line ~8861) **without** filtering the tombstone. The per-visit
`__for_in_has` (#2066, line ~8924) currently masks this for for-in
enumeration, but `Object.keys` / `Object.entries` (which call
`__getOwnPropertyNames`-style helpers) may not. Filter
`_wasmStructDeletedKeys.get(current)` out of the collected `fieldNames` in
`__for_in_keys` and in `__getOwnPropertyNames` (~line 8814 region) so
`Object.keys(o)` after `delete o.a` omits `a`. **Cross-check the
`Object.keys(rest)` acceptance criterion stays `["f"]`** (it currently
passes — do not regress).

### Object-rest specifics

`const {e,...rest}={e:3,f:4}` — confirm the compiler lowers `rest` to a
**distinct struct** containing only `f` (not an alias of the source struct
with `e` still present). If `rest` shares the source struct shape, `"e" in
rest` resolves `e` as an own field and Stage A's own-check returns true
incorrectly. Check the object-rest lowering (grep `ObjectBindingPattern` /
rest-element in `src/codegen/declarations.ts` / `destructuring`); if `rest`
carries the source typeIdx, either (i) build a fresh struct type for the rest
object omitting the bound keys, or (ii) record the omitted keys as tombstones
on the rest object at construction. Prefer (i) — a correct shape is cheaper
than a tombstone the runtime must always consult. The acceptance note says
`rest` CONTENTS are already correct (`rest.e===undefined`,
`Object.keys(rest)===["f"]`), which suggests the rest object's *field set* is
right and only `in`'s static/own resolution is consulting the wrong shape —
verify which, as it decides between (i) and "Stage A already fixes it".

### Edge cases (#2130)

- **delete then re-add:** `delete o.a; o.a=5; "a" in o` → `true`, `o.a` → `5`.
  `_sidecarSet` already clears the tombstone (`runtime.ts:2250-2253`); confirm
  the re-add path (struct.set or sidecar) reaches it.
- **delete non-configurable** (`Object.defineProperty(o,"a",{configurable:
  false})` then `delete o.a`): `__delete_property` returns `0` and keeps the
  property — `"a" in o` must stay `true`. Stage A's own-check via descriptor
  map must still see it.
- **integer keys** (`delete o[0]`, `0 in o`): mirror #1837's integer-key
  helper; tombstone keys are stringified (`String(0)==="0"`) consistently on
  both delete and `in`. Coordinate with #2131 (integer-key enumeration).
- **Symbol keys:** `delete o[sym]; sym in o` — tombstone stores the raw
  symbol (`runtime.ts:8777`); `_wasmStructHasOwn` must compare symbol keys by
  identity, not `String(key)`.
- **null receiver:** `delete (null as any).x` → `__delete_property` returns
  vacuously true (`runtime.ts:8729`); `"x" in null` is a TypeError in real JS
  — but that's #2132's domain, do not change here.

### Test plan (#2130)

Add `tests/issue-2130-delete-in-presence.test.ts` (JS-host; mirror the
`setExports`-wired harness in `tests/fast-arrays.test.ts`):

- `const o:any={a:1,b:2}; delete o.a;` → `o.a===undefined`, `!("a" in o)`,
  `"b" in o`.
- dynamic key: `const k="a"; delete o[k];` → `!("a" in o)`,
  `o.a===undefined`.
- object-rest: `const {e,...rest}={e:3,f:4};` → `!("e" in rest)`,
  `"f" in rest`, `Object.keys(rest)` deep-equals `["f"]`.
- delete-then-re-add round-trips `in` and read.
- non-configurable delete keeps `in` true and returns `false` from `delete`.
- `Object.keys(o)` / `for (const k in o)` omit the deleted key.

test262: `language/expressions/delete/*`,
`language/statements/for-in/*`, `built-ins/Object/keys/*`,
`built-ins/Object/prototype/hasOwnProperty/*` — Stage A touches
`__hasOwnProperty`, must stay green.
