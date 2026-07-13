---
id: 3130
title: "Standalone: native Error objects lack `.constructor` / `.name` — blocks resolve-settled-*-self acceptance"
status: done
assignee: ttraenkler/fable-3130
sprint: 71
created: 2026-07-10
updated: 2026-07-13
completed: 2026-07-10
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: errors
goal: standalone-mode
related: [3128, 3125, 2980]
origin: "#3128 drill — after the assignment/capture fix (A+B) and the zero-arg resolve() dispatch fix (C), the resolve-settled-*-self files fail ONLY on `reason.constructor !== TypeError`"
---

# #3130 — native Error `.constructor` / `.name` identity (standalone)

## Problem (measured on the #3128 branch, standalone, 2026-07-10)

```ts
export function test(): number {
  var e: any = new TypeError("x");
  return e.constructor === TypeError ? 1 : 0; // ← returns 0
}
```

- `e.constructor` reads back `undefined` (probe: `.tmp/repro-3128-ctor2.mts`
  in the #3128 worktree — recreate trivially from the snippet above).
- `e.name === 'TypeError'` ALSO fails (returned r=11 in the
  instanceof/name probe: instanceof TypeError ✓, instanceof Error ✓,
  `.name` ✗).
- `typeof e.constructor` throws "Cannot convert object to primitive value".
- Same result for a CAUGHT TypeError (`try { null.foo } catch (e) {…}`).
- `e instanceof TypeError` / `e instanceof Error` both work — the brand
  chain is fine; only the property surface is missing.

## Why it matters

`test262/test/built-ins/Promise/prototype/then/resolve-settled-fulfilled-self.js`
and `resolve-settled-rejected-self.js` (the #3128 acceptance files) assert the
§27.2.1.3.2 self-resolution rejection via
`reason.constructor !== TypeError`. After #3128 landed the capture/assignment
fix and the zero-arg `resolve()` dispatch fix, the whole promise machinery is
spec-correct on the widened standalone lane (verified: the reject handler runs
with a TypeError instance, `instanceof` passes) — the ONLY remaining failure
is this property read. The pattern (`err.constructor === XError`, `err.name`)
is a common test262 idiom, so the fix likely flips more than these two files.

## Acceptance

- `new TypeError('x').constructor === TypeError` → true (standalone, and the
  other native error ctors: Error/RangeError/ReferenceError/SyntaxError/
  EvalError/URIError).
- `new TypeError('x').name === 'TypeError'` → true; `.name` inherited
  per spec (own property of the ctor prototype, not the instance).
- Caught runtime-thrown errors (e.g. null deref TypeError) expose the same
  `.constructor` / `.name`.
- `resolve-settled-fulfilled-self.js` + `resolve-settled-rejected-self.js`
  flip to pass on the widen arm (`JS2WASM_ASYNC_CARRIER_WIDEN=1`,
  `runTest262File(..., "standalone")`).
- No regressions in the error-object suites.

## Notes

- The identity requirement is two-sided: the error struct's `.constructor`
  read must return the SAME function object the bare `TypeError` identifier
  evaluates to (strict-equality on the binding, not just a same-named
  function). Check how `instanceof` resolves the ctor brand — the fix can
  likely reuse that anchor.
- Related pre-existing gap seen in the same drill (do NOT conflate): `===`
  identity on $Promise values routed through any-typed vars fails standalone
  (`seen === p1` false even with no self-capture — the tag-5 host-only
  strict-eq arm, see `reference_2583_any_strict_eq_tag5_host_only`).

## Implementation notes (fable-3130, 2026-07-10)

### Root cause — TWO dropped links, not one

**Link 1 — `__extern_get` had no `$Error_struct` arm.** The universal dynamic
property reader (`__extern_get` in `ensureObjectRuntime`,
`src/codegen/object-runtime.ts`) — the terminal every `any`-receiver read
routes through (`__dyn_get`, `__get_member_<name>` dispatcher fallbacks,
generic property reads) — unwraps its receiver to `$Object` and answers a
miss (undefined) for anything else. A native Error is an `$Error_struct`
(fields: 0=tag, 1=message, 2=name, 3=stack, 4=userClassId, 5=props), NOT an
`$Object`, so every dynamic read missed. The static fast path in
property-access.ts only covers statically-Error-typed receivers and
`catch`-clause bindings — a promise rejection-callback parameter is neither.

**Link 2 — `tryEmitConstructorViaTag` null seed (the reason a first fix of
link 1 alone did NOT flip the acceptance files).** For an `any`-typed
`.constructor` read, `tryEmitConstructorViaTag`
(`src/codegen/property-access.ts`) intercepts at COMPILE time whenever the
module declares ≥1 tag-bearing user class — the test262 harness injects
`class Test262Error`, so that is essentially every standalone test262
program — and its standalone/WASI seed for the non-user-class case was a
hard `ref.null.extern`: the read never reached `__extern_get` at all.
(This is why bare probes outside the harness worked after fixing link 1,
while the harness-wrapped acceptance files still failed with
`typeof reason.constructor === "undefined"`.)

### Fix

1. **`fillExternGetErrorProps`** (`src/codegen/registry/error-types.ts`,
   called from index.ts finalize after `fillBuiltinFnMeta`): finalize-time
   fill that splices an `$Error_struct` arm into `__extern_get`, following
   the `fillBuiltinFnMeta` shift-safety discipline (by-name funcIdx reads at
   fill time, splice-not-rebuild, appended locals, runs before dead-elim).
   Arm order: `$props` sidecar (recursive `__extern_get` — accessors/proto
   resolve; nullish result falls through) → string-key dispatch (flatten
   once + `__str_equals`): `message`→f1, `name`→f2, `stack`→f3 →
   `constructor` → per-tag lazy `__builtin_<Name>` carrier global — the SAME
   global the bare `TypeError` identifier reads (#2907
   `emitBuiltinNamespaceObject`, same `ctx.builtinObjectGlobals` key), so
   `===` is genuine object identity. Gated on `$userClassId == -1` (user
   subclass instances keep today's miss rather than answering the WRONG
   parent ctor); the shared "Error" tag additionally requires the `$name`
   field to equal "Error" so a Test262Error (same tag, name
   "Test262Error") keeps its miss. Carrier globals are get-or-created at
   fill time (dead-elim never removes/renumbers globals; eager creation at
   ctor-emit time changed bytes on error-free standalone modules because
   the scaffold pre-registers `__new_TypeError` module-wide).
2. **Seed fix** in `tryEmitConstructorViaTag`: under standalone/wasi, seed
   the non-user-class result via the NATIVE `__extern_get`
   (`ensureObjectRuntime` + funcMap read) instead of `ref.null.extern`.
   Host/gc path unchanged (still the host `__extern_get` import); plain
   `strictNoHostImports` gc mode keeps the null seed.

### Measured (2026-07-10)

- Acceptance: `resolve-settled-fulfilled-self.js` + `resolve-settled-rejected-self.js`
  **fail → pass** on the widen arm (`JS2WASM_ASYNC_CARRIER_WIDEN=1`,
  standalone) on a local merge of this branch + the #3128 branch (PR #2843).
  On this branch alone they still fail (they need #3128's promise fixes —
  expected; measured to isolate).
- `new <Ctor>('x').constructor === <Ctor>` → true standalone for
  Error/TypeError/RangeError/SyntaxError (family probe 7/7);
  `.name === '<Ctor>'` → true; `typeof e.constructor` → "object" (no longer
  throws); instanceof unchanged; cross-identity (`TypeError` instance ctor
  `!== Error`) correct.
- Emit identity: gc/host mode byte-identical on ALL probes (incl. an
  error-using snippet); standalone byte-identical on error-free probes
  (numeric/strings/arrays/closures/classes); only standalone modules with
  BOTH the object runtime AND error ctors change (by design — errors are
  reachable there).
- Error-family test262 sweep (built-ins/NativeErrors + built-ins/Error,
  152 files, standalone lane): see `## Test Results`.

## Test Results (2026-07-10, local, standalone lane)

- **Acceptance files (widen arm, combined tree with #3128 / PR #2843):**
  `resolve-settled-fulfilled-self.js` fail→**pass**,
  `resolve-settled-rejected-self.js` fail→**pass**.
- **Error family** (built-ins/NativeErrors + built-ins/Error, 152 files, no
  widen flag): main pass 49 / fail 92 / CE 11 → branch pass 50 / fail 91 /
  CE 11. One flip: `built-ins/Error/message_property.js` fail→pass.
  **Zero regressions.**
- **Regression sweep** (built-ins/Promise/prototype/then +
  language/statements/try, 276 files, widen arm): main == branch
  (pass 180 / fail 91 / CE 5, per-file diff empty).
- **Emit identity**: gc/host byte-identical on all probes (incl. an
  error-throwing snippet); standalone byte-identical on error-free probes.
- **vitest slice** (issue-1104-*, issue-1536*, issue-1597, issue-2029-*,
  error-reporting*): 56 pass / 8 fail on branch — the SAME 8 fail on main
  (pre-existing environmental WASI failures, not regressions).
- tsc clean; prettier clean; loc-budget baseline regenerated for intended
  growth (property-access +20 seed fix, index.ts +7 fill call).

### Scoping notes / follow-ups (NOT fixed here)

- **Runtime-thrown null-deref "TypeError" standalone is a plain STRING**
  (`typeof e === "string"`, `instanceof` fails too — pre-existing, measured
  on main): the acceptance bullet "caught runtime-thrown errors expose
  `.constructor`/`.name`" holds for errors built via `__new_<Ctor>`
  (`emitThrowJsError` sites, the promise machinery) but CANNOT hold for the
  string-throwing sites until those construct real `$Error_struct`s —
  separate issue.
- `typeof TypeError === "function"` standalone reads "object" (the #2907
  carrier is a plain `$Object`, not callable) — pre-existing carrier
  property, unchanged.
- `TypeError.name` / `.prototype` on the carrier object still miss —
  carrier stays prop-less (#2907 scope), unchanged.
- `__extern_has` / `__extern_set` (`'name' in e`, `e.name = ...`) still
  have no `$Error_struct` arm — reads only in this fix.
- User `class X extends Error` instances answer `.constructor` = miss
  (undefined), not `X` — honest gap, requires the user-class singleton via
  `$userClassId` dispatch (candidate follow-up).
