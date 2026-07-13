// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure Wasm implementations of Math transcendental functions.
 *
 * These replace host imports for Math.sin, Math.cos, Math.exp, Math.log,
 * Math.tan, Math.atan, Math.asin, Math.acos, Math.atan2, Math.pow,
 * Math.log2, Math.log10, Math.sinh, Math.cosh, Math.tanh,
 * Math.asinh, Math.acosh, Math.atanh, Math.cbrt, Math.expm1, Math.log1p.
 *
 * All implementations use polynomial (minimax/Chebyshev) approximations
 * with arithmetic range reduction. Precision target: within 4 ULP of
 * IEEE 754 for the common range.
 *
 * #3141/#3204/#3226 — nearly the whole family is now SELF-HOSTED: written as
 * ordinary TS source in `src/stdlib/math.ts`, compiled through the compiler's
 * own IR pipeline (`stdlib-selfhost.ts`) instead of hand-emitted `Instr[]` —
 * the derived family (sinh/cosh/tanh, asinh/acosh/atanh, cbrt, expm1, log1p),
 * the log/trig cores (log/log2, reduce_trig, sin/cos/tan, atan/asin/acos), and
 * exp/pow/log10 (#3226 established none needs new dialect intrinsics — the
 * presumed i32-bit-op / reinterpret / f64.nearest gaps are all avoidable in
 * pure f64). The ONLY Math core still hand-written here is `random` — a host
 * RNG import, not a dialect gap. (`atan2` self-hosts via #3233.)
 */
import type { Instr, ValType } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { emitSelfHostedMathFunc } from "./stdlib-selfhost.js"; // (#3141) self-hosted stdlib driver
import {
  SELF_HOSTED_MATH,
  LOG_BUILTIN,
  LOG2_BUILTIN,
  REDUCE_TRIG_BUILTIN,
  SIN_BUILTIN,
  COS_BUILTIN,
  ATAN_BUILTIN,
  TAN_BUILTIN,
  ASIN_BUILTIN,
  ACOS_BUILTIN,
  EXP_BUILTIN,
  LOG10_BUILTIN,
  POW_BUILTIN,
} from "../stdlib/math.js"; // (#3141/#3204/#3226) TS-source builtin bodies

// ─── Instruction shorthand helpers ──────────────────────────────────
const f64c = (v: number): Instr => ({ op: "f64.const", value: v }) as Instr;
const localGet = (i: number): Instr => ({ op: "local.get", index: i }) as Instr;
const localSet = (i: number): Instr => ({ op: "local.set", index: i }) as Instr;
const add: Instr = { op: "f64.add" } as Instr;
const sub: Instr = { op: "f64.sub" } as Instr;
const mul: Instr = { op: "f64.mul" } as Instr;
const div: Instr = { op: "f64.div" } as Instr;
const fabs: Instr = { op: "f64.abs" } as Instr;
const ffloor: Instr = { op: "f64.floor" } as Instr;
const feq: Instr = { op: "f64.eq" } as Instr;
const fne: Instr = { op: "f64.ne" } as Instr;
const flt: Instr = { op: "f64.lt" } as Instr;
const fgt: Instr = { op: "f64.gt" } as Instr;
const fge: Instr = { op: "f64.ge" } as Instr;
const ret: Instr = { op: "return" } as Instr;
const copysign: Instr = { op: "f64.copysign" } as Instr;
const i32const = (v: number): Instr => ({ op: "i32.const", value: v }) as Instr;

function ifThenRet(cond: Instr[], result: Instr[]): Instr[] {
  return [...cond, { op: "if", blockType: { kind: "empty" }, then: [...result, ret] } as Instr];
}

function ifElse(type: ValType, thenBody: Instr[], elseBody: Instr[]): Instr {
  return {
    op: "if",
    blockType: { kind: "val", type },
    then: thenBody,
    else: elseBody,
  } as Instr;
}

function call(funcIdx: number): Instr {
  return { op: "call", funcIdx } as Instr;
}

// ─── Constants ──────────────────────────────────────────────────────
const PI = Math.PI;
const HALF_PI = PI / 2;

// ─── Type aliases ───────────────────────────────────────────────────
const f64Type: ValType = { kind: "f64" };
const f64Param: ValType[] = [f64Type];
const f64Result: ValType[] = [f64Type];

type MathFuncDef = {
  name: string;
  params: ValType[];
  results: ValType[];
  locals: { name: string; type: ValType }[];
  body: Instr[];
};

/**
 * Emit pure Wasm implementations for the requested Math methods.
 * Methods are added as module functions (not imports) and registered
 * in ctx.funcMap under "Math_<method>".
 */
export function emitInlineMathFunctions(ctx: CodegenContext, needed: Set<string>): void {
  const addedFuncs = new Map<string, number>();

  function addMathFunc(def: MathFuncDef): number {
    const typeIdx = addFuncType(ctx, def.params, def.results, def.name + "_type");
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: def.name,
      typeIdx,
      locals: def.locals,
      body: def.body,
      exported: false,
    });
    ctx.funcMap.set(def.name, funcIdx);
    addedFuncs.set(def.name, funcIdx);
    return funcIdx;
  }

  function getFuncIdx(name: string): number {
    const idx = addedFuncs.get(name);
    if (idx === undefined) {
      throw new Error(`Math helper ${name} not yet added but referenced`);
    }
    return idx;
  }

  // ─── Math.random ──────────────────────────────────────────────────
  // #1322: WASI/standalone path. Uses `wasi_snapshot_preview1.random_get`
  // (registered as an import in declarations.ts:collectMathImports finalize)
  // to fill 8 bytes of linear memory, reads them as i64, masks to 53 bits,
  // and multiplies by 2^-53 to produce a float in [0, 1).
  //
  // The scratch buffer lives at memory offset 64 — well inside the
  // 1024-byte reserved area registerWasiImports sets aside via the
  // bump pointer (which initialises to 1024). offsets 0..15 are used by
  // __wasi_write_string for iovec/nwritten; we pick 64 to stay clear of
  // any future stdout/stderr work.
  if (needed.has("random")) {
    const randomGetIdx = ctx.funcMap.get("random_get");
    if (randomGetIdx === undefined) {
      // collectMathImports / collectMathImports-finalize should have registered
      // it before we got here. If missing, fall back to a constant 0 — better
      // than crashing in instantiation, and the test suite will catch it.
      addMathFunc({
        name: "Math_random",
        params: [],
        results: f64Result,
        locals: [],
        body: [f64c(0)],
      });
    } else {
      // The IR doesn't include `i64.load`, so we read 8 bytes as TWO `i32.load`s
      // (low half at offset 0, high half at offset 4), zero-extend each to i64,
      // and combine as `(hi << 32) | lo`. Then shift right 11 to keep the upper
      // 53 significant bits and multiply by 2^-53 → uniform float in [0, 1).
      addMathFunc({
        name: "Math_random",
        params: [],
        results: f64Result,
        locals: [],
        body: [
          // random_get(ptr=64, len=8) — fills memory[64..72] with entropy
          i32const(64),
          i32const(8),
          { op: "call", funcIdx: randomGetIdx } as Instr,
          { op: "drop" } as Instr, // ignore errno (best-effort)
          // Low 32 bits: i64.extend_i32_u(i32.load offset=0 align=2)
          i32const(64),
          { op: "i32.load", offset: 0, align: 2 } as Instr,
          { op: "i64.extend_i32_u" } as Instr,
          // High 32 bits: i64.extend_i32_u(i32.load offset=4) << 32
          i32const(64),
          { op: "i32.load", offset: 4, align: 2 } as Instr,
          { op: "i64.extend_i32_u" } as Instr,
          { op: "i64.const", value: 32n } as Instr,
          { op: "i64.shl" } as Instr,
          // OR low + high
          { op: "i64.or" } as Instr,
          // Shift right 11 → keep upper 53 bits in unsigned i64
          { op: "i64.const", value: 11n } as Instr,
          { op: "i64.shr_u" } as Instr,
          // Convert to f64 and multiply by 2^-53. After `shr_u 11` the value
          // fits in 53 unsigned bits (max ~9e15), so `convert_i64_s` (which the
          // backend supports — `convert_i64_u` is not in the IR union) gives
          // an identical result.
          { op: "f64.convert_i64_s" } as Instr,
          f64c(1 / 9007199254740992), // 2^-53
          mul,
        ],
      });
    }
  }

  // Determine which core functions we need based on what's requested
  const needSinCos = needed.has("sin") || needed.has("cos") || needed.has("tan");
  const needExp =
    needed.has("exp") ||
    needed.has("sinh") ||
    needed.has("cosh") ||
    needed.has("tanh") ||
    needed.has("pow") ||
    needed.has("expm1");
  const needLog =
    needed.has("log") ||
    needed.has("log2") ||
    needed.has("log10") ||
    needed.has("pow") ||
    needed.has("asinh") ||
    needed.has("acosh") ||
    needed.has("atanh") ||
    needed.has("log1p");
  const needAtan = needed.has("atan") || needed.has("asin") || needed.has("acos") || needed.has("atan2");

  // ─── Phase 1: Core functions ──────────────────────────────────────

  // Range reduction helper for sin/cos — self-hosted (#3204 follow-up).
  if (needSinCos) {
    addedFuncs.set("__math_reduce_trig", emitSelfHostedMathFunc(ctx, REDUCE_TRIG_BUILTIN));
  }

  // ─── Math.sin ─────────────────────────────────────────────────────
  // Self-hosted; calls __math_reduce_trig (registered just above).
  if (needed.has("sin") || needed.has("tan")) {
    addedFuncs.set("Math_sin", emitSelfHostedMathFunc(ctx, SIN_BUILTIN));
  }

  // ─── Math.cos ─────────────────────────────────────────────────────
  // Self-hosted; calls __math_reduce_trig.
  if (needed.has("cos") || needed.has("tan")) {
    addedFuncs.set("Math_cos", emitSelfHostedMathFunc(ctx, COS_BUILTIN));
  }

  // ─── Math.exp ─────────────────────────────────────────────────────
  // Self-hosted (#3226): 2^n by pure-f64 repeated squaring (no i32 bit-ops /
  // reinterpret needed). Early core — emitted before its callers (sinh/cosh/
  // tanh/expm1/pow) so their `Math_exp` calls resolve by funcMap name.
  if (needExp) {
    addedFuncs.set("Math_exp", emitSelfHostedMathFunc(ctx, EXP_BUILTIN));
  }

  // ─── Math.log ─────────────────────────────────────────────────────
  // log(x) using range reduction to [0.5, 2) then atanh series
  if (needLog) {
    addedFuncs.set("Math_log", emitSelfHostedMathFunc(ctx, LOG_BUILTIN));
  }

  // ─── Math.atan ────────────────────────────────────────────────────
  // Self-hosted (#3204 follow-up). Leaf — no callees. The nested mid-body
  // statement-if range reduction is the NATURAL form (works post-#2856/#2981).
  if (needAtan) {
    addedFuncs.set("Math_atan", emitSelfHostedMathFunc(ctx, ATAN_BUILTIN));
  }

  // ─── Phase 2: Derived functions ───────────────────────────────────

  // Math.tan = sin/cos — self-hosted; calls Math_sin / Math_cos.
  if (needed.has("tan")) {
    addedFuncs.set("Math_tan", emitSelfHostedMathFunc(ctx, TAN_BUILTIN));
  }

  // Math.asin = atan(x / sqrt(1 - x*x)) — self-hosted; calls Math_atan.
  if (needed.has("asin")) {
    addedFuncs.set("Math_asin", emitSelfHostedMathFunc(ctx, ASIN_BUILTIN));
  }

  // Math.acos = pi/2 - atan(x/sqrt(1-x*x)) — self-hosted; calls Math_atan.
  if (needed.has("acos")) {
    addedFuncs.set("Math_acos", emitSelfHostedMathFunc(ctx, ACOS_BUILTIN));
  }

  // Math.atan2(y, x)
  if (needed.has("atan2")) {
    const atanIdx = getFuncIdx("Math_atan");
    addMathFunc({
      name: "Math_atan2",
      params: [f64Type, f64Type],
      results: f64Result,
      locals: [{ name: "atmp", type: f64Type }], // local 2 = atan_result temp
      body: buildAtan2Body(atanIdx),
    });
  }

  // Math.log2(x) = e + log2(f), computed via range reduction (exact for powers of 2)
  // Locals: 0=x, 1=e, 2=f, 3=t, 4=t2
  if (needed.has("log2")) {
    addedFuncs.set("Math_log2", emitSelfHostedMathFunc(ctx, LOG2_BUILTIN));
  }

  // Math.log10 — self-hosted (#3226): `Math.floor(result + 0.5)` replaces the
  // hand `f64.nearest` (bit-identical within the <1e-12 correction guard).
  // Calls the early-core self-hosted Math_log (registered above).
  if (needed.has("log10")) {
    addedFuncs.set("Math_log10", emitSelfHostedMathFunc(ctx, LOG10_BUILTIN));
  }

  // Math.pow — self-hosted (#3226): pure-f64 exp-by-squaring + exp(e·log b)
  // general path, calling the self-hosted Math_exp / Math_log. Binary (arity 2).
  if (needed.has("pow")) {
    addedFuncs.set("Math_pow", emitSelfHostedMathFunc(ctx, POW_BUILTIN));
  }

  // ─── Self-hosted subset (#3141) ───────────────────────────────────
  // sinh/cosh/tanh, asinh/acosh/atanh, cbrt, expm1 and log1p are no
  // longer hand-emitted `Instr[]`. Their bodies are ordinary TS source
  // in `src/stdlib/math.ts`, compiled through the compiler's own IR
  // pipeline (`stdlib-selfhost.ts`) and registered here, at the same
  // point in the emission order the hand-written versions occupied.
  // Phase-1 cores (Math_exp / Math_log) are already in ctx.funcMap, so
  // the source-level sibling calls resolve. Numeric behavior is
  // bit-identical (op-for-op mirrors — see src/stdlib/math.ts header).
  for (const [method, builtin] of SELF_HOSTED_MATH) {
    if (needed.has(method)) {
      addedFuncs.set(builtin.name, emitSelfHostedMathFunc(ctx, builtin));
    }
  }
}

