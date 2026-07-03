---
id: 3027
title: "standalone: \\$Object dynamic-object-property reader residual — null/undefined property access on unmodeled shapes (~1,552 host-free fails)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: dynamic-object-property-access
goal: standalone-mode
test262_category: language/statements/for-of/dstr, built-ins/AsyncGeneratorFunction, language/statements/variable
test262_fail: 1552
umbrella: 2860
related: [2860, 2861, 2862, 2863]
---

# #3027 — standalone: `$Object` dynamic-object-property reader residual

## Source

Standalone lane test262 harvest, 2026-07-03
(`.test262-cache/test262-standalone-current.jsonl`, run confirmed fresh
against `runs/index.json`). **1,552** official fails with signature
`TypeError: Cannot access property on null or undefined` (1,441 runtime +
111 compile-adjacent), carrying `host_import_leak_class` of `host_import` or
`iterator_protocol` on the subset that also leaks a host import, but the
majority are **pure standalone runtime failures with no import leak at all**
— the dynamic value read returns null/undefined where the js-host lane
(via a host import) returns the correct value.

This matches the **"not-yet-issued follow-on"** explicitly called out in the
#2860 umbrella body: *"`$Object` dynamic-object-property reader
(`__extern_get`/`__extern_rest_object` leak) — ~669 tests. The known
substrate root (`project_standalone_any_string_value_read_substrate`).
Heavily overlaps clusters 2/3 [#2862 ToPrimitive, #2863 dynamic-shape
object/property CE]; revisit after #2862/#2863 land to measure the true
residual."* #2861/#2863 have since landed (`status: done`); this issue is
that promised re-measurement, filed now that the residual (1,552) is
measurably larger than the original ~669 estimate — worth re-scoping as its
own tracked issue rather than an umbrella footnote.

## Sample failing files

- `language/statements/for-of/dstr/array-rest-elision-invalid.js`
- `built-ins/AsyncGeneratorFunction/instance-name.js`
- `language/statements/variable/12.2.1-21-s.js`

## Suggested approach

1. Re-measure the pure (no-import-leak) subset specifically — of the 1,552,
   how many have zero entries in `imports`? That is the count a standalone
   codegen fix flips directly, vs. the count still gated behind an
   unrelated carrier (generators/async-generators, #2864/#2865).
2. Trace one pure repro (e.g. the `variable/12.2.1-21-s.js` sample, which is
   not generator/async-gen-shaped) through the `$Object` dynamic reader path
   referenced in `project_standalone_any_string_value_read_substrate` —
   confirm whether the read returns null for the same reason documented
   there (dynamic reader drops native-string values) or a distinct cause.
3. Cross-check against #2862 (ToPrimitive) and #2863 (dynamic-shape CE) —
   both `done` — to confirm this residual is genuinely downstream of what
   those closed, not an unmeasured pre-existing overlap.

## Acceptance criteria

- The host-free `TypeError: Cannot access property on null or undefined`
  count in the standalone lane drops materially below 1,552.
- The umbrella #2860's "not-yet-issued follow-on" note is updated/removed
  once this issue supersedes it.
