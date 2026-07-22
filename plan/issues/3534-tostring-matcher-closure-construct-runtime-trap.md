---
id: 3534
title: "codegen: mutually-recursive const-closure funcref-cell RTT desync — matcher-invoking Function.prototype.toString files trap (illegal cast) at construct site"
status: ready
sprint: current
created: 2026-07-22
updated: 2026-07-22
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures
goal: correctness
related: [3024, 2873]
---

# #3534 — matcher-invoking `Function.prototype.toString` files trap at runtime (construct-site funcref-cell RTT desync)

## Context / provenance

Follow-up to **#3024 slice** `issue-3024-toString-closure-funcref` (the boxed-capture
CALL-site fix in `calls-closures.ts`). That slice eliminated the 68-file
`built-ins/Function/prototype/toString/*` invalid-Wasm cluster (CE → valid on both
gc and standalone lanes; +11 host passes on files whose `assert.sameValue("" + fn,
expected)` matches and never invoke the native matcher).

## Problem

Files that DO invoke the native matcher (`assert.sameValue` fails → `catch` →
`assertNativeFunction` → `validateNativeFunctionSource` → inner `eat`/`test`/…)
now **validate but trap at runtime**:

```
RuntimeError: illegal cast in __closure_41() at source L25
  (via __closure_53@L214 ← __module_init@L16)
```

`__closure_53` = `assertNativeFunction` (`const actual = "" + fn`, then
`validateNativeFunctionSource(actual)`); `__closure_41` =
`validateNativeFunctionSource`; the illegal cast is at its ENTRY (L25), where it
constructs its cross-referencing inner closures (`eat` captures `test`'s box, etc.).

**Verified NOT caused by the #3024 call-site fix:** even dev-serve's "valid"
reference layout (`validateNativeFunctionSource` + a direct call) validates but
traps identically — dev-serve's "VALID" rows only checked `WebAssembly.compile`,
never RAN the matcher. So NO layout currently runs the matcher correctly.

## Root cause (hypothesis, to confirm)

The `nativeFunctionMatcher` module-level `const` closures are mutually recursive.
They are boxed into ref cells that store a **bare funcref** (no environment
struct); their lifted self carriers are no-capture funcref-WRAPPER structs
`(struct (field funcref))`. This is a **funcref-wrapper RTT-identity** problem
(cf. #2873 star-topology: sibling `(struct (field funcref))` wrappers do NOT
merge under WasmGC isorecursive canonicalization, so `ref.cast` to a non-root
wrapper traps). The desync spans multiple sites:

- **call site** — fixed in #3024 (`compileClosureCall`, funcref cell → rebuild
  self carrier via `struct.new`).
- **construct site** — `validateNativeFunctionSource` building `eat`/`test` that
  cross-reference each other's funcref cells (the trap here).
- **value-read site** — likely the same family as the 34-file
  `class C { c = fn }` cluster (dev-serve owns that): a module-global
  closure-VALUE read reported `externref` but emitted `global.get <ref>` with no
  `extern.convert_any`.

## Suggested direction (architect-worthy)

Unify the closure funcref-cell representation so `boxed.valType`, the ref-cell
field-0 type, and the lifted self-carrier type AGREE — likely by storing the
closure STRUCT (or externref-boxed closure) in the cell rather than a bare
funcref, so no per-site reconstruction (and no RTT-sibling cast) is needed. A
single spec should cover the call / construct / value-read sites and the #2873
wrapper-root discrimination.

## Repro

```
[assert.js, sta.js, nativeFunctionMatcher.js, bound-function.js]  → validates, traps
```
or minimal:
```js
// nativeFunctionMatcher.js + :
validateNativeFunctionSource("function f() { [native code] }");  // validates, traps (illegal cast)
```

## Acceptance criteria

- Matcher-invoking `Function.prototype.toString` files run without trapping
  (`illegal cast`), reaching a genuine oracle pass/fail.
- No regression on the closure byte-inert corpus or the standalone floor.
