---
name: project_standalone_any_string_value_read_substrate
description: "CORRECTED 2026-07-05: strings NO LONGER dropped by the any-reader (verified on current main). The stale value-drop claim below is HISTORICAL — the live residual is architectural (need a locals-free carrier-uniform member-get primitive), not a value bug."
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

> **⚠️ CORRECTION (2026-07-05, opus-s5-4 re-probe on current main `b4e368b9a`, 7 probes):**
> The value-drop premise below is **STALE / FIXED**. `__extern_get` / the #2580
> dyn-read substrate now **PRESERVE native-string values** in host AND standalone —
> named + static-index + dynamic-index reads all work in legacy. Do NOT cite this
> as a value-drop blocker anymore.
> **The LIVE residual is architectural, not a value bug:** the legacy any-receiver
> read is the whole `compilePropertyAccess` + element-access dispatch tree, not a
> reusable op; the leaf `emitDynGet` (dyn-read.ts) needs `fctx` + real locals +
> mid-emit late-import shift (breaks the readonly `Instr[]` IR-handle contract),
> yields externref (gc `$AnyValue` re-tag impedance), is named-key-only, and has no
> `obj[idx]` path. So the "one focused value-rep change" is now re-aimed from "stop
> dropping strings" (DONE) to **"expose a locals-free, carrier-uniform
> `__dyn_member_get(recv,key)→carrier` primitive"** — the real unblocker for #2949
> S5.4 + S5.P (the IR claim-rate lever). Tracked task allocated 2026-07-05.

**Unified root cause (found 2026-06-21, dev-anita full-language harvest) [HISTORICAL — value-drop since FIXED, see correction above]:** under
`--target standalone`/`nativeStrings`, the **`$Object` dynamic (`any`-typed)
property reader (`__extern_get`) drops native-string VALUES** — it returns empty
for a string-valued property. Numbers read fine; typed struct-field reads bypass
the dynamic reader and work. Minimal repro:

- `const o: any = {v: 7}; o.v` → `7` ✓
- `const o: any = {v: "hi"}; o.v.length` → `0` ✗

This single substrate bug explains a whole cluster of s64 standalone gaps that
look unrelated:
- `catch (e: any) { e.message }` → empty (but `(e as Error).message` works — the
  cast re-types to a struct-field read). [#2192 area]
- `Object.values` / `Object.entries` / `Object.assign` → empty/wrong for
  string-valued props. [#2158 / dev-anita object-value-rep cluster]
- `Array.from(Set/Map)` → 0 / illegal cast.
- `Symbol.dispose` value-read (the foundational op for a native DisposableStack
  runtime) — blocks [[project_fork_origin_behind_upstream_pr_base]]'s #2029
  disposable-stack slice (doc PR #1827 recorded it substrate-blocked).

**Disposition:** the fix is one focused **senior-dev/value-rep** change — the
`$Object` dynamic string-value reader (make `__extern_get` return native-string
values, not drop them). It is NOT a dev slice. Once it lands, the whole cluster
(incl. DisposableStack `use(value)`) unblocks at once. As of 2026-06-21 the
dev-tractable contained standalone surface is otherwise DRAINED (closures, errors,
bitwise, bigint, labels, switch, typedarray, Map/Set, RegExp common surface,
String/Number all pass standalone) — this value-rep substrate is the binding
constraint for further standalone conformance.
