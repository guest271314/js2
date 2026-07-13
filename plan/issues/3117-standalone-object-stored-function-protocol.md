---
id: 3117
title: "Standalone $Object dot-member-set drops closures: o.f = function(){} is silently uncallable (computed-key o['f']=fn works) — closed-method dispatcher had no field-stored-closure arm"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3100s4
sprint: 71
model: fable
created: 2026-07-09
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: functions, objects
goal: standalone-mode
umbrella: 2860
related: [3100, 3098, 1888, 2664, 2866, 3119]
origin: "2026-07-09 fable-3100s4 prove-first probe after #3100 S5 measured zero test262 flips — the *-close cluster bottoms out on the dynamic-$Object function lane; #3098's author stood down, lane unowned. Split from the original two-slice #3117: the $Object @@iterator protocol arm is now #3119."
---

# #3117 — $Object dot-member-set stored-closure invocation

## Problem (verified against origin/main @ abdaabf, 2026-07-09, standalone)

Storing a function onto an `any`-typed object via a **dot** member-set drops
the closure at the CALL site — the value is stored, but the call returns
`undefined`. The computed-key twin works. Differential probes:

```ts
const o: any = {};
o["f"] = function () {
  return 7;
};
o.f(); // ✓ 7  (computed set)
o["g"] = (x) => x + 1;
o.g(4); // ✓ 5  (computed set)
o.f = function () {
  return 7;
};
o.f(); // ✗ 0  (dot set — silently uncallable)
o.f = () => 7;
o.f(); // ✗ 0  (dot set)
o.g = (x: number) => x + 1;
o.g(4); // ✗ 0  (dot set + arg)
```

Arrow vs function-expression is irrelevant — it is **dot-set vs
computed-set**.

## Root cause (WAT-traced)

The `{}` literal is pre-shaped into a **closed WasmGC struct** whose
externref field `f` receives the closure via `struct.set` (the dot-set path,
literals.ts). At the call `o.f()`, the any-receiver method dispatcher
`__call_m_f_0` (closed-method-dispatch.ts) type-switches over structs having
a `<Struct>_f` **method** func — but this struct has no method `f`, it has a
**field** `f` holding a boxed closure. No arm matched → the open-`$Object`
bottom arm → `__extern_method_call` → the field isn't a registered method
either → `undefined`.

The computed-key store (`o["f"]=`) instead goes through a genuine `$Object`
property store (`__extern_set`), and `o.f()` on that shape reads the field
through the open-`$Object` method-call path that DOES look up stored-callable
values — hence the asymmetry.

The #3098/#1888 invocation machinery (`__apply_closure`, boxed-closure
read-back, `__call_fn_method_N`) is COMPLETE and reachable; only the
dispatcher's arm set was missing the field-stored-closure case.

## Fix

`collectFieldEntries` (closed-method-dispatch.ts): every closed struct (same
filter as `collectMethodEntries`, and a `<Struct>_<name>` **method** still
wins) that has an externref FIELD named `<name>` gets a dispatcher arm —
`ref.test <struct>` → read the field → null ⇒ `undefined` (the pre-#3117
miss semantics, NOT a TypeError; that refinement rides the error lane) →
else `__apply_closure(fn, recv, argvec)` (args marshaled to a fresh `$ObjVec`,
same shape as the bottom arm). Added to BOTH the fixed-arity and vararg fills.
`__apply_closure` is reserved at dispatcher-reserve time (it fills before this
pass and degrades to the undefined sentinel when no closure dispatcher exists
— never traps).

## Validation (all measured, branch vs main)

- 6/6 differential probes flip (dot-set arrow/fn-expr/named, with and without
  args, computed control unchanged).
- S4/S5 (#3100) + #2151 dispatch suites green; the 1 mixed-spread fail is
  byte-for-byte pre-existing on main (verified).
- LOC ratchet green.

## Follow-up

The plain-`$Object` `@@iterator` protocol arm (#3100 Design arm 3 — 810
post-hoc-`x[Symbol.iterator]=fn` test262 files, 0 host-free) is a separate
S1-grade design slice, split out as **#3119**. It reuses this lane's
`__apply_closure` invoke plus a new `__iterator` OBJ ladder arm.
