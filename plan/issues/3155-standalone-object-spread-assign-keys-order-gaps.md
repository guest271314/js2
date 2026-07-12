---
id: 3155
title: "standalone: object spread / Object.assign / Object.keys-values order + object→primitive gaps (unmasked by the #86 vacuous-standalone audit)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [86, 2131, 2746, 2804]
origin: "#86 {standalone:true}-option-ignored audit (fable-wasm, 2026-07-11) — 3 tests were asserting standalone behavior while vacuously running gc-host; the real standalone lane fails."
loc-budget-allow:
  - src/compiler.ts
---

# #3155 — standalone object spread / assign / key-enumeration gaps

## Source

Surfaced by **#86** (the `{ standalone: true }`-compile-option-ignored audit).
Three test files carried a "standalone" mode that, because the option was
silently dropped, ran the **gc-host** lane and passed vacuously. When #86
converted them to the real `target: "standalone"` lane, they FAIL — revealing
genuine standalone gaps. The standalone modes are now `describe.skip` /
`it.skip` with a pointer here (honest: explicitly pending, not falsely passing);
the host modes keep real coverage.

## Failing on the real standalone lane

- **`tests/issue-2804.test.ts`** — object spread `{ ...a, z }` + `Object.assign`
  copy keys/values, `Object.values`/`Object.getOwnPropertyNames`/`for-in`
  consistency. Fails with `TypeError: Cannot convert object to primitive value`
  and empty/mis-read key sets on standalone.
- **`tests/issue-2746.test.ts`** — `Object.keys` own-key listing paths.
- **`tests/issue-2131.test.ts`** — integer-key enumeration order
  (`Object.keys(o).join(",")` → `"1,2,b,a"`); the standalone `.join` / key
  read path fails ("Cannot convert object to primitive value").

## Root-cause hypothesis (to verify)

Two clusters, both standalone-only:

1. **object → primitive** — `Object.keys(o).join(",")` / template-literal on a
   standalone object array trips `Cannot convert object to primitive value`
   (the native ToPrimitive / string-coercion path for the key array or its
   elements is not wired standalone). Likely shares a root with the #2160 /
   #2358 standalone ToPrimitive substrate.
2. **key enumeration fidelity** — `Object.keys` / `Object.values` /
   `Object.assign` on a dynamic `$Object` return empty / mis-ordered sets
   standalone (integer-key canonical order, insertion order). Likely the
   dynamic `$Object` own-key walk (#2162 substrate family).

## Acceptance

- The `describe.skip` / `it.skip` standalone modes in issue-2804 / 2746 / 2131
  are re-enabled (`describe`/`it`) and pass on `target: "standalone"` with 0
  regressions.
- `built-ins/Object/{keys,values,assign,getOwnPropertyNames}` + object-spread
  standalone test262 improve (measure).
