---
id: 2638
title: "Standalone __to_primitive can't reduce a CLASS-instance struct through the externref boundary"
status: done
assignee: ttraenkler/a5968e297d289016e
sprint: 65
created: 2026-06-24
updated: 2026-06-24
completed: 2026-06-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, type-coercion
language_feature: to-primitive, abstract-operations
goal: standalone-mode
related: [2358, 1917, 10]
origin: "2026-06-24 sd reground of the #1917 object→primitive residual / #2358 follow-up: the non-$Object CLASS arm deferred after #2358 PR-1/PR-2."
---

# #2638 — standalone `__to_primitive` CLASS-instance arm

## Problem

In standalone / native-strings mode, `__to_primitive` (the §7.1.1.1
OrdinaryToPrimitive runtime helper, `src/codegen/object-runtime.ts:2006`)
reduces two non-primitive shapes:

- a dynamic `$Object` (the `ref.test objectTypeIdx` arm), and
- a `$Vec` array (`$__vec_base`, #2358 #10 — already landed).

A **class instance** is a *nominal* WasmGC struct — neither `$Object` nor
`$Vec` — so it misses both `ref.test`s and `__to_primitive` returns it
**unchanged**. The caller then does `__unbox_number(struct)` → **NaN** (or a
null string for the string hint). The comment at `object-runtime.ts:2186`
documents the hole explicitly: "Any other non-$Object value (a nominal struct
without a user ToPrimitive, a closure, etc.) returns unchanged as before."

This is the non-$Object **CLASS arm** deferred after #2358 PR-1 (`emitAnyAdd`
static-reduce, typed-local `+`) and PR-2 (`materializeStructAsDynamicObject`,
object-literal any-param). Those PRs handle object *literals* and the static
`+` path; a class instance reaching the **runtime** `__to_primitive` through an
erased `any` boundary is still broken.

## Repro (current origin/main, `target: standalone`)

```ts
class C { valueOf(): number { return 21; } }
function g(x: any): number { return x * 2; }
export function main(): number { return g(new C()); }   // → 42  PASS (static-reduce path)
```
```ts
class C { valueOf(): number { return 50; } }
function g(x: any): number { return x - 8; }
export function main(): number { return g(new C()); }   // → NaN  FAIL (want 42)
```
```ts
class C { valueOf(): number { return 42; } }
export function main(): number { return Number(new C() as any); }  // FAIL
```

The `*` case passes via the static `emitAnyAdd`/`coerceType(ref→f64,"number")`
reduction (the static type `C` is still live at that site and reads
`C_valueOf` at compile time). The `-` and `Number()` cases route through the
runtime `__to_primitive` on an erased externref, where the class arm is
missing.

## Root cause

`__to_primitive` gates reduction on `ref.test objectTypeIdx` (and `$__vec_base`
for arrays). A class instance is a distinct top-level nominal struct type; it
matches neither, so the helper falls to "return input unchanged" and the
numeric/string unbox downstream produces NaN / null.

## Fix (additive, reuses existing dispatchers — no new coercion site)

Add a **CLASS arm** in the `ref.test objectTypeIdx`-miss branch of
`__to_primitive` (after the existing `$Vec` check, ~`object-runtime.ts:2188`):
route a class-instance struct through the **existing**
`__call_valueOf` / `__call_toString` dispatchers (emitted by
`emitToPrimitiveMethodExports`, `src/codegen/index.ts:3983`, exported with
signature `(externref) -> externref`). Those dispatchers already `ref.test` /
`ref.cast` every known nominal struct type, call `StructName_valueOf` /
`StructName_toString`, box the result back to externref, and return
`ref.null.extern` on no match.

§7.1.1.1 method ordering by hint:
- **string hint**: `__call_toString` → `__call_valueOf`
- **number/default hint**: `__call_valueOf` → `__call_toString`

For each: call the dispatcher with the input externref; if the result is a
non-null primitive, return it; else try the other; if both miss, fall through
to the existing "return input unchanged" tail (a nominal struct without
valueOf/toString — the downstream unbox yields the same NaN/null as today, no
regression).

### CRITICAL — late-funcidx discipline (#2191 / #2043 hazard)

`emitToPrimitiveMethodExports` runs at **FINALIZE** (`index.ts:1822` / `:5573`),
**after** `__to_primitive` is built in `ensureObjectRuntime`. So
`__to_primitive` **cannot** capture a pre-shift funcidx for
`__call_valueOf`/`__call_toString`. It must reference them by a funcidx that is
stable across the late import/type shifts — a forward-declared placeholder
funcidx patched at finalize (the same `reserveAccessorGetDriver` /
`reserveArrayToPrimitiveString` reservation pattern the array arm already uses
at `object-runtime.ts:2023`/`:2035`). This is exactly the bug class root-caused
in #2191 (`7ae5c5df4`) — a captured pre-shift idx points at the wrong function
after the shift.

## Scope guards

- **Standalone-only** (`ctx.standalone`). gc / JS-host keep the live-mirror
  Proxy / host-`_hostToPrimitive` path; do not touch them.
- **Byte-diff-neutral** over: the existing dynamic-`$Object` ToPrimitive path,
  the `$Vec` array arm, and the hot static `*` / `-` arithmetic paths (those
  never enter the new arm — `*`/`-` on a statically-typed class instance is
  reduced at compile time and never reaches the externref `__to_primitive`).
- **No new coercion call-site** — reuses the existing `__call_*` dispatchers;
  `check:coercion-sites` (#2108) stays flat.
- The `$Object` wrapper-slot short-circuit (`new Number`/`new String`/
  `new Boolean`, `object-runtime.ts:2208-2238`) is unaffected — wrappers are
  `$Object`, handled before any class arm.

## Acceptance criteria

1. `class C{valueOf(){return 50}}; g(x:any){return x-8}; g(new C())` → **42**
   (standalone). (The headline repro.)
2. `Number(new C() as any)` with `valueOf` → the numeric value (standalone).
3. String-hint reduction: a class with `toString` reduces correctly under a
   string-hint consumer.
4. §7.1.1.1 ordering: number/default hint prefers `valueOf`; string hint
   prefers `toString`.
5. No regression: existing `$Object` / `$Vec` / static `*`,`-` paths
   byte-identical; gc/host unchanged; standalone floor green via `merge_group`.

## Files

- `src/codegen/object-runtime.ts` — `__to_primitive` body, the
  `ref.test objectTypeIdx`-miss branch (~`:2180-2198`): add the CLASS arm.
  Reserve the `__call_valueOf`/`__call_toString` funcidxs (forward-declared
  placeholder patched at finalize, mirror `arrayToPrimIdx`).
- `tests/issue-2638-toprimitive-class-arm.test.ts` — the repro cases above
  (standalone) + a gc-mode no-regression guard.
