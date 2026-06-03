---
id: 1785
title: "late-import shift walker misses method-trampoline funcIdx pointing at import (#1525b regression)"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: compiler-correctness
sprint: Backlog
related: [1525, 1669]
---
# #1785 — method-trampoline shift walker misses import funcIdx (#1525b regression)

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

## Not the same as #1669

#1669 (done) was trampoline **argument coercion** producing *invalid Wasm*
inside `__obj_meth_tramp_*`. This is the **late-import index-shift walker**
(the `addUnionImports` machinery in `src/codegen/index.ts` /
`src/codegen/expressions/late-imports.ts`) failing to update a trampoline
funcIdx that targets an import — a different stage and a different failure mode
(hard assertion, not invalid Wasm).

## Affected surface (157, top dirs)

| Count | Path prefix |
|------:|-------------|
| 33 | `built-ins/Array/prototype/*` (esp. resizable-buffer-{grow,shrink}-mid-iteration) |
| 26 | `language/statements/class/*` |
| 24 | `language/expressions/class/*` |
| 20 | `language/statements/for-await-of/*` |
| 12 | `built-ins/TypedArray/prototype/*` |

Representative samples:
- `built-ins/Array/prototype/map/resizable-buffer-grow-mid-iteration.js`
- `built-ins/Array/prototype/reduceRight/resizable-buffer-shrink-mid-iteration.js`
- `language/expressions/class/dstr/gen-meth-static-ary-ptrn-rest-obj-prop-id.js`

The common trigger is a method trampoline whose `methodFuncIdx` lands on a host
import after late-import insertion shifts indices.

## Where to look

- `src/codegen/index.ts` — `addUnionImports` and the `pendingMethodTrampolines`
  shift walker (the throw site).
- `src/codegen/expressions/late-imports.ts` — late-import insertion / index
  rewrite.
- The walker must also rewrite (or correctly leave) `methodFuncIdx` entries that
  resolve to imports, instead of asserting they were missed.

## Acceptance criteria

- [ ] The shift walker handles method-trampoline `methodFuncIdx` values that
      point at imports (rewrite or correctly skip — no spurious throw).
- [ ] The 157 affected tests no longer hit
      `pendingMethodTrampolines … shift walker missed this`.
- [ ] No new invalid-Wasm regressions in the object-method trampoline path
      (guard against re-introducing #1669).

## Notes

Surfaced by `/harvest-errors` 2026-06-03. The harvest's default-lane
`#NNNN`-citation extraction surfaces this as "#1525: 157" — the error embeds
`#1525b`. Re-harvest after the fix to confirm the cluster clears.
