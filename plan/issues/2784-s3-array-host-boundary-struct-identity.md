---
id: 2784
title: "[SENIOR-DEV ONLY] S3 of #2773 — array-element / host-boundary native struct identity (re-proxy loss closes acorn parse) — closes #2681/#2686"
status: done
completed: 2026-06-28
assignee: ttraenkler/sendev-substrate
sprint: 69
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
created: 2026-06-28
updated: 2026-07-03
task_type: bugfix
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [2773, 2681, 2686, 2660, 1712, 2794]
depends_on: [2773]
blocks: [2681, 2686]
---

> **DONE (PR #2260, 2026-06-28).** The S3 native-vec-aware method + element dispatch
> shipped: `.push`/`.pop` → `__vec_push`/`__vec_pop` and numeric `recv[i]` →
> `__vec_get` via a runtime `ref.test` vec guard (host/gc), with reserve-then-fill
> plumbing for the finalize-built helpers. This closed the scopeStack storage-split
> → compiled acorn `parse("x")` → ExpressionStatement/Identifier and
> `parse("foo(bar,baz)")` → CallExpression. The over-scoped "closes #2681/#2686"
> framing was wrong: a DISTINCT residual (var-decl + binary-expression THROW, a
> `raise`/`unexpected` in the expr/stmt-parse path, NOT the vec class) keeps
> #2681/#2686 open — carved to **#2794**.


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

## EXACT re-proxy site PINNED (sendev-substrate, 2026-06-28, post-regression-fix)

Traced on the minimal `.tmp/s3-repro.mjs` WAT (a `Scope`-fnctor pushed into a
`Parser.scopeStack` native vec, then `topFlags()` reads `st[st.length-1].flags`).
The defect is a **read/write storage split**, not a `ref.test`/typeIdx issue:

- `scopeStack` lowers to a **native** WasmGC vec-struct `(ref null 2)` whose data
  array is `$__arr_externref` — NOT a host array. So storing a `$__fnctor_Scope`
  ref needs only `extern.convert_any` (identity-preserving).
- BUT `this.scopeStack.push(s)` in the lifted method **routes through the HOST
  method-call bridge** `__extern_method_call(vec_externref, "push", [s])` (func 6):
  `this.scopeStack` is read via `__get_member_scopeStack` as an **externref**, and
  `.push` on an `externref`/`any` receiver defaults to the host method dispatch
  (`__js_array_new` + `__js_array_push` to build the args, then
  `__extern_method_call`). The host receives the vec as an **opaque externref** it
  cannot natively `array.set` into.
- The READ-back `st[st.length-1]` uses the **native** `__vec_get` (`any.convert_extern;
  ref.test (ref 2); struct.get 2 1; array.get`). So the host-pushed element and the
  native-read element live in **different storage** → the Scope never appears in the
  native array → `__vec_get` returns a stale/wrong externref → `s.flags`'s
  `ref.test (ref $__fnctor_Scope)` MISSES → `__extern_get("flags")` → `undefined` →
  `NaN` (host-call trace: `__extern_get:3 __get_undefined:4`, NO `__js_array_push`
  into the native vec the read uses).

**So the "re-proxy" is really a method-dispatch split**: native-vec WRITE (`.push`)
goes host-side, native-vec READ (`[i]`) goes WASM-side; they don't share storage.

## Fix direction (REVISED per the pinned site)

The real fix is **native-vec-aware method dispatch**: when a `.push`/`.pop`/etc. is
called on a receiver that is (or may be) a **native vec** read as externref, route
it to the WASM `__vec_push`/`__vec_pop` (which `any.convert_extern; ref.test` the
vec-struct and `array.set` natively) instead of the host `__extern_method_call`.
The host CANNOT introspect the opaque WasmGC vec-struct, so this must be a WASM-side
dispatch (mirror the `__get_member`/`__set_member` finalize-filled dispatcher
pattern: a `__vec_method_<name>` dispatcher that `ref.test`s the vec-struct and
calls `__vec_push` on a hit, falling through to `__extern_method_call` for genuine
host arrays). Alternatively, propagate the static `T[]` type of the struct field
through `this.scopeStack` so `.push` lowers to `__vec_push` directly (narrower, but
needs the lifted-method `this`-field type to survive the externref erasure).

### Original (superseded) fix direction

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
