---
id: 1809
title: "late-import shift walker misses method-trampoline funcIdx pointing at import (#1525b regression)"
status: done
created: 2026-06-03
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: compiler-correctness
sprint: 59
related: [1525, 1669]
---
# #1809 — method-trampoline shift walker misses import funcIdx (#1525b regression)

## Symptom

**157 default-lane test262 tests** fail at compile time with an internal codegen
assertion that names its own cause:

```
L1:30 Codegen error: pendingMethodTrampolines: methodFuncIdx 30 points at
import "resizeTo" — shift walker missed this entry (#1525b regression)
```

The `(#1525b regression)` tag is the compiler self-citing the change that
introduced it — #1525b (done; "ToPrimitive residuals — trampoline funcIdx shift
+ ref→f64 NaN paths", task #240). That work added a shift walker that rewrites
method-trampoline `methodFuncIdx` values when late imports shift function
indices, but it misses entries whose `methodFuncIdx` resolves to an **import**
(e.g. the resizable-buffer host helper `resizeTo`). The guard then throws rather
than silently emitting a wrong index — so it's a hard compile error, not invalid
Wasm.

Discovered by `/harvest-errors` against the fresh baselines-repo run
(`loopdive/js2wasm-baselines`, gitHash `f52502e9`, 2026-06-03). It lived in the
`other` error_category, which is why the first harvest pass (which bucketed only
the named crash categories) missed it.

## Root cause (confirmed 2026-06-04)

It is **not** a shift-walker miss. The captured `methodFuncIdx` pointed at a host
import **from the start** — the index was never a defined function, so no shift
would have moved it into defined-function space.

The trigger is `compileIdentifier` in `src/codegen/expressions/identifiers.ts`.
When a bare identifier is used as a *value* (not called) and
`ctx.funcMap.get(name)` resolves to a **host import** — e.g. the ambient DOM
global `resizeTo`/`resizeBy` from lib.dom.d.ts, or the `wasm:js-string.length`
builtin — the func-ref closure path (`emitCachedFuncClosureAccess` /
`emitFuncRefAsClosure`) built a cached/per-site closure trampoline whose
forwarding body does `call <import index>` and whose `pendingMethodTrampolines`
entry captured that import index as `methodFuncIdx`. A host import has no
in-module body to forward to via `ref.func`, so this is always wrong; the
captured index later trips the `finalizeMethodTrampolines` guard in
`src/codegen/closures.ts` with the hard compile error above.

The resizable-ArrayBuffer harness (`resizableArrayBufferUtils.js`) declares a
test-local `let resizeTo;` whose name collides with the ambient DOM global; a
reference to it that the local/capture machinery didn't resolve fell through to
the funcMap path, which matched the DOM-global import.

## Not the same as #1669

#1669 (done) was trampoline **argument coercion** producing *invalid Wasm*
inside `__obj_meth_tramp_*`. This is the **bare-identifier-as-value** path
wrapping a host import in a func-ref closure — a different stage and a different
failure mode (hard assertion, not invalid Wasm).

## Fix

`src/codegen/expressions/identifiers.ts` — gate the func-ref closure path on
`funcRefIdx >= ctx.numImportFuncs`. Only DEFINED functions (which have an
in-module body to forward to) are wrapped in a cached/per-site closure; when the
funcMap entry resolves to an import the identifier falls through to the
type-appropriate graceful default below (valid Wasm, no spurious throw). The
#1340/#1394 cached-closure-identity feature for user-defined functions is
unaffected (those indices are always `>= numImportFuncs`).

## Acceptance criteria

- [x] The func-ref closure path handles names that resolve to imports (skips
      them — no spurious throw).
- [x] The 157 affected tests no longer hit
      `pendingMethodTrampolines … shift walker missed this`.
- [x] No new invalid-Wasm regressions in the object-method trampoline path
      (guard against re-introducing #1669).

## Test Results

Repro confirmed against current main (`c06d4620d`): the three representative
files threw the `shift walker missed this entry (#1525b regression)` compile
error pre-fix and compile to valid Wasm post-fix.

Cluster scan over the affected directories (4,146 test262 files across
`built-ins/Array/prototype/{map,reduceRight,forEach,filter}`,
`built-ins/TypedArray/prototype/map`, `language/expressions/class/dstr`,
`language/statements/for-await-of`):

| metric | pre-fix | post-fix |
|--------|--------:|---------:|
| `shift walker missed` CE | present | **0** |
| compiles OK | — | 3,912 |
| unrelated pre-existing CE | — | 234 |

Unit test: `tests/issue-1809.test.ts` — compiles the three reproducer files via
the runner's `wrapTest`, asserting the `shift walker missed` / `points at import`
strings never appear, plus a guard that a user-defined function used as a value
is still wrapped as a closure (#1340). 4/4 pass.

Regression: `tests/issue-1340.test.ts` + `tests/issue-1394.test.ts`
(cached-closure-identity) — 11/11 pass. `tests/equivalence/` suite — no new
failures attributable to this change.

## Notes

Surfaced by `/harvest-errors` 2026-06-03. The harvest's default-lane
`#NNNN`-citation extraction surfaces this as "#1525: 157" — the error embeds
`#1525b`. Re-harvest after the fix to confirm the cluster clears.
