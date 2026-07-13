---
id: 3123
title: "class C extends F (plain fnctor with runtime-assigned .prototype): instance member lookup does not reach F.prototype — Iterator-helper exhaustion/return-forwarding cluster"
status: done
completed: 2026-07-11
assignee: ttraenkler/fable-reconcile
sprint: 71
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
created: 2026-07-09
task_type: bugfix
area: codegen, runtime
language_feature: class-extends, iterator-helpers
goal: spec-completeness
test262_category: built-ins/Iterator/prototype
related: [3049, 3124, 3129]
loc-budget-allow:
  - src/codegen/index.ts
  - src/runtime.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/class-bodies.ts
  - src/codegen/class-member-keys.ts
  - src/codegen/declarations.ts
  - src/codegen/context/types.ts
  - src/codegen/statements/variables.ts
---

# #3123 — `class C extends F` over a runtime-assigned fnctor prototype

## Source

Split out of #3049 (fable-proto, 2026-07-09). After main's #3049 landed via
PR #2860 (spec chain depth + iterator-record shim, +14), a large
`built-ins/Iterator/prototype/*` residual stayed red with a DIFFERENT root:

```js
class TestIterator extends Iterator {
  next() { return { done: false, value: 1 }; }
  return() { ++returnCount; return {}; }
}
let iterator = new TestIterator().drop(0); // "Cannot read properties of null (reading 'drop')"
```

where `Iterator` is the test262-runner harness shim — a plain top-level
`function Iterator(){}` whose `.prototype` is ASSIGNED AT RUNTIME (module
init) to the helper-bearing `%IteratorPrototype%`:

```ts
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
```

The compiled `class TestIterator extends Iterator` wires its prototype chain
statically and never observes the runtime re-assignment of `F.prototype`, so
inherited helper reads (`.drop`, `.take`, `.filter`, …) resolve nowhere.

## Provenance — re-derivation of the parked stack (PRs #2835/#2839, both closed)

