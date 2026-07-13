---
id: 3156
title: "IR selector precision: make string .substring / .charCodeAt lowerable (wasm:js-string family) — #3143 flip track"
status: done
assignee: ttraenkler/fable-substr
sprint: 71
created: 2026-07-12
updated: 2026-07-13
completed: 2026-07-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: fix
area: ir, codegen
language_feature: strings
goal: ir-full-coverage
parent: 2855
related: [3143, 3144, 3153, 2955, 1072, 1248, 2124]
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
---

# #3156 — IR: make `s.substring(...)` / `s.charCodeAt(...)` lowerable

Top class from the #3153 post-claim divergence map. The STATIC selector
(`planIrCompilation`) claims functions containing string-receiver
`.substring(...)` / `.charCodeAt(...)`, but `STRING_METHOD_TABLE` in
`src/ir/from-ast.ts` has no entry for either — `lowerStringMethodCall`
returns null and the function demotes POST-CLAIM. Under the #3143 IR-first
flip that demote becomes a hard compile error, so this class must become
either genuinely lowerable or selector-rejected before the flip.

Per the legacy reference:

- **substring, host mode**: `env.string_substring` `(externref, f64, f64) ->
  externref` (registered by `collectStringMethodImports`; substring IS in the
  legacy `STRING_METHODS` table), with the #1248/#2124 missing/undefined-`end`
  → `s.length` default.
- **substring, native mode**: `__str_substring (ref $NativeString, i32, i32)`,
  missing/undefined `end` → `0x7fffffff` sentinel (helper clamps).
- **charCodeAt, host mode**: `wasm:js-string.charCodeAt` builtin
  `(externref, i32) -> i32` + `length` builtin, bounds-guarded
  (`idx >= 0 && idx < len ? f64(cc) : NaN`, §22.1.3.3). Bare-name
  `resolveFunc` lookup collides with user functions named `charCodeAt`
  (#1072) — needs a `jsStringImports`-backed resolver variant.
- **charCodeAt, native mode**: legacy inlines flatten + `array.get_u` +
  bounds guard (string-ops.ts arm) — assess in-slice; plan-demote if not
  cleanly expressible.

## Implementation (landed by this issue's PR)

Route (a) — genuinely lowerable, BOTH modes, whole method family arity range:

- `src/ir/from-ast.ts` — `STRING_METHOD_TABLE` gains `substring`
  (`hostArgs [f64,f64]`, result string, `requiredArgs 0`) and `charCodeAt`
  (`hostArgs [f64]`, result f64-val, `requiredArgs 0`). Pad-loop arms:
  `charcode-zero` (omitted position → i32 0, both modes),
  `native-substring` (start → i32 0, end → i32 0x7fffffff — `__str_substring`
  clamps, the legacy native sentinel), and the #1248 host length-default arm
  extended from `slice` to `substring` (padding 0 would trigger the spec's
  start/end SWAP and return the wrong prefix).
- `src/ir/integration.ts` — `stringMethodPlan` arms for both methods;
  `resolveFunc` materializes the guarded helpers on demand;
  `preregisterStringSupport` walk extended to (1) detect
  `call __jsstr_charCodeAt` so `addStringImports` runs before Phase-3
  emission even for literal-free functions, (2) walk `if`/`try` nested
  instruction buffers (pre-existing gap).
- `src/codegen/char-code-at-helpers.ts` (new) — `ensureHostCharCodeAtGuarded`
  (`__jsstr_charCodeAt (externref, i32) -> f64`, wraps the `wasm:js-string`
  `charCodeAt`/`length` builtins — read via `ctx.jsStringImports`, the #1072
  shadowing-safe registry — in the §22.1.3.3 bounds guard; the raw builtin
  traps out of range, #2003) and `ensureNativeCharCodeAtHelper`
  (`__str_charCodeAt (ref $AnyString, i32) -> f64`, flatten + guard +
  `array.get_u`, mirroring the legacy native inline arm). Both follow the
  `ensureFmod` append-only defined-function discipline.
- `tests/issue-3156.test.ts` — 17 cases × {host, standalone}: dual-run
  equivalence vs `experimentalIR: false` + JS oracle, AND
  `irPostClaimErrors === []` (the load-bearing #3143 assertion).

## Grounding notes

- Correction to the #3153 map: host-mode `substring` does NOT lower via the
  `wasm:js-string.substring` builtin in the legacy method-call arm — it rides
  the generic `env.string_substring` import `(externref, f64, f64) ->
  externref` (substring IS in the legacy `STRING_METHODS` table; registered
  by `collectStringMethodImports` for any string-receiver use, independent of
  IR claim). Only `charCodeAt` uses the wasm:js-string builtin family, and
  only there does the #1072 bare-name `resolveFunc` collision bite.
- Native helpers (`__str_substring`/`__str_slice`) take `(ref $AnyString)`
  and flatten internally (`wrapBodyWithFlatten`) — the "flat receiver"
  concern from the map does not require from-ast-side flatten insertion.
- Explicit-`undefined` end args (`s.substring(1, undefined)`, #2124) never
  reach from-ast: the selector rejects `undefined` (unresolvable identifier)
  at claim time, so that shape safely stays legacy.
- Residual post-claim throws kept (parity with slice/charAt, all narrow):
  arg counts above table arity (extra-args-evaluated-for-side-effects), and
  lower-time resolver misses when the legacy scan didn't register the
  backing import/helpers.

