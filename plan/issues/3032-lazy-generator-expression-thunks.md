---
id: 3032
title: "Lazy-first-resume generator thunks: stop running eager-buffer generator bodies at creation (unblocks #2141 S3 / #2626 classifier)"
status: in-progress
assignee: ttraenkler/fable-tag5
sprint: current
created: 2026-07-04
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, generators, value-rep
language_feature: generators, destructuring defaults, equality
goal: test262-conformance
related: [2141, 2626, 2040, 2585, 928, 2203, 991]
origin: "2026-07-04 #2141 S2 root-cause (fable-tag5): the −162 dstr eject was never a dstr/eq dependency — it was eager generator bodies + comparator vacuity"
---

# #3032 — eager-buffer generators run their body AT CREATION; the tag-5 comparator vacuity is the only thing hiding it

## Root cause (S2 of #2141, fully verified 2026-07-04)

The eager-buffer generator lowering (#991/#928 era) compiles a generator to:
run the whole body NOW, buffering yields (`__gen_create_buffer` +
`__gen_push_*`), then `__create_generator(buffer, pendingThrow)` whose host
object replays the buffer on `next()`. That means **the body's side effects
happen at generator-object creation**, violating §27.5 (a generator suspends
at start-of-body; nothing runs until the first `next()`).

Which generators take this path:

- **Anonymous generator function expressions** (`function*(){}` — incl. the
  ubiquitous test262 dstr fixture IIFE `var iter = function*() { iterations += 1; }();`)
  — `isNativeGeneratorCandidate` requires `decl.name`, so they can never be
  native (closures.ts eager branch).
- **Nested capturing generators** (#2203) — the native state struct has no
  capture slots. The test262 wrapper puts every test inside
  `export function test() { ... }`, so in wrapped tests even NAMED generators
  touching test-scope vars are nested+capturing → eager.
- Method generators using `arguments`/`super`/captures; object-literal
  method generators with defaults (class-bodies/literals bail conditions).

Why nobody saw it: the harness comparator masks it. `assert.sameValue` /
`isSameValue(a: any, b: any)` params ride the externref ABI; inside, each
operand is boxed per-use via `__any_box_string` (the #1888 tag-5 lie).
Legacy tag-5 non-string eq answers `0` — so a lie-boxed value is
**self-unequal** (fake NaN), and `isSameValue`'s
`a === b || (a !== a && b !== b)` returns **TRUE for every pair of lie-boxed
operands**. `assert.sameValue(iterations, 0)` with `iterations === 1` passes
vacuously. The #2626 classifier arms (numeric `f64.eq`, object `ref.eq`)
each make self-compare honest, closing the escape → the −162 "regression"
(class/dstr cluster) is **unmasking, not breakage**. Bisect artifacts: WAT
trace shows the ONLY `__any_strict_eq` callers in the canary module are the 3
`isSameValue` sites; probe `v8` (`return iterations*100+7` right after the
fixture) returns **107** on the pre-fix compiler — the body ran at creation.

## Slice 1 (landed with the #2141-S2 PR): lazy-first-resume thunks for zero-param expressions

Mechanism (no new imports, no funcidx shifts, no body-splitting):

- **Wasm** (`src/codegen/closures.ts`, generator branch of
  `compileArrowAsClosure`): for `!isAsync && parameters.length === 0`, the
  historical eager sequence is wrapped in
  `if (global $__gen_eager_mode) { <eager, byte-for-byte> } else { return __create_generator(extern.convert_any(self), null) }`.
  The eager arm CLEARS the flag at its top (nested creations during a
  deferred run stay lazy). `ensureGenEagerFlag` reserves the `mut i32`
  global + exports a `__gen_set_eager(i32)` setter. Branch-target safe: all
  body `br`s target the inner block/try; `return` is depth-independent.
- **Host** (`src/runtime.ts`): `__create_generator` detects a non-Array
  first arg as a THUNK (the closure itself, opaque externref).
  `next()` materializes: `__gen_set_eager(1)`; `__call_fn_0(thunk)` (the
  closure re-runs, taking the eager path); adopt the inner generator's
  `{buf, pendingThrow, retVal}`; `__gen_set_eager(0)` in a finally.
  `return()`/`throw()` before the first `next()` DROP the thunk without
  running the body (§27.5.3.2 GeneratorResumeAbrupt on suspendedStart —
  strictly more spec-correct than eager).
- **Contract**: consumers of `buildImports` MUST wire
  `setExports(instance.exports)` (already required for wasm-closure interop
  — `wrapForHost`; the runner does). Missing wiring → clear TypeError at
  first resume only.

Verified: probes v10/v12 (creation runs nothing, was `log=2`), v15
(resume/drain/done exact), v16/v17 (return/throw-before-start never run the
body), dstr canary `meth-dflt-ary-ptrn-empty` + siblings green **with the
classifier force-enabled** (the #2141-S2 deliverable), 24-file
class/dstr `dflt` sample byte-of-behavior identical under the default
(legacy) comparator: 18 pass / 6 fail before and after.

## Banked waves (Opus-executable, in dependency order)

- **W2 — paramful generator expressions.** The thunk re-invocation goes
  through `__call_fn_0` (self only), so params can't replay. Approach: at
  creation, spill args into the existing ref-cell machinery (a synthesized
  capture env: `{argCell0..argCellN}` appended to the closure struct via a
  SECOND struct instance sharing the funcref) and gate `genLazyEligible` on
  "params spilled". Alternative (simpler): keep eager for paramful
  expressions — measure first; the test262 fixture corpus is ~all
  zero-param.
- **W3 — nested capturing NAMED generators** (`function* g() {...}` inside
  the test wrapper — probe v14 shape, fails honestly on main today). Two
  routes: (a) compile nested named generators AS closure values through the
  same lazy branch (they already fall to an eager path — find it in
  `nested-declarations.ts` / function-body.ts:1038 and apply the same
  if-flag wrap; the creation call site must pass the closure self);
  (b) native-generator capture slots (#2203 proper): store the capture
  cells in the state struct. (a) is the cheap unblock, (b) the endgame.
- **W4 — method generators** (class-bodies.ts:2271 eager arm — the
  `gen-meth-*` dstr shapes that still flip under the classifier; they
  capture test-scope vars so they bail native). Same if-flag wrap; the
  creation site is the method call itself (spec: param
  dstr/defaults run eagerly at call — KEEP that — only the BODY suspends;
  the eager arm must split param-instantiation from body, so W4 is NOT a
  pure wrap — param handling stays outside the flag branch).
- **W5 — `retVal`/`return(v)` marshalling**: `g.return(42).value` and
  `return 9`-observation round-trip an opaque `$BoxedNumber` through
  `__gen_result_value_f64` → `Number(opaque)` throws (pre-existing,
  standalone). Route through `exports.__sget_value` / `__unbox_number`
  fallback in `__gen_result_value*`.
- **W6 — retire the buffer**: real suspension (native state machine for all
  shapes) makes the buffer+thunk model obsolete; `yield` two-way
  communication (`next(v)` value into the body) is impossible under
  buffering and stays broken until W6.

## Interaction with #2141/#2626 (the ordering law)

The classifier (`tag5ValueEqClassifier`, in-tree, default OFF) may flip its
default (#2141 S3/S4, #2626 acceptance) only after enough waves land that
the **merge_group standalone floor** clears: every vacuous pass the
classifier unmasks must first be made a GENUINE pass by laziness. Measure
with `JS2WASM_TAG5_CLASSIFIER=1 pnpm run test:262` A/B per wave.
