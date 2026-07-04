---
id: 2791
title: "Hybrid audit Row 4 — monomorphic struct.get/set soundness (read discharged; real miscompile is structural-narrowing copy, not Row 4)"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: structural-typing
goal: correctness
parent: 2762
assignee: "ttraenkler/senior-dev-row4"
---

# Row 4 — Monomorphic `struct.get`/`struct.set` proof (hybrid fast-path audit)

Tracks Row 4 of `plan/log/hybrid-fastpath-audit.md`. Anchors verified against
`origin/main` @ `df78324` (newer than the audit's `d0339428259cb`).

## TL;DR for the lead (scope decision needed)

I did the Row-4 investigation with maximum conservatism (verify-first, 23
adversarial probes, host + standalone). Two findings change the picture:

1. **The Row-4 READ path is already HI-compliant** — discharged not by a static
   proof but by the runtime `ref.test` multi-struct dispatch that #778/#2674
   added to `emitNullGuardedStructGet`/`emitExternrefToStructGet`. The audit's
   premise ("monomorphic `struct.get` reads the WRONG field offset") is
   **outdated**: for every ref/externref receiver the read does NOT trust the
   static type — it `ref.test`s and finds the real struct. The only truly
   monomorphic shortcut (`emitNullGuardedStructGet` line ~1416, skip `ref.test`
   when `objType` is exactly `ref_null typeIdx`) is **Wasm-type-proven sound**:
   a `ref_null typeIdx` value is provably `typeIdx`-or-subtype, and the
   compiler lays every subclass out as `[...parentFields, ...ownFields]`
   registered as a Wasm subtype (class-bodies.ts:759/815), so the parent's
   fields are a strict prefix — `struct.get $Parent i` on a `$Child` is correct
   by WasmGC subtyping. Covariant-mutable-field divergence and reordered/
   divergent-layout subclasses are **structurally impossible** in this codegen.

2. **There IS a genuine silent miscompile** — but its root cause is **NOT** in
   the Row-4 lane (`resolveStructName`/`emitNullGuardedStructGet`). It is the
   **struct-narrowing field-copy at the call-argument boundary**
   (`type-coercion.ts` `getStructNarrowInfo`/`emitStructNarrowBody`, the
   "Case 3: destination fields are a subset of source fields" path, ~L760-855).
   Passing a value to a parameter of a **different** nominal struct type
   (a structurally-compatible distinct class, or an `interface`) materializes a
   **fresh `struct.new` copy** of the receiver's fields. A callee that **mutates
   through the param** then mutates the copy; the caller's original object is
   never updated — JS reference semantics are violated.

Because the receiver is already a disconnected copy by the time the callee's
field write runs, **no change within the Row-4 lane can fix it.** The
monomorphic `struct.set` inside the callee is _locally correct_ for the copy it
received.

Per the senior-dev mandate ("if you cannot construct a SOUND conservative proof
within the lane, STOP and report rather than ship a risky gate"), I am **not**
shipping a `resolveStructNameForExpr` gate: for the receivers the audit
enumerates it would either be a **no-op** (union/`any` already return `undefined`
→ safe dynamic path) or a **regression** (rejecting the working class/widened-var
struct fast path) — and in neither case does it fix the copy bug.

**Decision requested:** re-scope to the real fix (type-coercion / param-typing,
out of the original Row-4 lane), and flip Row 4's read side to `discharged`.

## Evidence

### Read path — all dangerous receivers produce correct values (host + standalone)

| Probe                                                   | Receiver shape               | Result       |
| ------------------------------------------------------- | ---------------------------- | ------------ |
| union of two struct types, field at different positions | `o: A \| B`                  | PASS (10099) |
| `any`-widened receiver                                  | `o: any`                     | PASS (10099) |
| subclass with extra fields, read via parent ref         | `o: P` ← `new C()`           | PASS (5005)  |
| interface over two object-literal shapes                | `o: HasX`                    | PASS (10099) |
| anon shapes with reordered fields                       | `{x,y}` vs `{y,x}` via iface | PASS         |
| name-collision widened var across scopes                | two `o:any` diff shapes      | PASS (2007)  |
| sibling subclasses via shared base                      | `getTag(b: Base)`            | PASS (1002)  |

The reads route through the multi-struct `ref.test` dispatch in
`emitNullGuardedStructGet` (propName present) / `emitExternrefToStructGet`.

### Write path — the miscompile (root cause: structural-narrowing copy)

```ts
class A {
  x: number;
  constructor() {
    this.x = 1;
  }
}
class B {
  x: number;
  constructor() {
    this.x = 2;
  }
} // structurally identical, distinct Wasm struct
function setX(o: A, v: number): void {
  o.x = v;
}
const b = new B();
setX(b, 9);
b.x; // JS: 9.  Compiler: 2 (write lost)
```

WAT for the call site (`test`): the compiler reads `b`'s ($B) fields and builds
a **fresh `$A`** via `struct.new 1`, passing the copy:

```
call 2                ;; new B() -> $B
local.tee 0 ...
struct.get 4 0        ;; b.__tag
struct.get 4 1        ;; b.x
struct.new 1          ;; *** fresh $A copy from B's fields ***
f64.const 9
call 4                ;; setX(<copy>, 9)  -- mutates the copy
... struct.get 4 1    ;; return b.x -> still 2 (original untouched)
```

The interface case is identical (`setV(o: I, ...)` builds a fresh `$I`-shaped
`struct.new` per arg from each class's real field at its own index; both writes
land on copies → `1002` instead of `100200`).

This bites **TS-typed user code** (interface/structural params with mutation —
very common, central to the `npm-library-support` / self-hosting goals). It does
**not** show up in test262 (test262 is JS, no interface/structural-class types),
which is why it has been latent.

## Why no in-lane fix exists

- `resolveStructNameForExpr` returning `undefined` for the structural/interface
  receiver would route the callee's _field write_ to the dynamic
  `__extern_set` / `emitAlternateStructSetDispatch` path — but onto the **copy
  `o`**, not the caller's original. The original was disconnected at the call
  boundary. So the write is still lost.
- Union/`any` receivers ALREADY return `undefined` (no `tsType.symbol`), so the
  "reject unions/any" half of the audit's prescribed gate is a no-op today.
- The class/anon/widened-var struct fast path (which a gate would suppress)
  currently produces correct values and is relied on by standalone mode; a
  blanket rejection would be a perf + correctness regression for zero benefit.

## Recommended fix (re-scoped — type-coercion / param typing)

The SAFE machinery already exists (multi-dispatch read + `emitAlternateStructSetDispatch`
write). The fix is to ROUTE structural/interface receivers through it by **not
materializing a narrowed struct copy** and instead keeping the value as a
shared reference:

- **Preferred (targeted):** type a parameter (or any binding) whose declared
  type is an `interface`, or a class that has a structurally-distinct assignable
  type, as **`externref`/`anyref`** rather than a narrow `ref $T`. Then the
  call-site coercion is `extern.convert_any` (share the ref) instead of the
  `emitStructNarrowBody` field-copy, and the callee's reads/writes use the
  existing SAFE multi-dispatch. Param-typing lives in the function-signature
  lowering (`declarations.ts` / wasm param-type resolution); the copy is gated
  in `type-coercion.ts` (`getStructNarrowInfo`/`emitStructNarrowBody`).
- **Safety condition for keeping the copy:** the narrowing field-copy is only
  sound when the source value's identity is NOT observed after the conversion
  (a fresh temporary / pure value-narrowing). Distinguishing that from an
  aliased object needs escape/aliasing analysis — which is why this is
  architect-scoped, not a localized patch, and why a blanket "never copy" is
  itself unsound.

This is firmly **out of the Row-4 lane** (`resolveStructName`/
`emitNullGuardedStructGet`) and touches a CORE, broad-impact coercion path —
broad-impact validation (full merge_group test262 + standalone-floor) required.

## Audit doc follow-up

- Flip `hybrid-fastpath-audit.md` Row 4 **read side** to `discharged` (runtime
  `ref.test` multi-dispatch + WasmGC prefix-subtyping; covariant/divergent-
  subclass moot by construction). Cite #778/#2674. **Done in this PR.**
- File the structural-narrowing-copy miscompile as its own
  architect-scoped issue (root cause `type-coercion.ts emitStructNarrowBody` +
  param typing), NOT a Row-4 follow-up. **Filed as #2793** (`[ARCH][SUBSTRATE]`,
  `depends_on: #2773`).

## Resolution (lead decision 2026-06-28)

`status: done`. Lead approved (a)+(iii): Row 4 **read** side is `discharged`
(this PR flips the audit row), and this issue **lands as the findings + read-
discharge lock + `it.fails` write-miscompile lock** — no code fix is needed in
the Row-4 lane. The genuine write miscompile (structural-narrowing copy) is
**out of lane** and tracked separately in **#2793**, routed to the architect /
substrate lane (overlaps #2773). The `it.fails` cases in
`tests/issue-2791.test.ts` will flag #2793's fix the moment it lands.
