---
id: 3154
title: "IR selector precision: make string .substring / .charCodeAt lowerable (wasm:js-string family) — #3143 flip track"
status: in-progress
assignee: ttraenkler/fable-substr
sprint: current
created: 2026-07-12
updated: 2026-07-12
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
---

# #3154 — IR: make `s.substring(...)` / `s.charCodeAt(...)` lowerable

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

## Work log

(see PR)
