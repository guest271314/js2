---
name: project_2141_s2_tag5_vacuity_eager_generators
description: "#2141 S2 CORRECTS project_2040_tag5_classifier_dstr_default_regression: the −162 was NOT a dstr eq dependency — eager-buffer generator expressions run bodies at CREATION and the tag-5 comparator vacuity (fake-NaN self-inequality makes isSameValue vacuously true) masked it. Fix = #3032 lazy thunks."
metadata: 
  node_type: memory
  type: project
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

#2141 S2 (2026-07-04, fable-tag5, PR from branch issue-2141-tag5-cluster) — the
"dstr/generator lowering implicitly relied on legacy always-false tag-5 eq"
theory in [[project_2040_tag5_classifier_dstr_default_regression]] is
**DISPROVEN**. WAT trace of the canary
(`language/statements/class/dstr/meth-dflt-ary-ptrn-empty`, standalone): the
ONLY `__any_strict_eq` callers are the test262 harness's three `isSameValue`
sites — nothing in dstr/iterator lowering calls the eq helpers.

Real chain: (1) the dstr fixture `var iter = function*(){iterations+=1}();`
is an anonymous generator EXPRESSION → excluded from native lowering
(`isNativeGeneratorCandidate` needs `decl.name`; the test262 wrapper makes
every generator nested+capturing, #2203) → EAGER-BUFFER path runs the body AT
CREATION → `iterations` is already 1 (probe: read right after the fixture →
1). The tests are latently failing. (2) `isSameValue(a:any,b:any)` params
ride the externref ABI; each operand re-boxes per use via `__any_box_string`
(tag-5 lie). Legacy tag-5 non-string eq = 0 ⇒ lie-boxed values are
SELF-unequal (fake NaN) ⇒ `a===b || (a!==a && b!==b)` is TRUE for EVERY
lie-boxed pair — vacuous pass regardless of values. (3) The classifier's
numeric f64.eq AND object ref.eq arms EACH close the vacuity escape (bisect
re-confirmed) → the −162 is UNMASKING latent failures, not breakage.

Fix (#3032, zero-param wave landed): lazy-first-resume thunks — the eager
sequence is wrapped in `if (global $__gen_eager_mode)`; default returns
`__create_generator(<self closure>, null)`; host detects non-Array arg as
thunk, materializes on first next() via exported `__gen_set_eager` +
`__call_fn_0`, adopts inner state; return/throw before first next never run
the body (§27.5.3.2). Requires consumers to wire `setExports` (existing
closure-interop contract). Byte-inert for everything except zero-param
non-async generator expressions (SHA-verified vs main, both lanes).

Classifier now IN-TREE: `tag5ValueEqClassifier` CompileOption (default OFF;
`JS2WASM_TAG5_CLASSIFIER=1` env defaults on for runner A/B). GATE PITFALL
(sd-3 repeat avoided): never gate the numeric/object arms on string
availability — string-free modules (anyStrTypeIdx<0) omit the string arm;
strings-present-but-no-content-eq falls back to legacy wholesale. Default
flip blocked on #3032 W4 (method generators — `gen-meth-*` residue: 24-sample
flip delta 4 unmaskings / 2 fixes). NEW: mixed-provenance equal numbers
(tag-5 $BoxedNumber × honest tag-2/3) are STILL wrongly unequal — cross-tag
cell, separate slice (#2141 S3c).

Pre-existing (NOT this work): issue-1169f-7a/7b fail 7 tests on origin/main
(ad0b0582c) — IR-vs-legacy yield-sequence pins missing the trailing return
value; and standalone `g.return(42).value` / generator retVal readback
round-trips an opaque $BoxedNumber → `Number(opaque)` throws (#3032 W5).
