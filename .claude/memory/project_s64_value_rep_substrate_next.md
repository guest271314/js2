---
name: project_s64_value_rep_substrate_next
description: s64 dev pool drained; next critical-path = standalone $Object dynamic string-value read bug (senior-dev/value-rep)
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

End of sprint 64 (2026-06-21): the **dev-tractable standalone-conformance
pool is genuinely drained**. Both dev-anita and dev-carla independently
harvested fresh failures against pristine upstream/main and converged on a
single root cause that gates essentially all remaining standalone gaps:

**Standalone `$Object` dynamic (`any`-typed) property read DROPS native-string
values.** Numeric reads work; string reads return empty.
- `const o:any={v:7}; o.v` → 7 ✓  ·  `const o:any={v:"hi"}; o.v.length` → 0 ✗
- The dynamic value-reader (`__extern_get` path) doesn't return/unwrap
  native-string values; **typed struct-field reads bypass it and work**
  (`(e as Error).message` → 4 ✓ but `catch(e:any){e.message}` → 0).

This one bug explains the entire residual cluster, which therefore ALL
unblock at once when it's fixed:
- `Object.values` / `Object.entries` / `Object.assign` → empty (values are
  boxed strings)
- `Array.from(Set)` / `Array.from(Map)` / `Array.from(arrayLike)` → 0 / illegal cast
- `Error.message` / `.name` via `catch(e:any)`
- `Symbol.dispose` / `asyncDispose` value-read → blocks the native
  DisposableStack / `using` runtime (#2029 ERM residual)
- object-rest `{a, ...rest}` → "Cannot convert object to primitive"

**Next-sprint priority:** file a focused **senior-dev / value-rep** issue
"standalone `$Object` dynamic property read drops native-string values"
(#1472-adjacent — that issue + #201 read as done but this residual remains).
carla recommends an **architect spec first** — it touches the standalone
object/symbol value model. Other still-open substrate epics: #2552(landed
→ closes #2200), #2158 class/descriptor epic, #2159 owner residuals
(Uint8Array.of/from CE, i8 indexOf emit error), #2029 `__new_<Builtin>`
native construction. Related: [[feedback_dispatch_against_upstream_not_stale_fork]].
