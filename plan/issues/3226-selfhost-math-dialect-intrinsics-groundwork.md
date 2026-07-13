---
id: 3226
title: "self-host stdlib: convert exp/pow/log10 to TS source (dialect-intrinsics groundwork NOT needed after all)"
status: done
assignee: ttraenkler/opus-selfhost2
sprint: Backlog
priority: medium
horizon: l
feasibility: medium
task_type: enhancement
area: codegen, ir, stdlib
language_feature: math-builtins
goal: ir-full-coverage
created: 2026-07-13
completed: 2026-07-13
depends_on: [3161, 3204]
related: [3141, 3159, 3160, 3233]
---

# #3226 — self-host exp / pow / log10 (dialect-intrinsics groundwork NOT needed)

## Outcome (2026-07-13): reframed — no new intrinsics required

The self-hosted-stdlib bloat track (#3141 → #3204) converts hand-emitted
`Instr[]` Math builtins into TS source in `src/stdlib/math.ts`, compiled through
our own IR driver. `exp`, `pow`, `log10` were the last cores presumed to need
**new dialect intrinsics** (i32 bit-ops + shift, f64↔i64 `reinterpret`, a sound
`f64.nearest`). **Verify-first tracing of the hand `Instr[]` bodies proved that
premise wrong** — all three are expressible in the EXISTING pure-f64 dialect,
converted exactly like `atan2` (#3233), with zero `select.ts` / `from-ast`
changes:

- **exp** — computes `2^n` by repeated SQUARING of the non-negative integer loop
  counter `ni` (the hand `ni & 1` / `ni >>> 1`). This is NOT IEEE
  exponent-field extraction / `reinterpret`; it is parity + halve of a small
  non-negative integer, exactly `ni - Math.floor(ni/2)*2` and `Math.floor(ni/2)`
  in f64 (bit-identical for a non-negative integer counter).
- **pow** — the same f64 exp-by-squaring for the integer-exponent fast path; the
  `i32.and` boolean combines become `&&`; the general path is
  `Math_exp(e·Math_log(|b|))`, calling the SAME self-hosted cores.
- **log10** — used `f64.nearest` only for a round-to-nearest-integer correction
  GATED by `|result - round| < 1e-12`. Within that guard `Math.floor(result+0.5)`
  (Math.floor is whitelisted) is bit-identical to `f64.nearest` — the
  round-half-to-even tie at `x.5` sits ~0.5 from any integer, orders of
  magnitude outside the guard, so it never enters it. One sign-of-zero fix-up
  (`f64.nearest(-4.3e-13) = -0` vs `floor(...)= +0`) restores the zero sign from
  `result` when the rounded value is 0.

I probed the self-host dialect (`from-ast`): it ALREADY lowers `%`, `&&`, `||`,
nested-if, `while` + mid-body-if, early-return-in-loop, `Math.trunc`, and the
`-0` literal survives to runtime. So the conversions are pure-f64, net −LOC,
zero compiler-internals risk. `random` stays hand-emitted — a host RNG import,
NOT a dialect gap.

## Why the original "intrinsics groundwork" is not needed (history)

The issue was filed presuming exp/pow needed `i32-local + shl/shr_u/and/or +
f64↔i64 reinterpret` and log10 needed a sound `f64.nearest` self-host intrinsic.
That was inferred from the *op families* the hand bodies emit (`i32.and`,
`i32.shr_u`, `f64.nearest`) without tracing what those ops actually COMPUTE. In
every case the computation is over small non-negative integers or a
guard-bounded near-integer, so the pure-f64 encodings above are exact. Building
the intrinsics dialect would have been correct but far larger and riskier
(touching `select.ts`'s whitelist + `from-ast` lowering); it is unnecessary for
this family. Kept as a note in case a FUTURE builtin genuinely needs bitwise
f64-representation surgery (none in the Math family does).

## What shipped

- `src/stdlib/math.ts`: `EXP_SOURCE`/`EXP_BUILTIN`, `LOG10_SOURCE`/`LOG10_BUILTIN`,
  `POW_SOURCE`/`POW_BUILTIN` (arity 2). `StdlibMathBuiltin` gained `arity?: 1|2`.
- `src/codegen/stdlib-selfhost.ts`: `mathBuiltinDef` honors `arity` → `[F64,F64]`.
- `src/codegen/math-helpers.ts`: hand `Math_exp` block, hand `Math_log10` block,
  and `buildPowBody` (~260 lines) deleted, replaced by one-line
  `emitSelfHostedMathFunc` calls at the same emission slots; dead `Instr[]`
  shorthands removed (`blockLoop`, `i32eqz`, `truncSatI32`, `i32sub`, `neg`,
  `fsqrt`, `ftrunc`, `fle`, `LN2`, `LOG2E`, `LOG10E`, `i32Type`).
- `tests/issue-3226.test.ts`: exp/pow/log10 specials + accuracy, host + standalone.

## Proof (the gate)

Each of the three bit-exact-validated against a `main`-built control (raw f64
bit-pattern comparison):

1. **Bit-exact**: ~10,900 cases = 1,626 boundary + 9,300 random. exp: 0/58
   boundary (+1,500 random); log10: 0/48 (+1,800); pow: 0/1,520 (+6,000). Dense
   at the risk boundaries: exp-by-squaring parity/halve at loop-count boundaries,
   large/negative/2^31 exponents, overflow (709.7) / underflow (-745) / subnormal
   edges, log10 values just in/out of the 1e-12 guard + exact powers of ten +
   sign-of-zero below 1, and ±0/NaN/±Inf/denormals throughout. **0 mismatches.**
2. **Containment**: programs not using exp/pow/log10 are byte-identical vs main
   (no-math, sin/cos/tan, log/log2, atan/asin/acos, random, and the exp-free
   derived subset cbrt/asinh/acosh/atanh/log1p all SHA-identical). Only direct
   users + `sinh/cosh/tanh/expm1` (transitive exp users) change — expected.
3. **Both pure-Wasm lanes**: `standalone` + `wasi` compile with ZERO host imports.
4. `tests/issue-3226.test.ts` (2) + `math-inline` + `issue-3141` (51) green;
   loc-budget + ir-fallback gates OK.

## Acceptance (met)

- exp/pow/log10 self-hosted (hand `Instr[]` deleted), bit-exact vs main (0
  mismatches), Math suites green, net −LOC.
- `random` remains hand-emitted (host RNG import, documented as not a dialect gap).
- Dialect-intrinsics groundwork determined UNNECESSARY for the Math family
  (rationale recorded above).
