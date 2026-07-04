---
id: 2957
title: "Async activation for arrows / methods / function expressions (both CPS + drive hooks are declaration-only)"
status: in-progress
assignee: ttraenkler/opus-2957p1
sprint: current
created: 2026-07-02
updated: 2026-07-04
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: async
goal: async-model
related: [1796, 2906, 1042, 2612]
origin: "2026-07-02 July Fable audit §2 (both activation hooks require ts.isFunctionDeclaration)"
---

# #2957 — async arrows, methods, and function expressions never activate a state machine

## Problem

Both async activation hooks gate on `ts.isFunctionDeclaration`
(`src/codegen/function-body.ts:1163` — WASI drive layer, `:1185` — JS-host
CPS). An `async` arrow function, class method, object-literal method, or
named/anonymous function expression therefore always falls to the legacy
synchronous pass-through model, even when its body is exactly the canonical
shape `asyncFnNeedsCps` / `asyncFnNeedsDrive` would accept. This silently
caps both the host CPS lane and the standalone drive lane to a syntactic
subset; test262 async tests overwhelmingly use arrows and methods.
(#2612 covers the call-site side only; no issue covered activation.)

## Approach

1. Factor the activation predicate to accept any function-like node with a
   body (`ts.isFunctionLike` minus constructors/accessors), threading the
   correct name/slot context for each shape (arrows capture `this`
   lexically — verify interaction with the closure capture machinery;
   methods carry the class-shape typeIdx parity contract).
2. Land per-shape, measuring each: function expressions → arrows → methods
   (riskiest last: interacts with #1370 class registry + `integration.ts`
   parity guard).
3. Extend the async equivalence suite with the canonical single-tail-await
   body in all four syntactic shapes × host/WASI lanes.

## Acceptance criteria

- The canonical `const f = async (x) => await g(x)` activates CPS (host)
  and the drive machine (WASI); result observed as a real Promise / driven
  frame respectively.
- Full merge_group net-positive; no regression in the async-\* equivalence
  suite (legacy-model tests updated only where the shape now genuinely
  returns a Promise — same migration rule as #1796).

## Measurement (2026-07-03, dev, host lane, `upstream/main` @ 0369c1ee7)

Canonical single-tail-await body `await g(x)` in all four shapes, compiled
host-mode, `f(1)` inspected in JS for `typeof result.then === 'function'`:

| shape                    | `f(1)` returns     | activated? |
| ------------------------ | ------------------ | ---------- |
| `async function` decl    | real Promise (→ 2) | YES        |
| `const f = async () =>`  | sync number `2`    | **NO**     |
| `const f = async fn(){}` | sync number `2`    | **NO**     |
| class `async method`     | sync number `2`    | **NO**     |

Confirms the bug for all three non-declaration shapes. (Note a naive probe
that assigns the result into an `any`/externref slot and checks
`typeof === 'object'` FALSE-POSITIVES: the sync `f64` result is boxed by
`__box_number`, so a boxed number reads as `object`. The authoritative
signal is thenability of the raw exported externref — probe kept at
`.tmp/probe2-2957.mjs`.)

## Root-cause correction — the Approach's premise is wrong

Approach step 1 ("factor the activation predicate" at
`function-body.ts:1163/1185`) is **necessary but far from sufficient, and by
itself accomplishes nothing for the three broken shapes.** The two async
activation hooks live inside `compileFunctionBody`, and **arrows, function
expressions, and methods never call `compileFunctionBody`:**

- **arrows + function expressions** → `compileArrowFunction` in
  `src/codegen/closures.ts` (its own lifted-`fctx` + `compileStatement` loops
  at ~2421/2456). `compile­FunctionBody` is only reached by top-level
  `ts.isFunctionDeclaration` and the CJS `module.exports.x = function(){}`
  pattern (`declarations.ts:4981`) — not by `const f = async function(){}`.
- **class methods** → `src/codegen/class-bodies.ts` (its own body loops at
  ~1918/2293/2341/2445/2599/2778).
- **object-literal methods** → `src/codegen/literals.ts` (~2705/2739).

So broadening the `ts.isFunctionDeclaration` guard changes behaviour only for
CJS-exported async function expressions (a near-empty set). The real work is
**wiring the async-activation decision into each of the three separate
body-compile paths.**

## Implementation Plan (developer scoping, 2026-07-03) — L/XL, slice it

Good news: the machinery is already shape-agnostic below the hook. All of
`analyzeAsyncBody`, `asyncFnNeedsCps`, `asyncFnNeedsDrive`,
`asyncFnNeedsHostDrive`, `emitAsyncStateMachine`, and
`emitAsyncFrameStateMachine` already take `ts.FunctionLikeDeclaration` and
build the frame from `fctx.params` + the body — no declaration assumption in
the emitters themselves. The gap is purely that nobody _calls_ them from the
arrow/method paths.

Recommended factoring: extract the activation block from `function-body.ts`
(lines ~1160–1210) into a reusable
`maybeActivateAsync(ctx, fctx, decl, func): boolean` in a shared module
(e.g. `async-frame.ts` or a new `async-activation.ts`). It performs the
carrier/host gating, calls the predicates, rewrites the result type to
externref, and drives the right emitter. `compileFunctionBody` calls it; the
three other paths call it at the equivalent "about to run the body statement
loop" point.

Slice order (each an independent, measurable PR):

1. **Refactor-only (byte-inert net behaviour):** extract
   `maybeActivateAsync` and have `compileFunctionBody` call it. Prove
   fn-decl still activates and merge_group is net-zero. Establishes the shared
   entry point with no shape change.
2. **Function expressions + arrows (`closures.ts`).** Call
   `maybeActivateAsync` in `compileArrowFunction` before its statement loop.
   **The real risk lives here:** the lifted `fctx.params[0]` is the
   closure-struct / `__self` ref, so `buildAsyncFrameInfo` (which spills every
   `fctx.param`) and the resume-function reconstruction must treat param 0 as
   the environment, not a user arg. Arrows also capture `this` lexically —
   verify the spill/restore of captured cells survives suspension. Likely
   needs a `selfParamCount`/`envParam` hint threaded into
   `buildAsyncFrameInfo`. Measure fn-expr and arrow separately.
3. **Methods (`class-bodies.ts` then `literals.ts`), riskiest last.**
   Interacts with the #1370 class registry + `integration.ts` typeIdx parity
   guard; `this` is param 0 with the instance struct type. Wire the same
   entry point into each method body loop.
4. **Equivalence coverage:** extend `tests/async-await.test.ts` with the
   canonical single-tail-await body × {arrow, fn-expr, method} × {host, WASI}.
   Migrate any legacy sync-model async tests that now genuinely return a
   Promise (same rule as #1796).

### Scheduling caution (hazard zone)

The async frame/CPS substrate is being actively reshaped by ~8 concurrent
branches (#2895 async-frame PR2 / drain-hook / drive-1b, #2865, #2867, #2906
gap3-tryfinally, #2971 widen-final, #2905 promise-carrier, #2993). Slices 2–3
edit `closures.ts` / `class-bodies.ts` and lean on `buildAsyncFrameInfo` /
`ensureAsyncResumeFunction` — high collision surface. Recommend landing this
**after** the #2895 async-frame series settles, and re-scoping to `horizon: l`
(done). Slice 1 (the refactor) is safe to land now and de-risks the rest.

## Phase 1 landed (2026-07-04, opus-2957p1) — shared entry point extracted

Slice 1 (the byte-inert refactor) is complete. The two async activation
blocks in `compileFunctionBody` (`function-body.ts`, formerly ~1160–1210)
plus the local `rewriteFuncResultType` helper were extracted verbatim into a
new shared module `src/codegen/async-activation.ts`, exporting:

```ts
export function maybeActivateAsync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration, // widened from FunctionDeclaration for phases 2–3
  func: WasmFunction,
): boolean; // true ⇒ caller skips its statement loop (body already emitted)
```

`compileFunctionBody` now calls it; the internal `ts.isFunctionDeclaration`
guards are preserved unchanged, so **declaration** activation is untouched.

**Byte-inert proof (acceptance gate):** compiling the full
`website/playground/examples` + `examples` corpus (26 sources) × {gc, wasi,
standalone} plus all four async shapes (`decl`/`arrow`/`fnexpr`/`method`) +
multi-await, then sha256-ing every emitted binary, yields the identical
`CORPUS_SHA256=161cd89fb5a298fb86c76af6fcdcd787f42f340ba6ce988fecaf08cc78a18d4b`
before and after the change (62 compiles, 16 CE, all matching). `tsc --noEmit`
clean.

**Re-grounding note (#2906 hazard check):** the async-frame area was reshaped
by #2906's multi-state CFG machine this week. Re-verified against current main
(`1f77d0f70`): the two activation hooks are structurally intact (drive-lane +
CPS/host-drive lane, both still `ts.isFunctionDeclaration`-gated), so phase 1
remained a clean byte-identical extraction. No re-scope needed.

**Phases 2–3 remain open** (the real behaviour change): wire
`maybeActivateAsync` into `compileArrowFunction` (`closures.ts`) for
fn-exprs+arrows, then class/object-literal methods (`class-bodies.ts` /
`literals.ts`). These require the `envParam`/`selfParamCount` threading into
`buildAsyncFrameInfo` described in the Implementation Plan above and interact
with the still-active async-frame branches — higher risk, schedule after that
series settles.
