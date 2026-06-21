---
name: project_standalone_any_string_value_read_substrate
description: Standalone $Object dynamic (any-typed) reader drops native-string VALUES — unified root cause behind many s64 standalone gaps; senior-dev/value-rep
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

**Unified root cause (found 2026-06-21, dev-anita full-language harvest):** under
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
