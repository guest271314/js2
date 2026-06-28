---
id: 2802
title: "[DEFERRED] nested `any`-vec multi-push then read drops the first element (S3-class vec-identity edge)"
status: ready
assignee: ttraenkler/unassigned
sprint: current
priority: low
horizon: m
feasibility: hard
reasoning_effort: high
created: 2026-06-28
updated: 2026-06-28
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2784, 2794]
depends_on: [2784]
blocks: []
---

# #2802 — nested `any`-vec multi-push then read drops the first element

**DEFERRED / lower-priority** (carved out of #2794). acorn's real var-declaration
path does NOT hit this — #2794's compiled-acorn var-decl ASTs diffed **EQUAL** to
node-acorn — so it is not blocking the acorn goal. Recorded so the edge isn't
lost. **Do not work now.**

## Symptom (observed during #2794's (2) vec-read work)

A vec stored in a struct field, accessed via an `any`-typed receiver, then
multi-pushed and read, can drop the FIRST pushed element:

```js
class Scope { lexical: string[]; constructor() { this.lexical = []; } }
function mkScope(): any { return new Scope(); }
const s: any = mkScope();
s.lexical.push("a");
s.lexical.push("b");
s.lexical.push("c");
s.lexical.join("|");      // → "b|c"   (expected "a|b|c" — first element dropped)
```

Yet `indexOf` of each element in SEPARATE function calls returned the correct
indices (0/1/2), so the inconsistency is non-trivial — it points at a
vec-IDENTITY / storage split (the push and the read seeing different vec
instances, or the first push targeting a transient vec before the field is
stabilized), the **same class as the S3 fix (#2784)** for
`this.scopeStack.push` round-trips.

## Likely mechanism (verify-first)

The nested field vec (`s.lexical` where `s` is `any`) is read via the host proxy
on each access. If `s.lexical` returns a fresh/transient vec wrapper on the first
push (before the field is written back), the first element lands on a vec that is
then replaced — mirroring the `currentVarScope()` / `scopeStack` storage-split
that #2784 fixed one level up. Confirm whether `s.lexical` reads a STABLE vec
identity across pushes (the `_hostProxyCache` / `__extern_get` field read should
return the same backing vec each time).

## Acceptance (when un-deferred)

- The repro above yields `"a|b|c"`; `length`/`indexOf` consistent with all
  pushed elements across mixed read/write sequences on a nested `any`-vec field.

## Method

- Banked probe under the #2794 branch `.tmp/` (`vec-read.ts` + `vec-read-run.mjs`,
  the multi-push + join case). Compile is small/fast (no full acorn needed).
