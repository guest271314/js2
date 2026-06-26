---
id: 2689
title: "ESLint source-code.js: SourceCode_new return_call tail-call type error"
status: done
created: 2026-06-26
completed: 2026-06-26
assignee: ttraenkler/sendev-eslint
priority: medium
area: codegen
goal: npm-library-support
feasibility: medium
related: [1573]
---
# ESLint source-code.js — SourceCode_new return_call tail-call type error

Carved from the de-staled #1573 ESLint survey (bug C). The stale sprint-53
matrix recorded a `global.set externref into f64` error here; the substrate
work since then changed the first-error to a tail-call type mismatch.

> **FIXED 2026-06-26.** Root cause was NOT in the tail-call lowering itself —
> it was a **late-import index desync**. `addIteratorImports` (and its siblings
> `addArrayIteratorImports` / `addGeneratorImports` / `addForInImports`) added
> their host imports via raw `addImport`, which bumps `numImportFuncs` WITHOUT
> shifting already-baked defined-function `funcIdx` values. These adders run
> LAZILY on the first `for-of` / array-iterator / for-in / generator compiled —
> which in `source-code.js` happened AFTER `SourceCode_new` baked
> `return_call SourceCode_init` (#1965 alloc + tail-call-init split). So
> `SourceCode_init` slid 9 slots up while the baked `return_call` stayed put,
> ending up pointed at the `__iterator_next` IMPORT → "return_call: tail call
> type error". The same desync also produced the follow-on "not enough
> arguments on the stack for call" in `SourceCode_applyLanguageOptions`. **Fix
> (src/codegen/index.ts):** route all four lazy import-adders through
> `ensureLateImport` + an immediate `flushLateImportShifts`. The flushed batch
> shift repairs already-baked funcIdx in the LATE context and is a clean no-op
> EARLY (collect-finalize) — without leaving a deferred shift that would later
> over-shift functions registered after the imports.
> `source-code.js` now fully validates. Regression test: `tests/issue-2689.test.ts`.

## Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = await compileProject(
  "/workspace/node_modules/eslint/lib/languages/js/source-code/source-code.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                      // passes
expect(WebAssembly.validate(r.binary)).toBe(true); // FAILS
```

## Error (current main, eslint 10.0.3)
```
function #63 "SourceCode_new":
  return_call: tail call type error
```

## Root cause (to investigate)
`return_call` / `return_call_ref` is emitted for a call in return position
(tail-call optimization). The callee's result type does not match
`SourceCode_new`'s declared result type, so the tail call is ill-typed. Likely
the constructor returns via a tail call whose callee result (e.g. an externref
or a wider/narrower struct ref) differs from the ctor's `(result externref)`.

## Fix direction
In the return-position tail-call lowering (`return_call`/`return_call_ref`,
grep `return_call` in `src/codegen/`), verify the callee result type matches
the enclosing function's result type before choosing the tail-call form; fall
back to a regular `call` + coercion + `return` when they differ. Start by
decoding `SourceCode_new`'s WAT (binaryen `wasm-dis`) to find the offending
tail call.

## Bug class
CODEGEN — tail-call return-type matching.
