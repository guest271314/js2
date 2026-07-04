---
id: 3013
title: "Standalone %ArrayIteratorPrototype% shared identity + Object-subclass native construction (host-free array-iterator cluster)"
status: done
assignee: ttraenkler/sendev-iterproto
completed: 2026-07-03
sprint: 69
created: 2026-07-03
updated: 2026-07-03
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: iterators, builtins
goal: standalone-mode
related: [2963, 3006, 2965, 2984]
origin: "2026-07-03 leak-analysis round 6 — the two remaining GENUINE sole-leak clusters (`env::__iterator` 9, `env::__new_Object` 5) that share #2963/#3006's builtin-object-identity substrate family"
---

# #3013 — %ArrayIteratorPrototype% shared identity (+ Object-subclass native construction)

## Problem

Round-6 leak analysis (`plan/log/investigations/2026-07-03-leak-analysis-round6.md`)
flagged two GENUINE sole-leak clusters that were earlier deferred as
"substrate-scale" **before** the #2963/#3006 builtin-object-identity reification
mechanism existed:

- **`env::__iterator` — 9 sole passes.** Array-iterator conformance
  (`Array.prototype.{values,keys,entries}/returns-iterator.js`) asserts
  `Object.getPrototypeOf([][Symbol.iterator]()) === Object.getPrototypeOf([].values())`
  — all array iterators share one `%ArrayIteratorPrototype%` (§23.1.5.2).
- **`env::__new_Object` — 5 sole passes.** `class X extends Object {}` leaks the
  `__new_Object` host import at construction; the passes were leaky (the runner
  supplies the host import).

## Resolution

### Cluster A — `%ArrayIteratorPrototype%` — SHIPPED (this PR)

Two changes, both standalone/WASI-guarded (host/gc lane byte-inert):

1. **`<array>[Symbol.iterator]()` → native `.values()`**
   (`src/codegen/expressions/calls.ts`, `@@iterator` element-access dispatch).
   Per §23.1.3.40 `Array.prototype[Symbol.iterator] === Array.prototype.values`,
   so an array receiver routes to the existing native `compileArrayMethodCall(…,
   "values")` path, producing an identical host-free `$__IterRec` instead of the
   `env::__iterator` host bridge. `.values()`/`.keys()`/`.entries()` were already
   native; this closes the `[Symbol.iterator]()` gap.

2. **`Object.getPrototypeOf(<array iterator>)` → shared native singleton**
   (`emitArrayIteratorPrototypeSingleton` in `src/codegen/array-object-proto.ts`,
   wired at the `getPrototypeOf` handler). One module-level `externref` mutable
   global, lazily `__new_plain_object()` — the same lazily-materialized
   singleton pattern #3006's `emitBuiltinConstructorIdentity` uses. Every array
   iterator routes through the SAME global, so identity is GENUINE. Detection is
   keyed on the TS checker's precise `ArrayIterator<T>` result type — distinct
   from `Generator`/`MapIterator`/`SetIterator`/`StringIterator` — so no other
   iterator kind is mis-routed (verified: those still return their existing
   value, unaffected).

**Genuineness (swap-wrong-value):** the shared prototype is genuinely equal
across all array iterators (values/keys/entries/[Symbol.iterator]/variable-flow)
AND genuinely DISTINCT from the array prototype, plain-object prototype, and
generator-iterator prototype (all three swap-guards fail as required — not a
coincidental null≡null). The 3 real test262 files
(`values|keys|entries/returns-iterator.js`) pass standalone host-free (they
leaked `env::__iterator` before). Regression-checked: for-of / spread /
destructuring over arrays intact; host/gc mode still emits `__iterator` /
`__getPrototypeOf` (byte-inert). Tests:
`tests/issue-3013-array-iterator-prototype-identity.test.ts` (8, all green).

### Cluster B — `class X extends Object {}` — DEFERRED (does not cleanly unlock)

**Honest finding: the reification substrate is NOT sufficient for cluster B; it
needs deeper native-prototype-model work and is split out as a follow-up.**

Making construction host-free is straightforward — route the Object-subclass
`super()`/implicit-ctor from the `__new_Object` host import to native
`__new_plain_object()` (§20.1.1.1: `super(...)` with NewTarget ≠ Object creates a
fresh ordinary object and ignores the argument). That removes the leak. **But it
regresses `regular-subclassing.js`** (`assert.notSameValue(Object.getPrototypeOf(
new X()), Object.prototype)`), because:

- **`emitSetSubclassProto` is a deliberate no-op standalone** (it depends on the
  `__set_subclass_proto` host import), so a native `__new_plain_object` instance
  keeps the plain `%Object.prototype%` default in its `$Object.$proto` slot.
- **For an externref-backed Object-subclass, `X.prototype` ITSELF collapses to
  `%Object.prototype%`** — there is no distinct native `$Object` prototype object
  for `X`. Verified (via local-bound comparison, avoiding the inline-`any`-arg
  coercion artefact): for a top-level `class X extends Object {}`,
  `X.prototype === Object.prototype === Object.getPrototypeOf(new X())` all
  collapse to the same object.

So genuinely fixing B requires a **distinct native `$Object` prototype per
externref-backed Object-subclass**, whose own `[[Prototype]]` is
`%Object.prototype%`, unified across THREE consumers: the `X.prototype`
value-read, the instance `[[Prototype]]` slot (set via native
`__object_setPrototypeOf`), and `Object.getPrototypeOf(instance)` (native
`__getPrototypeOf`, which reads `$Object.$proto` field 0). The native primitives
all exist and round-trip host-free (verified: `Object.setPrototypeOf(o,p)` then
`Object.getPrototypeOf(o) === p !== Object.prototype`), so this is tractable —
but it touches the shared subclass-of-builtin proto path (`emitSetSubclassProto`
is also used by `class … extends Error/DataView/…`), so it carries cross-subclass
regression risk and warrants its own scoped issue + validation. Shipping B's
construction change alone (a leaky-pass → host-free-FAIL flip) would be a net
regression, so it is intentionally excluded here.

**Follow-up:** carve a dedicated issue in the #2984 / sr-objsub native-object
lane — "distinct native `$Object` prototype for externref-backed Object
subclasses (host-free `class X extends Object`)". The `__new_plain_object`
construction routing + the native-proto-set helper prototyped in this session
are the starting point.
