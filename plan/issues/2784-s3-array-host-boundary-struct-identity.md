---
id: 2784
title: "[SENIOR-DEV ONLY] S3 of #2773 — array-element / host-boundary native struct identity (re-proxy loss closes acorn parse) — closes #2681/#2686"
status: ready
assignee: ttraenkler/unassigned
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
created: 2026-06-28
updated: 2026-06-28
task_type: bugfix
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [2773, 2681, 2686, 2660, 1712]
depends_on: [2773]
blocks: [2681, 2686]
---

# #2784 — S3 of #2773: array-element / host-boundary native struct identity

**This is the slice that actually closes #2681/#2686.** S1 (#2234, pass-invariant
fnctor typeIdx) and S2/S2b (#2681 branch `issue-2681-s2-acorn` — `new this()`
reconstruct + read/write dispatch symmetry) are its now-landed foundation. The
mechanism below was traced end-to-end on the **post-S2/S2b** acorn WAT
(sendev-substrate, 2026-06-28), not theorized.

## Root cause (pinned)

With S2/S2b landed, `$__fnctor_Parser` and `$__fnctor_Scope` are registered with
**stable typeIdx** (S1), and `this.<field>` reads route to `__get_member_<name>`
dispatchers. Yet `parse("x")` still HANGS — `__extern_get` ~850k in an infinite
`currentVarScope()` loop. The dispatcher's `ref.test $__fnctor_Scope` MISSES at
runtime — **not** because the typeIdx is wrong (S1 fixed that; sr-acorn's
"typeIdx desync" hypothesis is RULED OUT) but because the **runtime value is no
longer a `$__fnctor_Scope` ref**:

1. A fnctor instance type resolves to **`externref`** (`resolveWasmType`, the
   #1712 host guard), so `$__fnctor_Parser` stores `this.scopeStack` as a
   host-backed array of `externref` and `scope`-typed fields as `externref`
   (verified in the struct field dump — `$scopeStack (mut (ref null <arr>))`,
   element externref; `$type (mut externref)`).
2. `this.scopeStack.push(scope)` stores the native `$__fnctor_Scope` ref into the
   host array. On the way in (or on read-back) the value crosses the host boundary
   and is **re-proxied to a fresh host externref** (a `$Object`/sidecar proxy),
   losing the `extern.convert_any(struct)` identity.
3. `currentVarScope()` backward-walks `this.scopeStack` reading `scope.flags`. The
   re-proxied externref fails `ref.test $__fnctor_Scope` → falls to `__extern_get`
   → `scope.flags` reads `undefined` → the `& SCOPE_VAR` test never matches → the
   index decrement loops forever (acorn.mjs ~3852).

This is the #2773 epic's S3 row verbatim: *"a native struct ref stored into a
host-backed array (`arr.push(structRef)`) and read back must NOT be re-proxied to
a host externref — it must round-trip the same struct identity (so a parser that
`this.scopeStack.push(scope)` then re-reads `scope.flags` sees the native slot)."*

## Fix direction

Preserve native struct identity across the host-array round-trip. Pin the exact
re-proxy site first (instrument `__extern_get` / `__js_array_push` / the `$Object`
reader on the `scope.flags` read in a single acorn compile — reuse
`.tmp/acorn-run.mjs` host-call counters + a per-key trap), then choose:

- **(S3a) Identity-preserving box/unbox at the array boundary.** A native struct
  stored via `extern.convert_any` into a host array must read back via
  `any.convert_extern` to the **same** struct ref (these WasmGC ops ARE
  identity-preserving). Find where read-back instead routes through a
  `$Object`/sidecar proxy constructor and suppress the re-proxy when the stored
  value is already a native struct externref.
- **(S3b) Typed array element-rep for reconstructed-struct arrays.** When a fnctor
  field is an array whose element static type is a reconstructed fnctor
  (`Scope[]`), lower it as a typed `(ref null $__fnctor_Scope)` array instead of an
  `externref` host array, so push/read-back never cross the host boundary. Larger
  blast radius; interacts with the `externref` #1712 guard.

## Acceptance

- Real compiled-acorn `parse("x")` → `ExpressionStatement` / `Identifier` (no hang,
  no throw); `parse("1 + 2 * 3;")` → `BinaryExpression`; `parse("var x = 1;")` →
  `VariableDeclaration`. **Closes #2681 AND #2686** (set both `status: done` in this
  PR).
- A guard test: a fnctor with a `this.stack: T[]` field of a reconstructed-fnctor
  element type, `push` then read-back a field — must read the native slot, not
  `undefined`.
- Full `merge_group` + standalone-floor, net ≥ 0, no new bucket. Broad-impact —
  never a scoped sweep.

## Reusable probes (banked)

- `.tmp/acorn-run.mjs` — single-compile worker watchdog + host-call signature
  (12s/input watchdog, prints HANG signature when a parse loops).
- `.tmp/acorn-wat2.mjs` — acorn WAT dump with `skipSemanticDiagnostics:true`
  (`compile(..., { emitWat:true })`, grep `$__fnctor_*` / `__get_member_*`).
- `.tmp/identity{2,3}.mjs` — minimal struct-identity repros (7/45/207).

In the `issue-2681-s2-acorn` (sendev-substrate) and sr-acorn
(`agent-ae75b7409d6e143f8`) worktrees' `.tmp/`.
