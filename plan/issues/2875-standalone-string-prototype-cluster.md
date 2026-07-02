---
id: 2875
title: "Standalone: String.prototype.* cluster (159 host-pass/standalone-fail, de-masked from #2862)"
status: in-progress
assignee: ttraenkler/dev-2875b
created: 2026-06-30
updated: 2026-07-02
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2885]
umbrella: 2860
---

> **Blocked on #2885** (standalone descriptor-reflection core). The reflective
> descriptor reads over `String.prototype` members (sub-cluster b) share the
> builtin-proto intrinsic-accessor defect specced there; land #2885's core
> (PR1+PR2) first, then fill in the String per-builtin glue member bodies.
>
> **Unblocked machinery (#2885 + #2876, both merged):** gOPD builtin-proto
> accessor descriptor SYNTHESIS (#2885) and the brand-agnostic reflective
> `.call`/`.apply` recovery of a descriptor-retrieved getter — static data-flow
> trace of `gOPD(<Builtin>.prototype, "<getter>").get.call(R)` →
> `emitReflectiveNativeProtoClosureCall`, `calls.ts` (#2876). The remaining
> String work is the **per-cluster glue**: wire the String getter/method
> `emitMemberBody` arms (`ensureStringNativeProtoGlue`) + their proto-identity
> opt-in; the gOPD + reflective-call surfaces then apply for free.

# Standalone: String.prototype.\* failures (de-masked)

## Problem

~**159** `built-ins/String/prototype/**` (plus ~25 `built-ins/String/**`) tests
are host-pass but standalone-fail, de-masked by #2870 from the phantom
ToPrimitive signature (#2862).

## Triage needed

Likely sub-clusters: (a) `this`/argument `ToString`/`ToPrimitive` coercion of
object args in String prototype methods, (b) reflective descriptor reads over
`String.prototype` members (overlaps native-proto glue), (c) RegExp-arg methods
(`split`/`replace`/`match`) routing through `__str_flatten` (overlaps the
invalid-Wasm #2868 carrier). Triage with
`runTest262File(file, cat, undefined, "standalone")`, group by method.

## Test plan

Per sub-cluster: standalone fail → pass, verify-first, full `merge_group` +
standalone high-water. `ctx.standalone` only.

## Reground (2026-07-02, dev-2873)

Full fresh triage of all **1223** `built-ins/String/**` files against current
`main` (`runTest262File(..., "standalone")`, host-confirmed): **159 → 129**
host-pass/standalone-fail (less shrinkage than #2873's 276→10). Buckets:

| n   | bucket                                                                                                      | root cause                                                             |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 21  | RequireObjectCoercible on `this` (`this-is-null/undefined`, `not-obj-coercible`, `return-abrupt-from-this`) | **reflective** `String.prototype.X.call(null)` — closure body missing  |
| 14  | `not-a-constructor`                                                                                         | reflective `isConstructor`/`Reflect.construct(fn,[],method)`           |
| 69  | `uncaught Wasm-GC exception`                                                                                | #2862 ToPrimitive substrate + `eval` + `new String` wrapper reflection |
| 6   | `searchstring` IsRegExp                                                                                     | `endsWith`/`includes` RegExp-arg throw                                 |
| ~19 | misc (`fromCharCode` static read, `Symbol.iterator`, `matchAll`, …)                                         | mixed                                                                  |

**Root cause is deeper than the tests suggest — no #2873-style one-liner.** Even
the DIRECT any-receiver path is broadly broken standalone:
`(x:any="abc").charAt(1)` returns `0` (want `"b"`), `(null).charAt()` does not
throw. The reflective form `String.prototype.charAt.call(...)` falls through
`ensureStandaloneNativeMethodClosure` (native-proto.ts) because String's
`emitMemberBody` is `emitProtoMemberBodyRefusal` → returns `null`, so the whole
reflective path returns `undefined` and lands on a legacy `.call` that drops
`thisArg` and returns `0`.

**Fix = the "per-cluster glue" this issue already flags:** implement per-member
native String closure bodies — a new `emitStringProtoMemberBody(ctx, fctx,
member, kind)` doing `RequireObjectCoercible(this)` → `ToString(this)` →
delegate to the native string helper — wired into `ensureStringNativeProtoGlue`'s
`makeGlue`, mirroring `emitArrayProtoMemberBody` (Array's `slice` is the only
built body today). This lives in the funcidx/type-index-sensitive
`native-proto.ts` / `array-object-proto.ts` subsystem and carries real
`merge_group` standalone-floor regression risk — **L-sized, architect-spec /
senior-dev work**, not a plain dev slice. A scoped subset
(`charAt`/`charCodeAt`/`codePointAt`/`indexOf`/`lastIndexOf`/`includes`/
`endsWith` — the methods with simple native cores) is the natural first PR once
the closure-ABI + type-index approach is spec'd. Triage data:
`.tmp/triage-string-result.json`.

## Implementation Plan (dev-2873, 2026-07-02)

Implement per-member native reflective closure bodies for `String.prototype.*`,
mirroring `emitArrayProtoMemberBody` (the one proven in-tree template — Array's
`slice`). Scope: the RequireObjectCoercible (~21), `not-a-constructor` (~14),
IsRegExp (~6) buckets. **NOT** the 69-test #2862 ToPrimitive substrate bucket.

### Mechanism (verified on current main)

- `ensureStringNativeProtoGlue` (`array-object-proto.ts`) registers String glue
  via `makeGlue(ctx, brand, "String", STRING_PROTO_METHODS)`. Today its
  `emitMemberBody` arm returns `emitProtoMemberBodyRefusal` → **`null`**, so
  `ensureStandaloneNativeMethodClosure` (`native-proto.ts`) returns null and the
  reflective `String.prototype.X.call(...)` (`emitReflectiveNativeProtoClosureCall`,
  `calls.ts`) **falls through** to a legacy `.call` that drops `thisArg` and
  returns 0. That is why `X.call(null)` neither throws nor works.
- **Closure ABI** (from `emitArrayProtoMemberBody` + `ensureStandaloneNativeMethodClosure`):
  the lifted body's params are `param0 = self` (wrapper struct), `param1 = this`
  (externref), `param2.. = user args` (externref-boxed; over-padded). Result is
  the uniform **externref** (box native/number results).
- **RequireObjectCoercible (§22.1.3.1 step 1)** in standalone is host-free:
  `undefined` is conflated with `null` as `ref.null.extern`
  (`ensureGetUndefined`/`emitUndefined`, late-imports.ts), so the guard is simply
  `local.get 1; ref.is_null; if → throw TypeError` via the shared
  `emitBrandCheckTypeError`/`throwNativeError` helper. **No host import.**
- **ToString(this)**: `$__any_to_string(this)` (`ensureAnyToStringHelper`) →
  native `$AnyString` → `__str_flatten`. (nullish already excluded by step 1.)
- **Native cores** (registered by `ensureNativeStringHelpers`, native-strings.ts):
  `__str_charAt(flat,i32)→str`, `__str_indexOf`, `__str_includes`,
  `__str_endsWith`, etc. Integer args: `unboxArgToI32(ctx,fctx,paramIdx)`
  (array-object-proto.ts) unboxes an externref-boxed number → i32.
- **Result boxing**: string result → `extern.convert_any`; number result (i32/f64)
  → `__box_number` (per the type-coercion patterns).

### New code

1. `emitStringProtoMemberBody(ctx, fctx, member, kind)` in `array-object-proto.ts`
   (next to `emitArrayProtoMemberBody`). Per in-scope member: emit the
   RequireObjectCoercible guard, then ToString(this)+flatten into a local, then
   the member core, then box → externref; return `{kind:"externref"}`. Members
   NOT yet in scope → `emitProtoMemberBodyRefusal` (returns null → unchanged
   fall-through, zero behavior change).
2. Wire `makeGlue`'s `emitMemberBody` arm: add
   `name === "String" ? emitStringProtoMemberBody(c, fctx, member) : …`.

### Staging

- **Slice 1 (this PR): glue skeleton + index-accessor family** — `charAt`,
  `charCodeAt`, `codePointAt`, `at`. Flips their RequireObjectCoercible +
  reflective-valid-call tests.
- Slice 2: search family — `indexOf`, `lastIndexOf`, `includes`, `endsWith`,
  `startsWith` (+ IsRegExp-arg throw for the last three).
- Slice 3: `not-a-constructor` (closure IsConstructor=false / `new` throws) if it
  doesn't fall out of slices 1–2.

### Hazard checklist (guardrails)

- **Type-index discipline** (`project_type_index_shift_and_deadelim`,
  `reference_subview_type_idx_stability`): reuse the wrapper/func types
  `ensureStandaloneNativeMethodClosure` already creates via
  `getOrCreateFuncRefWrapperTypes`; register any shared helper types **late +
  once** (the `ensure*` helpers are idempotent) — never per-member, never
  up-front.
- **Funcidx repoints are NAME-BASED** (`ctx.funcMap.get(name)`), never index
  arithmetic. Delegate to helpers by name.
- **Never rebuild a helper body at finalize** (no splice —
  `reference_no_rebuild_helper_body_at_finalize`): the body is emitted once in
  `ensureStandaloneNativeMethodClosure`'s committed emission.
- **Floor safety**: change only RAISES `host_free_pass`; blast radius = tests
  that reflectively touch `String.prototype.<member>`. Before each PR: re-run the
  full 1223-file String triage **and** a ~1k-file Array/Object/Number standalone
  sweep → require zero new fails (the standalone floor gate only fires in
  `merge_group`).

## Progress log

The staging above was re-sliced during implementation (the index-accessor
family split across two PRs):

- **Slice 1 — MERGED (PR #2440):** `emitStringProtoMemberBody` glue skeleton +
  `calls.ts` String-brand enablement + `charAt`/`at`.
- **Slice 2 — in PR (this branch, dev-2875b):** the two number-returning index
  accessors `charCodeAt`/`codePointAt`. RequireObjectCoercible(this) (host-free
  `ref.is_null` throw) → ToString(this) → UTF-16 read; `charCodeAt` NaN out of
  range (§22.1.3.3), `codePointAt` undefined out of range + surrogate-pair
  combine (§22.1.3.4); f64 result boxed via `__box_number` ensured in the same
  first late-import batch as `__unbox_number` (funcidx-shift discipline). 10/10
  host-free tests pass; byte-diff neutrality re-verified after `git merge
  origin/main` (12/12 unrelated programs byte-identical to main; only the two
  target reflective programs change output).
- **Slice 3 — next:** search family — `indexOf`, `lastIndexOf`, `includes`,
  `endsWith`, `startsWith` (+ IsRegExp-arg throw for the last three).
- **Out of scope (routed elsewhere):** the 69-test #2862 ToPrimitive substrate
  bucket.