A previous implementation existed as a 2-PR stack that was auto-parked in the
merge queue with a REAL 99-file merged-baseline regression (bucket signature
`5c449d888de7d030`). Diagnosis of both merge_group runs (29079931503 for
#2835, 29063671945 for #2839) established:

- **The regression cluster came entirely from the STACK'S #3049 base**
  (#2835: net −43 on its own, +65/−99), not from the #3123 delta — #2839
  (stack + #3123) carried the IDENTICAL 99-file signature while adding +116
  improvements and no new regressions.
- The two regression roots in #2835, **deliberately NOT ported here**:
  1. **Bridge-exit marshaling wired into the generic `__call_fn` /
     `__cb_<id>` exits** (`_marshalBridgeResult` on every closure-bridge
     return) — implicated in ~85 dstr `*-ary-init-iter-close` double-close
     failures (`doneCallCount` 1→2). This port calls `_marshalBridgeResult`
     ONLY from the new fnctor-subclass member resolution, gated on the
     `_fnctorInstanceCtor` registration WeakMap.
  2. **`deferTopLevelInit` applied to the multi-module FIXTURE compile** —
     each linked module exported `__module_init`, so one binary carried two
     same-named exports → V8 "Duplicate export name" CompileError (6
     `language/module-code/*` files). This port gates the defer flag OFF for
     module-goal compiles at every harness site.
- Main's independent #3049 (PR #2860) captured only 14 of the stack's 181
  merged-run improvements; the rest of the cluster (105 files under
  `built-ins/Iterator/prototype` on the then-current baseline) remained red
  on main — the prize this re-derivation targets.

## What shipped (clean port off origin/main 12c45a7c)

Five codegen/runtime walls, each empirically re-verified on current main
before porting (the failure modes had shifted since the stack: main's #3074
keystones + #2860 changed the substrate):

1. **Layer-1 init keep (`src/codegen/declarations.ts`,
   `collectDeclarations`)** — top-level DIRECT `F.prototype = …` writes on a
   top-level function are now KEPT in `__module_init` for host/GC (the old
   exclusion assumed the standalone-only fnctor-prototype lift consumed them;
   in host mode they were silently elided, so the harness shim never ran).
   Receiver unwrapped through parens/`as`-casts (`(Iterator as any).prototype`).
2. **Host-side instance registration (`class-bodies.ts` +
   `class-member-keys.ts`)** — `${className}_init` tails a
   `__register_fnctor_instance(self, F_closure)` call (host lane, classes
   with a fnctor ancestor only — `fnctorAncestorOfClass`); the runtime records
   it in the existing #1712 `_fnctorInstanceCtor` WeakMap so
   `_fnctorProtoLookup` serves inherited reads through F's LIVE prototype.
   The lookup also gained a `__sget_prototype` struct-field fallback (the
   #2664 `__set_member_prototype` dispatcher can store the write in the
   closure struct's typed field slot, invisible to the sidecar read).
3. **Compiled methods/getters host-visible on instances (`index.ts`
   `emitClassMemberKindExports` + `runtime.ts`
   `_resolveClassMemberOnInstance`)** — per-module `__member_kind_<k>`
   (0 none / 1 method / 2 getter) + `__call_get_<k>` dispatch exports, gated
   on `moduleHasFnctorSubclass` so all other modules stay byte-identical.
   `_safeGet` / `_resolveHostField` consult them (arm gated on registration);
   getter reads run per-[[Get]] (the exhaustion tests' `get next()` mints a
   fresh generator per read — §27.1.4). Results marshal through a PRIVATE
   `_marshalBridgeResult` port (see provenance note 1). The
   `__gen_next/return/throw` dispatchers gained a registration-gated
   `_safeGet` miss-arm.
4. **Dynamic dispatch on fnctor-subclass method MISSES + widened bindings
   (`calls.ts`, `index.ts` pre-hoist, `statements/variables.ts`)** — a
   method MISS on a fnctor-subclass receiver routes through
   `emitFnctorSubclassDynamicMethodCall` (`__extern_method_call` mirror of
   the #799 WI3 arm) instead of the graceful-null tail; the any-receiver
   class-inference scan SKIPS fnctor subclasses; `let` bindings typed as a
   fnctor subclass with a foreign-typed reassignment
   (`iterator = iterator.drop(0)`) pre-hoist-widen to externref
   (`fnctorWidenedLocals`) and dispatch dynamically. Never-reassigned
   bindings keep static dispatch (guard test locked).
5. **#2818 carve-out flip (host defers derived capturers,
   `declarations.ts`)** — an EAGER capturing derived class nested in control
   flow (the try-block every test262 body sits in) compiled before the
   block-`let` exists, so `++returnCount` in a method lowered to a silent
   no-op. The standalone-protecting carve-out is now gated
   `ctx.standalone || ctx.wasi`; host defers derived capturers like base-less
   ones. (Also from the stack; unit-guarded by issue-2818/3128 suites, 62/62
   green.)

Plus the harness C1 model (from the stack, with the dup-export fix):
host-lane test262 compiles use `deferTopLevelInit` (export `__module_init`,
no `(start)` section) and the exec paths call it right after `setExports`,
so top-level code like the shim assignment runs against a fully-wired
runtime (`__sget_*` / `__vec_*`). **Module-goal compiles are excluded** at
every site (see provenance note 2).

## Measured (in-process runTest262File, my tree vs pristine-main control)

- **8-file target cluster: 6/8 flip to pass** (`{map,filter,drop}/
  exhaustion-does-not-call-return`, `{drop,take,filter}/return-is-forwarded`).
- **Natural home cluster (built-ins/Iterator/prototype +
  built-ins/Object/create, 693 files): base 447 → fixed 490, +66 fail→pass /
  −1 real pass→fail** (22 further chunked-run "downs" all pass in
  fresh-process isolation — the known #1957 realm-contamination artifact of
  the local in-process runner; CI's realm canary recycles workers on exactly
  this class).
- **Stack-regression corpus (the 99 non-CT files the parked stack broke):
  93/99 pass; all 6 fails are `language/module-code/*` local-runner
  artifacts reproduced byte-identically on pristine main** (module-goal
  compiles are defer-exempt, so their binaries are unchanged by this PR).
- Unit guards: issue-{3049,2818,3128,2628,2015,3123} — 62/62;
  issue-1712 family green except `capture-closure-dispatch` #3, reproduced
  UNCHANGED on pristine main (local Node-25 environment, documented by the
  stack too). tsc clean.

## Known residual (documented, not chased here)

- **flatMap inner-iterable flattening (3 files)**:
  `flatMap/exhaustion-does-not-call-return`,
  `flatMap/iterable-to-iterator-fallback`, and
  `flatMap/get-return-method-throws` (the −1 above — it "passed" on main
  only vacuously, via the unresolved-helper null path; with the helpers now
  real, the honest wall shows). Root: the native helper's
  GetIteratorFlattenable reads `Symbol.iterator`/`next` off the RAW wasm
  struct the compiled mapper returns. The stack fixed this with the generic
  bridge-exit marshaling — the exact change that double-closed ~85 dstr
  files. Needs a NARROW mapper-result marshal (follow-up), not the generic
  wiring.
- The kind-1 method bridge dispatches on the captured instance and ignores a
  re-bound `this` (`const f = it.next; f.call(other)`); parameterized
  methods report kind 0 and fall back (0-arg dispatchers only).
- #3124 (inherited reads over `Object.create(<struct>)` chains) remains a
  separate, measured-zero-yield substrate issue — see its notes on the
  closed PR #2842's branch.
