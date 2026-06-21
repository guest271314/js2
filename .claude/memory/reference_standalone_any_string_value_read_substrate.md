---
name: reference_standalone_any_string_value_read_substrate
description: Standalone $Object dynamic (any-typed) property read drops native-string values — the single root cause behind a whole cluster of standalone residuals
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

Standalone (`--target standalone` / nativeStrings) **dynamic `any`-typed property read of a STRING value returns empty**. This single `$Object` value-reader bug (the `__extern_get` dynamic path) is the common root cause behind a large cluster of seemingly-separate standalone residuals.

Minimal repro (verified on upstream/main cb4e9d4d2, 2026-06-21):
- `const o:any={v:7}; o.v` → 7 ✓ (numeric dynamic read works)
- `const o:any={v:"hi"}; o.v.length` → 0 ✗ (string value reads EMPTY)
- `(e as Error).message` → works (typed struct-field read bypasses the dynamic reader); `catch(e:any){ e.message }` → 0 (dynamic path drops the string)

It explains ALL of these at once (do NOT re-mine them as separate dev slices):
- `Error.message`/`.name` read via `catch(e:any)` → empty
- `Object.values`/`Object.entries`/`Object.assign` → empty result (boxed string values dropped)
- `Array.from(new Set(...))` → 0; `Array.from(Map)` / `Array.from(arrayLike)` → illegal cast
- `Symbol.dispose` value-read + DisposableStack `use(value)` (Carla's #2029 block)

Fix is **senior-dev / value-rep scope**: the standalone `$Object` dynamic value-reader must return/unwrap native-string ($AnyString) values, not drop them. Typed reads already work, so the fix is isolated to the dynamic `__extern_get`-style path. Landing it unblocks the whole cluster simultaneously. #1472/#201 are marked done but this residual remains.

Context: the dev-tractable standalone surface is otherwise DRAINED — try/catch/finally, closures, bitwise, bigint, labels, switch, do-while, typed-array element ops, generators, iterators, destructuring, Math/Number/String methods all pass standalone. Shipped dev slices this sprint: #2202 spread arguments (merged), #1633 Array.of standalone, #2160 String.raw-with-substitution. See [[reference_fork_origin_behind_upstream]].
