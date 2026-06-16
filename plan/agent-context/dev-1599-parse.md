# dev-1599-parse — session context

**Session end:** 2026-06-03 (sprint 58)
**Role:** developer
**Status:** terminated cleanly — dev queue dry (all remaining tasks SENIOR-DEV/architect-blocked).

## Work landed this session

| Issue | PR | Task | Status |
|-------|-----|------|--------|
| #1599 JSON.parse primitive slice (number/bool/null), standalone | #1106 | #273 | MERGED |
| #1343 Date formatters Slice 4+5 residuals (negative-year DateString/UTCString min-4-digit padding) | #1112 | #184 | enqueued → landing |
| #1732 Symbol coercion: Math.* ToNumber(Symbol) must throw TypeError (§7.1.4 step 5) | #1114 | #280 | MERGED 2026-06-03T21:28Z |

## #1732 fix — root cause + approach (for any follow-up)

**Root cause:** `compileSymbolCall` (`src/codegen/literals.ts`) lowers `Symbol()` to an
**i32 global counter**, NOT an externref. In `compileMathCall`
(`src/codegen/expressions/builtins.ts`), each arg is compiled with an `f64Hint`; an i32
coerces straight to f64, so `Math.abs(Symbol())` silently leaked the raw counter as a number
instead of throwing.

**Fix (committed in #1114):** at the top of `compileMathCall`, detect a statically
`symbol`-typed argument via `isSymbolType(ctx.checker.getTypeAtLocation(a))`, evaluate all args
up to and including it for side-effects (source order), then `emitThrowTypeError(ctx, fctx,
"Cannot convert a Symbol value to a number")`. Mirrors the existing `Number(Symbol())` guard
(`calls.ts:7506`). New imports: `isSymbolType` from `checker/type-mapper.js`,
`emitThrowTypeError` from `expressions/helpers.js`.

**Why it's regression-safe:** the guard is gated on a static `symbol` type — it cannot fire on
override-free or non-Symbol code, so override-free modules stay byte-identical. The
`any`-typed path already worked (externref → f64 routes through `__unbox_number` which throws).
Confirmed by `merge shard reports` regression gate (no net regression).

**Known limitation:** only fires for statically `symbol`-typed args. `Math.abs(x as any)` or a
`symbol` hidden behind `any` will NOT throw at compile time — that path relies on the runtime
`__unbox_number` funnel (JS-host mode only). A standalone-Wasm runtime ToNumber(Symbol) throw
for dynamically-typed args is a separate, deeper change (not in scope for #1732).

## Pre-existing failures observed (NOT regressions — do not chase as my bugs)

- 3 tests in `tests/equivalence/symbol-basic.test.ts` fail on clean main base
  (well-known Symbol Number-coercion in the assertEquivalent harness). Unrelated to #1732.

## TaskList state at termination

No claimable dev task survived the pre-claim gate:
- **#122** (#1636 JSON.stringify replacer + toJSON) — issue `in-progress`, 3 agents active on the
  JSON.stringify codegen path (tasks #209/#217/#223). Direct file-conflict risk — do NOT hand to
  a single dev without coordinating the slice boundaries first.
- **#137** (#1609 non-literal spread in new-expression) — `blocked_on: [1620, 1633]`.

Everything else owned or tagged `[SENIOR-DEV]`/`[ARCH]`.
