---
id: 2179
title: "post-delete struct READ returns stale value — inline struct.get fast-path bypasses the runtime tombstone"
status: ready
sprint: 63
created: 2026-06-16
updated: 2026-06-16
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [2130]
origin: "2026-06-16 deferred read-path half of #2130 (Stage A landed in-fix; architect addenda A6/A7)"
---

# #2179 — post-delete struct read is a no-op for statically-resolvable receivers

## Problem

The `in` / `hasOwnProperty` half of #2130 landed (Stage A): both now consult
the runtime delete tombstone. But the **read** of a deleted property still
returns the stale value when the receiver resolves to a static struct shape:

```ts
const o: any = { a: 1, b: 2 };
delete o.a;
o.a              // wasm: 1          node: undefined
o.a === undefined // wasm: false (folded)  node: true

const o2: any = { a: 1 };
delete o2.a;
o2.a = 5;
o2.a             // wasm: 1 (original, re-add lost on the field) node: 5
```

(`"a" in o`, `o.hasOwnProperty("a")`, object-rest `"e" in rest`, and the
re-added key's `in` result are all CORRECT after #2130 Stage A — only the
struct-field READ value is wrong.)

## Root cause (verified on main `8c74365b4`, JS-host)

A property read on an `any`-typed identifier whose initializer gives it a
resolvable anon struct type compiles to an inline fast-path
(`emitExternrefToStructGet`, `src/codegen/property-access.ts:1029`):

```
any.convert_extern
ref.test (ref <structTypeIdx>)
(if (then  ref.cast (ref <T>)  struct.get <T> <fieldIdx> )   ;; <-- reads the LIVE field
   (else  ... __extern_get fallback ... ))
```

Two compile-time issues compound:

1. The `then` arm reads the WasmGC struct field directly via `struct.get`,
   which has no knowledge of the runtime `_wasmStructDeletedKeys` tombstone or
   the sidecar. `delete o.a` (an `any` receiver) takes the runtime
   `__delete_property` arm, which sets the tombstone but cannot clear the
   struct field — so the field still holds `1`.
2. `o.a === undefined` is **constant-folded to `false`** because `o.a`'s
   static type is `f64` (`src/codegen/binary-ops.ts`, the null/undefined
   comparison path only emits `__extern_is_undefined` for an **externref**
   operand; an f64 operand can never be `undefined`, so it folds).

The runtime tombstone gate added to `_safeGet`/`__extern_get` in #2130 is
therefore bypassed for this receiver class (the read never reaches those
helpers).

## Why it is deferred (architect addenda A6/A7 on #2130)

- **A6**: the fix is to route delete-touched struct-ref reads through
  `__extern_get` (tombstone-aware, returns externref → real `undefined`, so
  `=== undefined` is no longer folded). Gate it on a `ctx.moduleUsesDelete`
  pre-scan (pattern: `sourceContainsClass`, `src/codegen/index.ts:209`) so
  delete-free modules keep byte-identical output and incur zero overhead.
- **A7 (standalone)**: `__extern_get` is a JS host import — unavailable under
  `--target wasi` / standalone. WasmGC has no weak refs, so a wasm-side
  `(obj,key)` tombstone registry would strongly retain every deleted-from
  object. The dual-mode answer is **representation steering**: reuse the A6
  pre-scan to find object-literal struct types targeted by `delete`, and in
  standalone mode lower those literals to the dynamic `$Object` representation
  (which already has spec-correct `FLAG_TOMBSTONE` tombstones, proto-walk
  `in`, and insertion-order enumeration — `src/codegen/object-runtime.ts`).
  Zero overhead for untouched objects, full fidelity for delete-touched ones.

## Acceptance criteria

- `const o:any={a:1,b:2}; delete o.a; o.a` → `undefined` (JS-host AND
  standalone).
- `o.a === undefined` after delete → `true` (not constant-folded).
- `delete o.a; o.a = 5; o.a` → `5` and `"a" in o` → `true` (re-add round-trip).
- `Object.keys(o)` / `for (const k in o)` omit the deleted key (verify #2130's
  `__object_keys`/`__for_in_keys` tombstone+sidecar union still holds — addenda
  A4).
- Delete-free modules emit byte-identical wasm (gate proves zero regression).
- No standalone regression; standalone path uses `$Object` steering, not a
  wasm tombstone registry.

## Notes

Split from #2130 (Stage A `in`/hasOwnProperty fix is `done`). This is the
codegen + representation-steering remainder. Coordinate the `moduleUsesDelete`
pre-scan with any other delete-aware lowering. See #2130's `## Resolution`
note and the architect addenda A6/A7 in #2130's Implementation Plan.
