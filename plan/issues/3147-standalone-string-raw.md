---
id: 3147
title: "standalone: String.raw (22 __get_builtin CEs)"
status: done
completed: 2026-07-12
assignee: ttraenkler/fable-close
sprint: 71
priority: high
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984, 2160]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
# (#3102/#3131) intended growth: the String.raw call-site arm in the
# CallExpression dispatcher (+47 — arg lowering + $ObjVec build; the algorithm
# itself lives in the new src/codegen/string-raw.ts subsystem module).
loc-budget-allow:
  - src/codegen/expressions/calls.ts
# (#2108/#3131) NOT a fresh coercion matrix — string-raw.ts DELEGATES to the
# engine's canonical runtime walkers: __extern_toString IS the single §7.1.17
# ToString entry point for externref values (its $Object arm runs
# __to_primitive, which the gate counts from the doc comment). No new
# ToString/ToNumber ordering is defined here.
coercion-sites-allow:
  - src/codegen/string-raw.ts
---

# #3147 — standalone String.raw

## Problem

`String.raw(template, ...substitutions)` used standalone hard-CEs through the
`__get_builtin` dynamic-shape refusal (#1472 Phase B). Measured **22** non-pass
standalone entries under `built-ins/String/raw/`. Note: this is the FUNCTION
`String.raw(obj)` reflective/error-path form (a `cooked`/`raw` ToObject +
length-coercion + string-concat loop); the tagged-template lowering
`String.raw\`...\`` is a separate path (#2510) and already handled — these
tests call `String.raw` as an ordinary function with hand-built objects.

## Sample paths

- `test/built-ins/String/raw/template-length-throws.js`
- `test/built-ins/String/raw/template-raw-not-object-throws.js`
- `test/built-ins/String/raw/return-empty-string-if-length-is-zero-NaN.js`
- `test/built-ins/String/raw/returns-abrupt-from-next-key.js`

## Shared-infra deps

- Needs `String.raw` as a resolvable standalone builtin function with the spec
  §22.1.2.16 algorithm: `ToObject(template.raw)`, `ToLength(len)`, per-index
  `Get` + `ToString` on both raw segments and substitutions, string
  concatenation. Reuses the open-object dynamic `__extern_get` + native string
  concat already present; the error-path tests mostly assert TypeError on a
  non-object `.raw` / abrupt getters.

## Acceptance

- `built-ins/String/raw/*` standalone tests compile + pass with 0 regressions.

## Implementation (2026-07-12, fable-close)

- **`src/codegen/string-raw.ts` (new)** — `ensureStringRawHelper(ctx)` emits a
  pure-Wasm `__string_raw(template: externref, subs: externref) -> ref
  $AnyString` implementing §22.1.2.4 over the open-object runtime:
  - nullish template / nullish `Get(template, "raw")` → catchable TypeError
    (`__new_TypeError` + shared `$exc` tag, same lowering as `__to_primitive`);
    a non-object template degrades to a `raw` miss → the same TypeError.
  - `literalCount = ToLength(Get(raw, "length"))` — delegated to
    `__extern_length`'s #2036 array-like arm (throwing `length` getter
    propagates; NaN/negative/missing → 0 → `""`); real arrays use the vec arm.
  - loop: `__extern_get_idx` (accessor-aware canonical-decimal-key get) +
    `__extern_toString` (§7.1.17 — `$Object` reduces via
    `__to_primitive(v, "string")`, so user `toString` runs and abrupt
    completions propagate) + `__str_concat`. Substitutions past
    `literalCount-1` are never touched (their `toString` must NOT run).
  - null externref pre-guard → `"null"` (§7.1.17-correct under the #2106 S1
    singleton regime; strictly closer than the legacy residual
    `"[object Object]"` under the collapsed flag-off regime).
  - `$Symbol` carrier segment/substitution → TypeError (§7.1.17) —
    future-proofing: standalone symbols are not yet honest carriers in the
    open-`any` plane (see residuals below).
- **`src/codegen/expressions/calls.ts`** — standalone-gated arm in the
  CallExpression dispatcher (`String` identifier + `.raw`, no spread):
  evaluates template + substitutions in order into an `$ObjVec`
  (`__objvec_new`/`__objvec_push`), calls `__string_raw`, returns the native
  string type. Host mode untouched (keeps the `__get_builtin` route).
- **`tests/issue-3147.test.ts`** — 7 equivalence tests (interleaving,
  array-like ToString'd segments, substitution limiting, 4× nullish TypeError,
  length-coercion empty-string family, abrupt substitution toString,
  tagged-template smoke).

## Test Results

- `tests/issue-3147.test.ts`: 7/7 pass (standalone, zero imports asserted).
- Scoped test262 `built-ins/String/raw/` standalone: **25 pass / 5 fail / 0 CE
  (was 22 CE non-pass)** — the 5 remaining fails are the EXACT same 5 files
  failing in the JS-host lane on main's baseline (parity; no divergence):
  - `nextkey-is-symbol-throws.js`, `template-length-is-symbol-throws.js` —
    standalone `Symbol()` is not an honest `$Symbol` carrier through the
    open-`any` store/read path (`typeof Symbol("x") !== "symbol"` even
    directly); upstream symbol-representation gap.
  - `template-length-throws.js` — `Object.defineProperty` getter on the open
    object is not installed as an accessor (descriptor-fidelity umbrella
    #3022), so the throwing `length` getter never runs.
  - `return-the-string-value.js` — stored `null`/`undefined` collapse to one
    carrier under the default (`undefinedSingleton` off, #2106); both render
    "null".
  - `special-characters.js` — tagged-template path (line-continuation raw
    text), separate lowering (#2510), pre-existing host-lane fail too.
- `npx tsc --noEmit` clean; `tests/issue-3140.test.ts` canary 6/6.
