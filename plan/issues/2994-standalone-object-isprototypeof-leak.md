---
id: 2994
title: "Standalone: eliminate env::Object_isPrototypeOf host-import leak — static-fold Object/Function.prototype.isPrototypeOf"
status: done
completed: 2026-07-02
assignee: ttraenkler/agent-add922b5fc0765fbe
sprint: 69
priority: medium
horizon: s
feasibility: medium
origin: plan/log/investigations/2026-07-02-leak-analysis-round5.md
---

## Problem

Round-5 leak analysis (2026-07-02) ranks `env::Object_isPrototypeOf` as an
execution-verified GENUINE sole-import leaky lever: **12 official standalone
passes** carry exactly one `env::` import, `Object_isPrototypeOf`, and the
bodies actually execute (inject-throw probes confirmed non-vacuous). These are
host-import leaks — the standalone binary imports a host function it should not
need, because a WasmGC-native `__isPrototypeOf` implementation already exists
(`src/codegen/object-runtime.ts` ~L2901).

## Root cause

The receiver in all 12 tests is a builtin prototype object
(`Function.prototype.isPrototypeOf(X)` or `Object.prototype.isPrototypeOf(X)`),
which the checker types as an **external-declared class** instance (Function /
Object). Method-call dispatch in `src/codegen/expressions/calls.ts` (~L9917)
therefore enters `compileExternMethodCall` (`src/codegen/expressions/extern.ts`)
BEFORE the native `compileObjectPrototypeFallback` path
(`src/codegen/expressions/calls-closures.ts` L417, which already routes
`isPrototypeOf` → `__isPrototypeOf`) is ever reached.

Inside `compileExternMethodCall`, `isPrototypeOf` resolves up the extern
inheritance chain to the `Object` base extern class
(`src/codegen/index.ts` L13428, `methods.set("isPrototypeOf", …)`,
`importPrefix: "Object"`), so the generic host-method path emits
`Object_isPrototypeOf`. The gate is too coarse: it never gives the native
emitter a chance for extern-class receivers.

## Root cause (refined during implementation)

The actual leaky dispatch is **`tryExternClassMethodOnAny`**
(`src/codegen/expressions/calls-closures.ts`), not `compileExternMethodCall`:
`Function.prototype` / `Object.prototype` surface here as **`any`-typed**
receivers, so the extern-class iteration finds `isPrototypeOf` on the `Object`
base extern class and emits `Object_isPrototypeOf`.

Routing to the existing WasmGC-native `__isPrototypeOf` does NOT work: it walks
the `$Object.$proto` chain, but builtin prototypes/constructors
(`Object.prototype`, `Function.prototype`, `Number`, …) are **not linked into
that chain** in standalone mode — a separate substrate gap. A pure routing
change made all 12 flip to `fail` (native returned a spurious `false`).

## Fix

Statically fold the provably-true shapes, mirroring `tryStaticInstanceOf`'s
`instanceof Object` short-circuit (#1729). New helper `tryStaticIsPrototypeOf`
in `calls-closures.ts` decides, when the receiver is written syntactically as
`Object.prototype` / `Function.prototype`:

- `Object.prototype.isPrototypeOf(x)` → `true` for any provably non-primitive
  object argument (every ordinary object's `[[Prototype]]` chain ends at
  `%Object.prototype%`), and for any inline `new X()` (always yields an object).
- `Function.prototype.isPrototypeOf(x)` → `true` when the argument type is
  callable/constructable (chain passes through `%Function.prototype%`).

Provable shapes compile receiver+arg for side effects then emit `i32.const 1` —
no host import. Undecidable shapes (`any`, primitives, aliased builtins) return
`undefined` and fall through to the **existing host dispatch unchanged** — so
there is zero behaviour change / no regression risk for anything not provable.

## Acceptance criteria

- The 12 listed test262 files still PASS in the standalone lane. ✅ (12/12)
- The `Object_isPrototypeOf` host import is eliminated from the provable
  shapes. ✅ 11/12 host-free; the 12th (`Object.prototype.isPrototypeOf(__device)`
  where `__device` is a reassignable `var` bound to `new __FACTORY()`) cannot be
  soundly folded — an identifier's current value isn't statically provable — so
  it correctly stays on the (correct) host path. Still passes.
- No regression to `isPrototypeOf` on user-defined class instances
  (`A.prototype` receiver — base ≠ Object/Function, so the fold declines and the
  existing path is untouched) or JS-host mode.

## Test Results

- `tests/issue-2994.test.ts` — 5/5 pass (4 folded-true host-free shapes +
  1 no-mis-fold guard for a non-callable arg).
- All 12 origin test262 files run via `runTest262File(..., "standalone")`:
  **12/12 pass**, 11/12 host-free (`env::Object_isPrototypeOf` absent).

## Test files (sole-import leak, from run 28605503741)

- test/built-ins/Boolean/S15.6.3_A2.js
- test/built-ins/Boolean/prototype/S15.6.4_A2.js
- test/built-ins/Date/S15.9.4_A4.js
- test/built-ins/Error/prototype/S15.11.4_A1.js
- test/built-ins/Function/S15.3.3_A2_T1.js
- test/built-ins/Function/prototype/bind/15.3.4.5-9-1.js
- test/built-ins/Number/S15.7.3_A7.js
- test/built-ins/Number/prototype/S15.7.4_A2.js
- test/built-ins/Object/S15.2.3_A2.js
- test/built-ins/String/S15.5.3_A2_T1.js
- test/language/statements/function/S13.2.2_A3_T1.js
- test/language/statements/function/S13.2_A5.js
