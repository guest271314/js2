---
id: 2935
title: "Standalone: __str_flatten null-deref on new String(...).split/replace(RegExp) — String-wrapper receiver not unwrapped before flatten"
status: done
created: 2026-07-02
updated: 2026-07-17
completed: 2026-07-17
assignee: ttraenkler/opus-3
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: standalone
language_feature: strings, string-wrapper, regexp
related: [2878, 2860]
umbrella: 2860
origin: "2026-07-02 spun out of #2878 Class B triage (dev-callback). origin/main current."
---

## Verification — already fixed on main (2026-07-17, opus-3)

Re-verified against current `origin/main` (079c585fa6): the `__str_flatten`
null-deref on a String-**wrapper** receiver (`new String(...)` or a var typed
`String`) calling `.split(RegExp)` / `.replace(RegExp, …)` under
`--target standalone` **no longer reproduces** — the wrapper receiver runs
host-free and its results match the primitive receiver. The intervening
borrowed-receiver `RequireObjectCoercible` + `ToString` unwrap work
(**PR #3254**, `d44d0d6c34`; cf. the #2934 receiver-ToString normalise) now
recovers the primitive `$AnyString` from the wrapper's `[[StringData]]` before
the native flatten helper, so the receiver-shape-specific null-deref is gone.

Probed on main (all correct, no trap):
- `new String("abc").split(/[a-z]/).length` → **4** (matches `"abc".split(...)`)
- `new String("aXbXc").split(/X/).length` → **3**
- `new String("abc").replace(/[a-z]/, "X")` → `"Xbc"` (`.length` 3, `charCodeAt(0)` 88)
- `new String("abcabc").replace(/b/g, "X").length` → **6** (global flag honored)
- `const s: String = new String("a1b2c3"); s.split(/[0-9]/).length` → **4**

Locked with a regression test (`tests/issue-2935.test.ts`, 5 cases,
standalone host-free). This PR is test + doc only — **byte-inert** to the
compiler (no `src/` change).


# #2935 — `__str_flatten` null-deref on String-wrapper `.split`/`.replace(RegExp)`

Class B of the #2878 decomposition (the #2878 Class A dstr value-rep slice
landed via PR #2435; the eqref/Class-C slice via PR #2431). This is the
remaining runtime null-deref.

## Symptom

Under `--target standalone`, calling `.split(regexp)` / `.replace(regexp, …)`
on a **String wrapper object** (`new String(...)`, or a var typed `String`)
traps at runtime:

```
dereferencing a null pointer [in __str_flatten() ← test]
```

test262 examples (all `built-ins/String/prototype/{split,replace}/**`):
`argument-is-regexp-a-z-and-instance-is-string-abc.js`,
`replace/S15.5.4.11_A1_T7.js`, and the `/BigInt`-free RegExp-arg split/replace
family that constructs its instance via `new String(...)`.

## Minimal repro (standalone)

```ts
export function test(): number {
  const s = new String("abc");     // String WRAPPER, not a primitive
  const r = s.split(/[a-z]/);       // -> traps in __str_flatten
  return (r as any).length;
}
```

A **primitive** receiver works: `"abc".split(/[a-z]/)` compiles to valid Wasm and
runs host-free. Only the **wrapper** receiver (`new String(...)`, or `s: String`)
null-derefs. So the bug is receiver-shape-specific, not in the RegExp split
algorithm itself.

## Diagnosis (starting point)

The wrapper object carries its primitive `[[StringData]]` in a native `$Object`
slot (#1910 S2 / #2160), so a `typeof "object"` value. The RegExp split/replace
lowering hands the **receiver** to the native `__str_flatten` helper
(`src/codegen/native-strings.ts` — registration; `src/codegen/string-ops.ts`
~L1545 notes `__str_flatten` derefs its operands) **without first performing
`thisStringValue`/ToString unwrapping** of the wrapper to recover the primitive
`$AnyString`. `__str_flatten` then derefs a null (the wrapper `$Object` is not an
`$AnyString`, so the extracted string ref is null → `struct.get`/`array` on
null).

**Fix shape**: in the standalone `.split(RegExp)` / `.replace(RegExp, …)` path,
when the receiver is (or may be) a String wrapper, extract its `[[StringData]]`
(the same `thisStringValue` unwrap the primitive-method dispatch already uses for
`isStringWrapperType` receivers) to a real `$AnyString` **before** the
`__str_flatten` call. Verify the wrapper repro above runs host-free and returns
`["", "", "", ""]`-shaped output matching js-host; keep primitive-receiver bytes
inert.

## Acceptance

- `new String(...).split(/re/)` / `.replace(/re/, …)` run host-free in standalone,
  output matches js-host (not just no-trap).
- The `built-ins/String/prototype/{split,replace}/**` wrapper-receiver RegExp
  tests flip standalone-FAIL → pass.
- Byte-inert for gc/host and for primitive-receiver split/replace.
