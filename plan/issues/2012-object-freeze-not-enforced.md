---
id: 2012
title: "Object.freeze: no strict-mode TypeError on write, isFrozen false — tracking only fires for identifier args, struct receivers get no integrity bit"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-14
completed: 2026-06-14
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [797, 359, 2012]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2012 — freeze of inline literal is a no-op

## Problem

```ts
const o: any = Object.freeze({a: 1});
let threw = false;
try { o.a = 2; } catch { threw = true; }
threw + "," + o.a + "," + Object.isFrozen(o)
// wasm: "false,1,false"   node: "true,1,true"  (module code is strict)
```

(The write does fail — but silently, and isFrozen misreports.)

## Root cause

`src/codegen/expressions/calls.ts:3770-3830` — `frozenVars` tracking only
fires for identifier args (an inline literal arg gets nothing), and
struct-typed receivers end at "For struct/ref types, compile-time tracking
is sufficient — return as-is" (calls.ts:3828) with no runtime integrity
bit and no strict-write throw; `isFrozen` then consults only
`ctx.frozenVars`/host path and reports false.

## Fix direction

Stamp a runtime frozen bit (sidecar or hidden field) on freeze for struct
receivers; check it in the property write path (strict → throw TypeError)
and in isFrozen.

## Acceptance criteria

- Repro matches Node; frozen identifier-arg behavior unchanged

## Dupe check

#797d and #359 done; residual not listed in #1971. New.

## Resolution — compile-time variable tracking (2026-06-14)

The headline repro `const o = Object.freeze({a:1}); o.a = 2` was a no-op for
struct receivers because the existing compile-time tracking only fired for an
**identifier argument** (`Object.freeze(o)` → `ctx.frozenVars.add("o")`). An
inline literal arg is not an identifier, so nothing was tracked: the strict
write silently succeeded-as-noop and `isFrozen` returned false
(`"false,1,false"` vs Node `"true,1,true"`).

**Fix** (`src/codegen/expressions/calls.ts`, the freeze/seal/preventExtensions
arm): when the `Object.<freeze|seal|preventExtensions>(<expr>)` CALL is the
**initializer of a variable declaration**
(`expr.parent` is a `VariableDeclaration` with an identifier name and
`expr.parent.initializer === expr`), mark the **declared variable** in
`ctx.frozenVars`/`sealedVars`/`nonExtensibleVars` instead of the
(non-identifier) argument. The write-path (`assignment.ts:1763/2193`) and
`isFrozen`/`isSealed` (`calls.ts`) already consult these sets keyed on the
identifier name, so this single hook restores correct strict-throw, value-kept,
and `isFrozen → true` for `const/let o = Object.freeze({...})`.

Verified: `inline literal` → `"true,1,true"`; `let`-binding inline →
`"true,true"`; identifier-arg unchanged; `Object.seal` inline → `isSealed true`;
non-frozen control → `"false,1,false"` (no false positive).

**Scope / follow-up (#22):** this is COMPILE-TIME variable tracking — it covers
the common literal-to-variable binding but NOT aliased/dynamic cases
(`const a = Object.freeze({}); const b = a; b.x = 1` does not throw, because the
write target `b` was never marked). General runtime enforcement needs a runtime
frozen bit on the object representation (host-mode WasmGC structs have no flags
field like the standalone `$Object` does) — tracked as the
`[SENIOR][follow-up]` #2012-runtime task. Standalone-mode freeze already works
(verified in #2046 PR-B tests — the `$Object` runtime has real integrity flags).

## Test Results (2026-06-14)

- `tests/issue-2012.test.ts` (new) — 5/5: inline-literal const freeze
  (strict-throw + value-kept + isFrozen true), `let`-binding inline,
  identifier-arg (unchanged), inline `seal` → isSealed, non-frozen control.
- Pre-existing unrelated failure (byte-identical to origin/main): the
  `object-mutability.test.ts` "isFrozen/isSealed returns false (stub)" /
  "isExtensible returns true (stub)" cases already fail on clean origin/main —
  stale stub-behavior assertions superseded by a prior PR, not touched here.