// ─── Complex body builders ──────────────────────────────────────────

function buildAtan2Body(atanIdx: number): Instr[] {
  // atan2(y, x): params 0=y, 1=x
  return [
    // NaN checks
    ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
    ...ifThenRet([localGet(1), localGet(1), fne], [f64c(NaN)]),

    // y == 0 cases
    localGet(0),
    f64c(0),
    feq,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // y == 0, x > 0 → +0 (preserving sign of y)
        localGet(1),
        f64c(0),
        fgt,
        { op: "if", blockType: { kind: "empty" }, then: [localGet(0), ret] } as Instr,
        // y == 0, x < 0 → copysign(pi, y)
        localGet(1),
        f64c(0),
        flt,
        { op: "if", blockType: { kind: "empty" }, then: [f64c(PI), localGet(0), copysign, ret] } as Instr,
        // y == 0, x == 0 → copysign(0 or pi based on sign of x)
        // atan2(+0,+0) = +0, atan2(+0,-0) = pi, atan2(-0,+0) = -0, atan2(-0,-0) = -pi
        // Check sign of x via 1/x: +0 → +Inf, -0 → -Inf
        f64c(1),
        localGet(1),
        div,
        f64c(0),
        fgt,
        ifElse(f64Type, [f64c(0), localGet(0), copysign], [f64c(PI), localGet(0), copysign]),
        ret,
      ],
    } as Instr,

    // x == +Inf
    localGet(1),
    f64c(Infinity),
    feq,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        localGet(0),
        fabs,
        f64c(Infinity),
        feq,
        ifElse(f64Type, [f64c(PI / 4), localGet(0), copysign], [f64c(0), localGet(0), copysign]),
        ret,
      ],
    } as Instr,

    // x == -Inf
    localGet(1),
    f64c(-Infinity),
    feq,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        localGet(0),
        fabs,
        f64c(Infinity),
        feq,
        ifElse(f64Type, [f64c((3 * PI) / 4), localGet(0), copysign], [f64c(PI), localGet(0), copysign]),
        ret,
      ],
    } as Instr,

    // y == ±Inf, x finite
    ...ifThenRet([localGet(0), fabs, f64c(Infinity), feq], [f64c(HALF_PI), localGet(0), copysign]),

    // General case: atan(y/x) with quadrant adjustment
    localGet(1),
    f64c(0),
    fgt,
    ifElse(
      f64Type,
      [localGet(0), localGet(1), div, call(atanIdx)],
      [
        localGet(1),
        f64c(0),
        flt,
        ifElse(
          f64Type,
          [
            localGet(0),
            localGet(1),
            div,
            call(atanIdx),
            localSet(2),
            // Add or subtract pi based on sign of y
            localGet(0),
            f64c(0),
            fge,
            ifElse(f64Type, [localGet(2), f64c(PI), add], [localGet(2), f64c(PI), sub]),
          ],
          [
            // x == 0, y != 0 → copysign(pi/2, y)
            f64c(HALF_PI),
            localGet(0),
            copysign,
          ],
        ),
      ],
    ),
  ];
}
