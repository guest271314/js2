---
id: 1742
title: "Closure `this`-receiver member reads trap 'illegal cast' when `this` is a compiled vec/struct (CPR prerequisite, shared with #1629)"
status: in-progress
created: 2026-05-30
updated: 2026-05-30
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: this-receiver-binding
goal: test262-conformance
sprint: 57
related: [1719, 1629, 1636]
---

# #1742 — Closure `this`-receiver member reads trap "illegal cast" for compiled vec/struct receivers

## Problem

When a compiled closure body reads `this[i]` / `this.length` / `this.member` and
`this` is a **compiled value** (a WasmGC `$vec` array or a named struct) supplied
as the receiver through the `__call_fn_method_N` host-dispatch path, the read
**traps `RangeError`-class "illegal cast"** at runtime.

This is the prerequisite blocking **#1719 CPR** (driving an overridden
`Array.prototype[@@iterator]` whose body reads `this[i]`) and is the **same gap
class** sdev-1629 hits for accessor getters (`get x(){ return this.x }`, a
**struct** receiver). It is shared infrastructure, not a #1719-local fix.

## Root cause (pinned)

The closure **receiver ABI already exists** (#1636-S1, PR #873): `__call_fn_method_N`
takes `thisVal: externref`, stores it in the `__current_this` module global
before `call_ref`, and `ThisKeyword` resolution reads that global
(`src/codegen/expressions.ts:862`, gated on `fctx.readsCurrentThis`). **`this` is
passed via a global, NOT a calling-convention param — so there is no closure-ABI
ripple.**

`ThisKeyword` resolution returns the global as a literal **externref**
(`src/codegen/expressions.ts:~906`). When the body then does `this[i]` /
`this.length`, codegen takes the **statically-typed vec/struct fast path**
(because the override is typed `Array`/`number[]`/`this: T[]`) and emits a bare
`ref.cast externref → $vec` — which traps, because the read site does NOT
guard-convert the externref to the concrete type the way the dedicated
externref-receiver lanes (`emitStructGetFromExternref`, #1454) do.

Working contrast (proves it is receiver-binding, not array reads): the same
generator driven with the array as a **regular parameter** works
(`function* g(a){ …a[0]… } ; g(arr)` → correct). Only the `this`-receiver path is
broken. And the array-method receiver lane
(`compileArrayPrototypeForEach`, array-methods.ts) already reads an externref
receiver as a vec correctly — that is the pattern to generalize.

## Design — read-site guard-convert (generic over vec AND struct)

**Read-site guard, not resolve-at-source.** `this` must stay externref at the
`ThisKeyword` resolution site, because it can legitimately be a genuine host
externref (a real host-object receiver) in other contexts; forcing it to
vec/struct there would break those. Instead, the index/length/property **read
sites** guard-convert: when the receiver value is an externref but the access
implies a compiled receiver (`this[i]` ⇒ vec, `this.member` ⇒ struct), emit
`extern.convert_any` + `ref.test`-guarded `ref.cast` to the concrete type (reuse
the existing `emitStructGetFromExternref` / guarded-cast helpers), passing
through unchanged for a genuine host externref.

- **Generic over receiver type:** vec (`this[i]`/`this.length` — #1719) AND
  struct (`this.member` — #1629). This is THE shared primitive; #1629's getter
  path consumes it rather than building its own.
- **Sites (~2-3):** element-access (`this[i]`), `.length` read, property-access
  (`this.member`) in `src/codegen/property-access.ts`, where a runtime-externref
  receiver currently bare-casts.

## Acceptance criteria

- A generator/function whose body reads `this[i]`/`this.length`, dispatched via
  `__call_fn_method_N` with a compiled vec receiver, runs without "illegal cast"
  and returns correct values (the #1719 CPR drive: canonical override yields the
  `42` element).
- A getter `get x(){ return this.x }` with a compiled **struct** receiver reads
  the field correctly (the #1629 consumer).
- No regression: genuine host-externref `this` receivers (e.g. real host objects)
  still pass through to the host read path unchanged; byte-identical output for
  modules that never dispatch a compiled receiver through `__call_fn_method_N`.

## Source

Carved from #1719 CPR build (senior-dev, 2026-05-30) after the size-gate probe
showed the `this`=compiled-receiver member-read guard is the genuine prerequisite
— ABI exists (no ripple), fix is in shared member-read codegen (~2-3 sites),
shared with #1629. Approved build-now by tech-lead.
