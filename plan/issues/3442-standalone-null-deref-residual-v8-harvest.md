---
id: 3442
title: "standalone: null-deref residual (789 gap tests) — general __module_init + sync destructuring-rest traps, no open tracker"
status: ready
created: 2026-07-19
priority: high
task_type: bug
area: standalone
goal: standalone-mode
model: fable
sprint: current
horizon: m
related: [1781, 2865, 3387, 647]
---

# #3442 — standalone null-deref residual (v8 harvest, 2026-07-19)

## Summary

Harvesting the 2026-07-19 standalone baseline (`test262-standalone-current.jsonl`,
oracle v8) and computing the honest host↔standalone gap
(`host_pass ∧ ¬standalone_pass`, official) surfaced **789 gap tests** with
`error_category: null_deref` — standalone modules that **compile** but trap
`dereferencing a null pointer` at runtime, where the JS-host lane passes. These
are **genuine standalone-codegen bugs**, NOT host-import refusals (no
`host imports` / `not supported in standalone` string).

The historical residual null-pointer buckets (#647, #441, #526, #566) are all
`status: done` — none is an **open** tracker for the current v8 baseline. #2865
(in-progress) owns the async-generator/for-await **carrier** subset; this issue
owns the remaining ~600 non-async-carrier residual.

## Sub-buckets (normalized signature within the 789 gap tests)

| signature | count | owner |
| --- | ---: | --- |
| `dereferencing a null pointer [in __module_init()]` (general: top-level dstr, RegExp, arrow) | 365 | **this issue** |
| `... [in __async_resume_f*() ← __async_gen_next_* ← __module_init]` (async-gen/for-await rest dstr) | ~190 | #2865 (in-progress) |
| `... [in C_method() / C___priv_method() / __anonClass_*___priv_method()]` (sync class-method array/obj rest dstr) | ~135 | **this issue** |

The class-method + general cluster is dominated by **array/object destructuring
rest patterns** (`ary-ptrn-rest`, `obj-ptrn-rest`) in class methods and top-level
code — a null struct dereferenced during the rest-collection iterator drain.

## Sample paths

- `test/built-ins/RegExp/S15.10.2.8_A3_T15.js` (general `__module_init`)
- `test/language/statements/variable/dstr/ary-ptrn-elem-ary-rest-iter.js` (top-level rest dstr)
- `test/language/statements/class/dstr/meth-ary-ptrn-rest-ary-rest.js` (class-method rest dstr)

## Root cause (hypothesis)

The standalone destructuring lowering allocates the rest-array / iterator-result
struct but a path leaves a field null (the iterator-`done` sentinel or the
collected-rest ref) that a later `struct.get` dereferences. In the JS-host lane
the same read routes through a host import that tolerates the null; standalone's
native path traps. Likely shares the iterator-drain root with the done #2904 /
#2756 destructuring fixes, re-exposed at the class-method / top-level scope under
the v8 harness.

## Suggested fix

1. Reproduce `language/statements/class/dstr/meth-ary-ptrn-rest-ary-rest.js` in
   `--target standalone` and locate the null `struct.get` in `C_method`.
2. Audit the rest-pattern iterator-drain lowering for the null-sentinel guard
   that the done #2904 fix added — confirm it covers class-method + top-level
   scopes, not only param scope.
3. Coordinate with #2865 for the async-resume subset so the carrier fix and the
   sync fix don't diverge.

## Regression note

The done residual buckets (#647/#441/#526/#566) closed at earlier baselines; this
789-count cluster is the current v8-baseline standing surface. Treat as
re-exposure under the real upstream harness (v8 flip #3370), tracked fresh here.
