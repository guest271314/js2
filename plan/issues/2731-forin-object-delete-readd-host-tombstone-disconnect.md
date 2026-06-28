---
id: 2731
title: "for-in/$Object: delete routes to host __delete_property tombstone disconnected from native $Object storage — delete+re-add never re-appears"
status: done
sprint: Backlog
goal: test262-conformance
feasibility: hard
depends_on: []
priority: high
es_edition: ES5
language_feature: for-in
task_type: bug
created: 2026-06-26
updated: 2026-06-28
completed: 2026-06-27
---

> **DONE (PO reconcile 2026-06-28, as of #2199).** Closed by **PR #2170**
> (`fix(#2731): symmetric delete-aware property write routing`, merged
> 2026-06-27, commit `3aadd4a4`) — the file was left `status: ready` because the
> authoring dev did not flip it post-merge (the classic merged-but-ready drift the
> reconciler surfaced). PR #2170 implemented the architect spec's **PART 1**
> (codegen `tryEmitDeleteAwareDynamicSet` → reroute the re-add write through
> `__extern_set_strict`/`_safeSet`, clearing the tombstone) **and PART 2** (runtime
> `_wasmStructShadowedFields` so a deleted-then-readded field enumerates at
> insertion-order END), **host-mode** scope, with the gate deliberately widened to
> shape-inferred object literals (which is what the actual test262 cases use).
> `#1830` (integer-index keys) landed separately. Scoped acceptance met:
> `delete o.x; o.x=9` re-appears (`o.x===9`, `"x" in o`, enumerated last);
> `order-simple-object → 0,1,2,p2,p4,p1`. **The standalone delete-without-readd
> tombstone gap was explicitly de-scoped to the #2580 substrate / a follow-up — do
> NOT reopen #2731 for it.**

# #2731 — $Object delete tombstone is disconnected from native storage (delete+re-add never re-appears)

## Problem

A property that is **deleted then re-assigned** on a dynamic object never
re-appears in for-in / `Object.keys` / `in`. Minimal repro (host mode, current
`origin/main`):

```ts
const o: any = {}; o.x = 1; o.y = 2;
delete o.x; o.x = 9;
let s = ""; for (const k in o) s += k + ",";   // → "y,"   (expected "y,x,")
```

```ts
const o: any = { a: 1, b: 2 };
delete o.a; o.a = 9;
// 'a' in o  → false   (expected true)
// o.a       → undefined (expected 9)
```

Spec: §10.1.6.3 OrdinaryDefineOwnProperty / §7.3.x — re-adding a previously
deleted property creates it fresh (at the end of insertion order), readable and
enumerable.

## Root cause (verified by instrumentation, esch 2026-06-26)

Split out of #2706. For a native `$Object` (`const o: any = {…}`):

- Property **writes and for-in enumeration are entirely Wasm-native**
  (`src/codegen-linear/object-runtime.ts` — the `$Object` representation). The
  repro module requests **no** `__extern_set` host import; the only host import
  it requests is `__delete_property`.
- But `delete` routes through the **host `__delete_property` import**
  (`src/runtime.ts` ~`name === "__delete_property"`), which records a host-side
  tombstone in `_wasmStructDeletedKeys` and a host sidecar (`_wasmStructProps`)
  — **state that is disconnected from the native `$Object`'s own key storage.**
- A re-add (`o.x = 9`) is a **native Wasm write** that never goes through
  `_safeSet` (where the tombstone-clear lives) and never touches the host
  tombstone. So the host tombstone stays set and the key remains suppressed in
  every host-mediated read/enumerate, even though the native `$Object` holds it.

So the host delete-tombstone and the native `$Object` storage are two sources of
truth that diverge the moment a deleted key is re-added.

## Why this is architecture-scope (route to architect)

This is a **host/wasm-boundary representation defect**, not a localized runtime.ts
patch. The fix must unify the delete/re-add path with the native `$Object`
storage — either:
- route `delete` for a native `$Object` through the **native** object-runtime
  delete (so delete + re-add are both native and consistent), or
- make the native re-add path clear the host tombstone / re-sync the host sidecar.

It overlaps the **value-representation substrate work (#2580 / #2660)** — the
`$Object` reader/writer substrate is the same machinery. Sequence after / with
that substrate rather than bolting a second patch onto the host side.

## Failing tests (blocked by this)

These five `for-in` tests need BOTH the #1830 integer-key fix (landed separately)
AND this delete/re-add fix; #1830 alone closes 0 of them:

```
test/language/statements/for-in/order-simple-object.js
test/language/statements/for-in/order-property-on-prototype.js
test/language/statements/for-in/order-after-define-property.js
test/language/statements/for-in/S12.6.4_A6.js
test/language/statements/for-in/S12.6.4_A6.1.js
```

(e.g. `order-simple-object` improves with the #1830 fix from fully-wrong to
`0,1,2,p2,p4` — missing only the re-added `p1`, which this bug suppresses.)

## Acceptance criteria

`delete o.k; o.k = v` makes `k` readable (`o.k === v`), present (`"k" in o`), and
enumerable at the END of insertion order, for native `$Object` receivers, in both
host and standalone modes. No regression in delete / for-in / Object.keys. The
five `for-in` order tests above pass (with #1830 also landed).

## Notes

- Split from #2706 (which is now `blocked` on this). #2706's #1830 half is landed
  separately as `fix(#1830)`.
- Route to **architect** for a spec; overlaps #2580 / #2660 substrate.

## Implementation Plan (architect, verified on origin/main @ 5a92381, 2026-06-27)

### Root cause — RE-VERIFIED, the issue's framing is imprecise

The repro receiver is **NOT** a native `$Object` open-hashmap. It is a
**shape-inferred NOMINAL anon struct**. There is no
`src/codegen-linear/object-runtime.ts` (the native open-object `$Object` runtime
is `src/codegen/object-runtime.ts` and is gated **standalone-only**). Verified by
compiling repro 1 in host mode:

```
(type $__anon_0 (struct (field $x (mut f64)) (field $y (mut f64))))
```

`o.x = 1` / `o.y = 2` are native `struct.set`; `delete o.x` is `__delete_property`
(host); `for-in` is host `__for_in_keys`/`__for_in_has`. The **real** disconnect
is an asymmetry the `moduleUsesDelete` pre-scan introduced (#2179):

- When the module contains a member-`delete`, `ctx.moduleUsesDelete` is set
  (`src/codegen/index.ts:1075`, `sourceContainsDelete` ~303). This routes
  `any`/`unknown`-receiver property **READS** through the tombstone-aware host
  `__extern_get` via `tryEmitDeleteAwareDynamicGet`
  (`src/codegen/property-access.ts:2148`, called at ~2412). **Correct.**
- But the corresponding **WRITE** path has **no symmetric gate** — `o.x = 9`
  still takes the native `struct.set` fast-path (the `__set_member_<name>`
  dispatcher built by `emitAlternateStructSetDispatch`,
  `src/codegen/property-access.ts:1282`; its native struct.set arm STOPS, it does
  not fall to the `__extern_set_strict` else-arm). The native write **bypasses
  `_safeSet`** (`src/runtime.ts:4216`), where the tombstone-clear lives
  (`runtime.ts:4245-4248`, `tomb.delete(key)`).

So `delete o.x` (host `__delete_property`, `runtime.ts:10606` → sets
`_wasmStructDeletedKeys` tombstone + clears native field to its sentinel) followed
by a native `struct.set` re-add leaves the host tombstone **set**. Every
tombstone-consulting reader then suppresses the re-added key:
`__extern_get` (`runtime.ts:4118`), `_wasmStructHasOwn` (`3176`),
`__for_in_has` per-visit liveness (`10806`), `__object_keys/values/entries`
(`8409/8431/8456`).

**Verified buggy outputs (host mode, current main)** via `compileAndInstantiate`:
- repro 1 for-in → `"y,"` (expected `"y,x,"`)
- repro 2 `"a" in o` → `false` (expected `true`)
- repro 2 `o.a` → `NaN` (expected `9`)

Trace proof: instrumenting the host env helpers shows the re-add `o.a = 9` calls
**no** host setter (it is native `struct.set`); only `__delete_property(o,"a")`
then `__extern_get(o,"a") → undefined` fire. Routing the SAME re-add through the
host (computed key `o[k]=9` → `__extern_set_strict` → `_safeSet`) already returns
`9` / `true` — proving the fix direction (reconnect the re-add to `_safeSet`).

### Fix — two coordinated parts (HOST mode; standalone is a separate sub-case, below)

#### PART 1 — Codegen: symmetric tombstone-aware WRITE routing (the reconnection)

**File: `src/codegen/property-access.ts`**

Add `tryEmitDeleteAwareDynamicSet`, the mirror of `tryEmitDeleteAwareDynamicGet`
(~2148). Gate identically: `ctx.moduleUsesDelete && !ctx.standalone`, receiver
type is `any`/`unknown` (`ts.TypeFlags.Any | ts.TypeFlags.Unknown`), `propName`
is not a reserved accessor (`length`/`constructor`/`__proto__`/`prototype`/`name`),
and the access is not method/function-typed. When it fires, **skip** the native
`emitAlternateStructSetDispatch` struct.set fast-path and emit the receiver +
boxed value + `ensureLateImport(ctx, "__extern_set_strict", [externref, externref,
externref?], [])` (use the SAME strict setter the dispatcher's else-arm uses; ESM
is strict). Call this gate from the property-**assignment** lowering at the point
where it currently decides to call `emitAlternateStructSetDispatch` (the
`compileAssignment` property-access arm; the dispatcher's caller). Return a
handled sentinel so the caller does not also emit the native dispatcher.

Effect: the re-add flows through `_safeSet`, which (today) clears the tombstone
(`4247`), writes the sidecar (`4357`), and mirrors the native field via
`__sset_<key>` (`4334-4351`). This alone fixes repro 2 (`o.a===9`, `"a" in o`) and
makes the key re-appear in for-in — but at its **struct-shape position**, not the
spec-required insertion-order END. PART 2 fixes the order.

Perf note: this routes ALL `any`-receiver writes in delete-using modules through
the host (matching the read side, which already does). Delete-free modules are
unaffected (`moduleUsesDelete` false → byte-identical). Acceptable.

#### PART 2 — Runtime: enumerate a deleted-then-readded field at insertion-order END

The 5 for-in tests require the re-added key LAST, e.g. `order-simple-object`
expects `['0','1','2','p2','p4','p1']` (deleted+readded `p1` at the end). The
struct shape is fixed-order, so the re-added field must be enumerated from the
**sidecar** (insertion-ordered) and excluded from its struct position — but ONLY
when it was deleted (plain re-assignment of a never-deleted field must keep its
struct position). Use a persistent marker that only `delete`+re-add sets.

**File: `src/runtime.ts`**

1. Add `const _wasmStructShadowedFields = new WeakMap<object, Set<string>>();`
   (near `_wasmStructDeletedKeys`, ~571). "Struct-shape fields that were
   deleted-then-readded, so their live value lives in the sidecar and they must be
   enumerated from the sidecar (insertion end), not their struct-shape slot."

2. In `_safeSet` (`4216`), at the existing tombstone block (`4245-4248`): capture
   `const wasTombstoned = !!tomb && tomb.has(k)` BEFORE clearing. If
   `wasTombstoned` AND `k` is a struct-shape field
   (`_getStructFieldNames(obj, exports ?? callbackState?.getExports())?.includes(k)`),
   then `shadowed.add(k)` in `_wasmStructShadowedFields(obj)`. Keep the existing
   `tomb.delete(k)` clear and the sidecar write — presence/value readers stay
   correct and UNCHANGED (lower regression risk).

3. In `__for_in_keys` (`runtime.ts:10730-10734`), the struct-shape loop: **skip**
   any field in `_wasmStructShadowedFields(current)` (so the re-added field is not
   emitted at its struct slot). The existing sidecar loop (`10736-10748`) then adds
   it at the end (the sidecar JS object preserves re-insertion order from
   `_safeSet`'s `_sidecarSet`), and `_orderOwnKeysSpec` (integers-first) + the
   per-visit `__for_in_has` place it correctly.

Worked trace (design validated against the existing readers):
`o={x,y}`, `delete o.x` → tomb={x}, sidecar drops x; `o.x=9` → `_safeSet`:
`wasTombstoned && x∈shape` → shadowed={x}, clear tomb, sidecar re-inserts x at end
({y,x}). `__for_in_keys`: struct loop emits y (x skipped via shadowed); sidecar
loop appends x → `[y,x]` → **"y,x,"**. ✓ `order-simple-object`: p1 deleted+readded
→ shadowed; struct loop skips p1,p3 (p3 tombstoned via `__for_in_has`); sidecar
appends p1 after p4 → `0,1,2,p2,p4,p1`. ✓

4. **No-regression for Object.keys/values/entries**: `__object_keys/values/entries`
   (`8398-8469`) currently filter tombstoned struct fields but do **not** merge the
   sidecar at all. The 5 for-in tests use `__for_in_keys` only, so PART 2 above is
   sufficient for acceptance. Add the same `_wasmStructShadowedFields` skip in these
   three filters so a shadowed field is not double-counted, and verify on the
   `merge_group` floor whether the (pre-existing) sidecar-merge gap in these paths
   needs a follow-up. Do NOT expand scope here.

### Standalone mode — separate sub-case, scope OUT of this issue

Verified: the repro compiles in `--target standalone` with **zero imports** (pure
native nominal struct). There is no host tombstone — `delete o.x` only clears the
field to its sentinel and the native `__delete_property` (object-runtime.ts, for
`$Object`) is a no-op on a nominal struct (`ref.test $Object` false). So standalone
has the OPPOSITE profile: delete+re-add "works" (native field holds the value) but
a delete WITHOUT re-add still enumerates (no tombstone to suppress it, since
`__struct_field_names` returns the full shape). That is a distinct native-tombstone
gap — track it under the #2580 substrate / a follow-up, NOT here. Scope #2731's
acceptance to **host mode** (the verified repro). Note this in the issue's
"both host and standalone modes" criterion — only host is in scope for this PR.

### Wasm / host patterns
- PART 1 write routing: `local.get <recvExt>; local.get <valExt(boxed externref)>;
  call $__extern_set_strict` — exactly the dispatcher's existing strict else-arm
  (`emitAlternateStructSetDispatch` terminal arm), just taken unconditionally for
  `any` receivers under `moduleUsesDelete`.
- No new host import is needed (`__extern_set_strict` already exists; `_safeSet`
  already clears the tombstone + writes sidecar + mirrors the native field).

### Edge cases
- Plain re-assign of a never-deleted struct field (`o.y = 5`): `_safeSet`
  `wasTombstoned` is false → NOT shadowed → stays at struct position. ✓
- Delete WITHOUT re-add (`delete o.x` only): tomb set, not shadowed, not in
  sidecar → `__for_in_has` suppresses it (absent). ✓ No change.
- Sidecar-only dynamic key delete+re-add (`o.dyn=1; delete o.dyn; o.dyn=2`):
  not a struct-shape field → not shadowed; the existing sidecar re-insert already
  orders it at the end. ✓ (shadowed-set only matters for struct-shape fields.)
- `delete o.x; o.x = undefined` (re-add with `undefined`): the value goes to the
  sidecar as `undefined`; `"x" in o` true (HasProperty is value-independent), `o.x`
  reads `undefined`, x enumerates at end. ✓
- Untouched native fields still read through `__extern_get` correctly in
  delete-modules (verified `o.b → 2`), so routing writes to the sidecar does not
  desync reads.

### Validating tests (test262)
- `test/language/statements/for-in/order-simple-object.js` (`['0','1','2','p2','p4','p1']`)
- `test/language/statements/for-in/order-after-define-property.js`
- `test/language/statements/for-in/order-property-on-prototype.js`
- `test/language/statements/for-in/S12.6.4_A6.js`
- `test/language/statements/for-in/S12.6.4_A6.1.js`
- All five need BOTH the #1830 integer-key fix (landed) AND this PR.
- Local equivalence probes (host mode) — must pass after the fix:
  - repro 1 for-in `"y,x,"`; repro 2 `"a" in o === true`, `o.a === 9`.
- **Validate on the full `merge_group` floor** (broad host-mode object-model
  surface): the read-gate sibling (#2179) and the `__object_keys` family are the
  regression-prone neighbours.
