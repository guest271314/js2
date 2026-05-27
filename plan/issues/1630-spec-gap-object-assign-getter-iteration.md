---
id: 1630
title: "spec gap: Object.assign drops getters / Symbol keys (27 of 38 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: 50
renumbered_from: 1335
parent: 1328
---
# #1335 — Object.assign: getter invocation + Symbol-key copying

## Problem

`built-ins/Object/assign`: **11 / 38 pass (28.9%) — 27 fails (21 assertion_fail, 6 runtime_error)**.

Spec §20.1.2.1 (Object.assign) requires CopyDataProperties to:
1. Enumerate **own enumerable** keys (string + Symbol) of each source.
2. **Invoke getters** on the source — the call must observe the receiver as the source object.
3. **Set** (not DefineOwnProperty) on the target — so target setters and prototype setters are invoked.
4. Skip non-enumerable own keys.
5. Throw if any individual Get/Set throws (and stop the iteration).

The current implementation in `src/codegen/object-ops.ts` (look for `compileObjectAssign`) and the
host fallback `__object_assign` does:
- Iterates only **string** keys (not Symbol keys).
- Reads via direct field access — getters are not invoked on typed structs.
- Writes via direct field assignment — target setters not invoked.

## Acceptance criteria

1. `built-ins/Object/assign/source-own-prop-error.js` passes (getter throw aborts iteration).
2. `built-ins/Object/assign/target-set-symbol.js` passes (Symbol keys copied).
3. `built-ins/Object/assign/Symbol-keys.js` passes.
4. Pass-rate for `built-ins/Object/assign` rises from 29% to ≥75%.

## Files to modify

- `src/codegen/object-ops.ts` — Object.assign emitter
- `src/codegen/property-access.ts` — common get/set with getter/setter invocation
- `src/runtime.ts` — `__object_assign` host fallback (mostly correct already; verify Symbol key handling)

## Implementation Plan

### Root cause

`compileObjectAssign` does a fast loop using `array.copy` on the underlying struct field-list and
skips the per-key Get/Set protocol entirely. This is fine for plain typed structs but wrong when:
- Source has accessor properties.
- Source is a Proxy (must trap).
- Either has Symbol keys.

### Approach

Two-phase:

1. **Fast path** — both source and target are plain typed structs with no accessors and no Symbol
   keys: keep the current `array.copy`-style emit.
2. **Slow path** — fall through to a generic loop:
   ```
   for key in OwnPropertyKeys(source):
     if !desc.enumerable: continue
     v = Get(source, key)   ;; honors accessors
     Set(target, key, v)    ;; honors target setters
   ```
   This must call into the runtime helper since the keys aren't known at compile time.

The key check at the call site: if either source or target is `externref` (or any object whose
type carries an accessor), pick the slow path.

### Edge cases

- Source is null/undefined → ignore (per spec).
- Source has a getter that mutates the source mid-iteration → spec says re-evaluate keys
  is unspecified; we should enumerate once at start.
- Target is frozen → Set throws TypeError at first non-existent property.

### Test262 sample

- `test262/test/built-ins/Object/assign/source-own-prop-error.js`
- `test262/test/built-ins/Object/assign/target-set-symbol.js`
- `test262/test/built-ins/Object/assign/source-own-prop-keys-error.js`

## Investigation (2026-05-27, dev-1568) — MIS-SCOPED, needs decomposition

Reproduced against current main. Baseline JSONL (May 25): **15 pass / 23 fail**.
The task title ("Object.assign drops getters / Symbol keys") does **not** match
the actual failures — getters and Symbol keys already work via host delegation.
Verified with direct probes:

- `Object.assign(plainTgt, {get a(){return 7}})` → `tgt.a === 7` PASS (getter invoked)
- `Object.assign(plainTgt, symbolKeyedSrc)` → Symbol copied PASS
- `Object.assign(plainTgt, nonEnumSrc)` → **copies non-enumerable** FAIL (root cause is
  `Object.defineProperty enumerable:false` not honored on the struct mirror — NOT assign)

The decisive split is the **target type**, not source accessors:
- target is plain externref (`{} as any`) → assign fully correct (getter+data both copy).
- target is a **typed wasmGC struct** (`{a:0,b:0}`) → **both** getter-sourced and plain
  data writeback fail (`tgt.a` AND `tgt.b` stay 0).

Root cause of the struct-target failure (runtime.ts):
`__object_assign` wraps the struct target via `_wrapForHost` and runs native
`Object.assign`. The Proxy `set` trap calls `_safeSet(obj, key, val)`
(runtime.ts:2177), which writes only to `obj[key]=val` (silently dropped — wasmGC
structs are opaque to JS) and the **sidecar** `_wasmStructProps`. It never invokes
a `__sset_<key>` struct-field writeback export. The compiled `tgt.a` read uses the
struct field (`__sget_a` / direct struct.get), which the sidecar never updated →
reads stay 0. There is no per-field `__sset_` setter export wired into `_safeSet`.

This is an architectural limitation: **JS-host mutation of wasmGC struct fields
cannot write back.** Fixing it requires emitting per-field `__sset_<key>` exports
and routing `_safeSet` through them — a codegen + runtime change spanning the whole
struct-mirror subsystem, far beyond Object.assign.

The 23 fails decompose into >=4 independent root causes, none a localized assign fix:
1. **Struct-target writeback** via `_wrapForHost`/`_safeSet` (`Override*`, `Target-Object`).
2. **Descriptor attributes** enumerable/writable not honored on struct mirror
   (`source-non-enum`, `target-set-not-writable`) — overlaps `Object.defineProperty`.
3. **freeze/seal/preventExtensions** not enforced → Set doesn't throw TypeError
   (`target-is-frozen-*`, `target-is-sealed-*`, `target-is-non-extensible-*`).
4. **Boxed wrapper `.valueOf()`** round-trip (`Target-Number/String`) — same
   limitation noted in #1568, shared by number/string/boolean wrappers.
5. Getter-invocation **order** + Proxy ownKeys (`strings-and-symbol-order*`,
   `source-own-prop-*-error`) — needs a real per-key Get/Set protocol over structs.

**Recommendation**: re-route to architect for an object-descriptor-model spec, or
split into sub-issues (struct-writeback mirror; descriptor attributes; freeze/seal
enforcement; wrapper valueOf). The current single "medium / localized to
object-ops.ts" framing is not achievable — `compileObjectAssign` does not exist;
assign already delegates to host `__object_assign` (correct for plain objects).
