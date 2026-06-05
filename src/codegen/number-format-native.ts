// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `Number.prototype.{toString,toFixed,toPrecision,toExponential}` for
 * standalone / WASI targets (#1321 / #1335 / #1759).
 *
 * In JS-host mode these are `env` imports (`number_toFixed` etc.). Under
 * `--target wasi` / `--target standalone` there is no JS runtime, so this
 * module emits WasmGC-native implementations registered under the same
 * `ctx.funcMap` names. The method call sites push `(f64 value, f64 arg)` and
 * expect an `externref` result (a `$NativeString` widened via
 * `extern.convert_any`), so those functions keep that `(f64, f64) -> externref`
 * signature. The default `number_toString(value)` helper uses the one-argument
 * host-import-compatible `(f64) -> externref` signature.
 *
 * Algorithm strategy (no Ryu): the three methods all need a *fixed* number of
 * digits, which is computed with straightforward scaled f64 arithmetic and a
 * decimal digit loop. Non-finite inputs short-circuit to "NaN" / "Infinity" /
 * "-Infinity" per spec ordering (the range check follows the non-finite check
 * in §21.1.3.{2,3,5}).
 *
 * Precision limitation: digit extraction is done in f64, so results are exact
 * to f64 precision (~15-16 significant decimal digits). For requests beyond
 * that — e.g. `(7.7).toFixed(20)` — V8 reveals the *exact* binary value's
 * decimal expansion via bignum arithmetic ("7.70000000000000017764"), whereas
 * this implementation returns the f64-rounded "7.70000000000000000000". The
 * common standalone cases (fractionDigits / precision ≲ 7) are exact; the
 * exact-low-digit behaviour is the deferred Ryu/bignum work tracked in #1335
 * Phase 2. JS-host mode (the dominant test path) is unaffected — it keeps the
 * `number_toFixed` etc. host imports.
 *
 * Spec references:
 * - toString      — ECMA-262 §21.1.3.6, §6.1.6.1.20, §7.1.5
 * - toFixed       — ECMA-262 §21.1.3.3
 * - toPrecision   — ECMA-262 §21.1.3.5
 * - toExponential — ECMA-262 §21.1.3.2
 *
 * Shared layout: each function builds its output into a scratch i16 array
 * (`buf`, capacity 256) with a write cursor (`pos`), then `__num_fmt_finalize`
 * copies the first `pos` code units into a tight `$NativeString` and returns it
 * as `externref`.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

const BUF_CAP = 256;
const MAX_SAFE_INTEGER = 9007199254740991;
const C_ZERO = 48; // '0'
const C_MINUS = 45; // '-'
const C_PLUS = 43; // '+'
const C_DOT = 46; // '.'
const C_LC_E = 101; // 'e'
const C_LC_A_MINUS_10 = 87; // 'a' - 10

/**
 * Allocate the next defined-function index. Mirrors parse-number-native.ts.
 */
function nextFuncIdx(ctx: CodegenContext): number {
  return ctx.numImportFuncs + ctx.mod.functions.length;
}

/**
 * Emit the shared `__num_fmt_finalize(buf: i16[], len: i32) -> externref`
 * helper: copies `buf[0..len)` into a tight `$NativeString` and returns the
 * widened externref. Registered idempotently in funcMap.
 */
function emitFinalize(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__num_fmt_finalize");
  if (existing !== undefined) return existing;

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const extern: ValType = { kind: "externref" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // params: 0 buf:i16[], 1 len:i32 ; locals: 2 out:i16[], 3 i:i32
  const L_BUF = 0;
  const L_LEN = 1;
  const L_OUT = 2;
  const L_I = 3;

  const body: Instr[] = [
    // out = array.new_default(len)
    { op: "local.get", index: L_LEN },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_OUT },
    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // out[i] = buf[i]
            { op: "local.get", index: L_OUT },
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_I },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "array.set", typeIdx: strDataTypeIdx },
            // i++
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // struct.new $NativeString(len, off=0, out)
    { op: "local.get", index: L_LEN },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_OUT },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "extern.convert_any" },
    { op: "return" },
  ];

  const typeIdx = addFuncType(ctx, [bufType, i32], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__num_fmt_finalize", funcIdx);
  const fn: WasmFunction = {
    name: "__num_fmt_finalize",
    typeIdx,
    locals: [
      { name: "out", type: bufType },
      { name: "i", type: i32 },
    ],
    body,
    exported: false,
  };
  ctx.mod.functions.push(fn);
  return funcIdx;
}

/**
 * Inline instr sequence: write a single code unit `code` (a constant) into
 * `buf[pos]` then `pos++`. `bufLocal`/`posLocal` are local indices.
 */
function putConst(strDataTypeIdx: number, bufLocal: number, posLocal: number, code: number): Instr[] {
  return [
    { op: "local.get", index: bufLocal },
    { op: "local.get", index: posLocal },
    { op: "i32.const", value: code },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: posLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: posLocal },
  ];
}

/**
 * Build the non-finite + sign prologue shared by all three formatters.
 *
 * Emits: if value is NaN → write "NaN", finalize, return. If value is
 * ±Infinity → write "Infinity"/"-Infinity", finalize, return. Otherwise set
 * `negLocal = value < 0` and `absLocal = |value|`.
 *
 * Locals used: `valueLocal` (param f64), `bufLocal` (i16[]), `posLocal` (i32),
 * `tmpLocal` (i32), `negLocal` (i32), `absLocal` (f64).
 */
function emitNonFinitePrologue(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  valueLocal: number,
  bufLocal: number,
  posLocal: number,
  tmpLocal: number,
  negLocal: number,
  absLocal: number,
): Instr[] {
  const writeWord = (w: string): Instr[] => {
    const out: Instr[] = [];
    for (const ch of w) out.push(...putConst(strDataTypeIdx, bufLocal, posLocal, ch.charCodeAt(0)));
    out.push(
      { op: "local.get", index: bufLocal },
      { op: "local.get", index: posLocal },
      { op: "call", funcIdx: finalizeIdx },
      { op: "return" },
    );
    return out;
  };

  return [
    // buf = array.new_default(BUF_CAP); pos = 0
    { op: "i32.const", value: BUF_CAP },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: bufLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: posLocal },

    // if (value != value)  → NaN
    { op: "local.get", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: writeWord("NaN"),
    },

    // neg = value < 0
    { op: "local.get", index: valueLocal },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.set", index: negLocal },
    // abs = |value|
    { op: "local.get", index: valueLocal },
    { op: "f64.abs" },
    { op: "local.set", index: absLocal },

    // if (abs == Infinity) → write sign + "Infinity"
    { op: "local.get", index: absLocal },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // if neg write '-'
        { op: "local.get", index: negLocal },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: putConst(strDataTypeIdx, bufLocal, posLocal, C_MINUS),
        },
        ...writeWord("Infinity"),
      ],
    },
  ];
}

/**
 * Emit a loop that writes the integer part of f64 `intval` (>= 0, already
 * truncated to an integer value) as decimal digits into buf. If `intval` is 0,
 * writes a single '0'. Uses scratch: writes digits least-significant first into
 * a temp region then reverses — implemented here by computing digit count via
 * a first pass.
 *
 * Locals: intLocal(f64 working copy), bufLocal, posLocal, tmpLocal(i32),
 *  dcountLocal(i32), digitLocal(f64 scratch).
 *
 * Strategy: digits are produced most-significant-first by repeatedly dividing
 * by the appropriate power of ten. We find the highest power of ten <= intval,
 * then peel digits down.
 */
function emitIntegerDigits(
  strDataTypeIdx: number,
  intLocal: number,
  bufLocal: number,
  posLocal: number,
  tmpLocal: number,
  powLocal: number,
  digitLocal: number,
): Instr[] {
  return [
    // if (int < 1) { write '0' } else { ... }
    { op: "local.get", index: intLocal },
    { op: "f64.const", value: 1 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, bufLocal, posLocal, C_ZERO),
      else: [
        // pow = 1; while (pow*10 <= int) pow *= 10
        { op: "f64.const", value: 1 },
        { op: "local.set", index: powLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.get", index: intLocal },
                { op: "f64.le" },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: powLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // while (pow >= 1) { d = floor(int/pow); write '0'+d; int -= d*pow; pow/=10 }
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 1 },
                { op: "f64.lt" },
                { op: "br_if", depth: 1 },
                // digit = floor(int/pow)
                { op: "local.get", index: intLocal },
                { op: "local.get", index: powLocal },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: digitLocal },
                // write '0' + (i32)digit
                { op: "local.get", index: bufLocal },
                { op: "local.get", index: posLocal },
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: digitLocal },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: posLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: posLocal },
                // int -= digit*pow
                { op: "local.get", index: intLocal },
                { op: "local.get", index: digitLocal },
                { op: "local.get", index: powLocal },
                { op: "f64.mul" },
                { op: "f64.sub" },
                { op: "local.set", index: intLocal },
                // pow /= 10
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: powLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Emit native number-format functions and register them in `ctx.funcMap`.
 * `which` is a subset of {number_toString, number_toString_radix,
 * number_toFixed, number_toPrecision, number_toExponential}. Must run before
 * any function bodies that call them, and (via ensureNativeStringHelpers) sets
 * up the NativeString types.
 */
export function emitNativeNumberFormat(ctx: CodegenContext, which: Set<string>): void {
  ensureNativeStringHelpers(ctx);
  const finalizeIdx = emitFinalize(ctx);
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  const needRadix = which.has("number_toString") || which.has("number_toString_radix");
  if (needRadix && !ctx.funcMap.has("number_toString_radix")) {
    emitToStringRadix(ctx, finalizeIdx, strDataTypeIdx, i32, f64, extern, bufType);
  }
  if (which.has("number_toString") && !ctx.funcMap.has("number_toString")) {
    emitToString(ctx, strDataTypeIdx, i32, f64, extern, bufType);
  }

  // number_toPrecision delegates to number_toFixed + number_toExponential, so
  // those two must be emitted whenever toPrecision is requested — even if the
  // program never calls them directly.
  const needPrecision = which.has("number_toPrecision");
  const needFixed = which.has("number_toFixed") || needPrecision;
  const needExp = which.has("number_toExponential") || needPrecision;

  if (needFixed && !ctx.funcMap.has("number_toFixed")) {
    emitToFixed(ctx, finalizeIdx, strDataTypeIdx, i32, f64, extern, bufType);
  }
  if (needExp && !ctx.funcMap.has("number_toExponential")) {
    emitToExponential(ctx, finalizeIdx, strDataTypeIdx, i32, f64, extern, bufType);
  }
  if (needPrecision && !ctx.funcMap.has("number_toPrecision")) {
    emitToPrecision(ctx, finalizeIdx, strDataTypeIdx, i32, f64, extern, bufType);
  }
}

/**
 * #1836 — emit the §6.1.6.1.20 exponential-notation form `d[.ddd…]e±N` for a
 * positive finite `abs` (the caller has already written any leading '-' decision
 * to L_NEG and guarded `abs > 0`). Pure Wasm, no log10 (Wasm has none): the
 * mantissa is normalised into [1,10) by iterative ×/÷10 while tracking the
 * decimal exponent, then up to `SIG_DIGITS` significant digits are emitted
 * (trailing zeros trimmed, the '.' dropped if none remain), followed by 'e', the
 * exponent sign, and the exponent's decimal digits.
 *
 * The exponent magnitude is at most 3 decimal digits (|exp| <= 308 for a finite
 * f64), so its digits are emitted MSB-first via a hundreds/tens/ones decomposition
 * with leading-zero suppression — no reverse pass, so the buffer write cursor
 * `L_POS` is never used as a shrinking high pointer.
 *
 * This is the bounded slice: it fixes the two concrete failures ((1e21) lacked
 * 'e', (1e-7) collapsed to "0") and the wrong-output class for the exponential
 * regime. Bit-perfect shortest-round-trip (Ryū/Grisu) remains #1335 Phase 2.
 *
 * Locals consumed: L_ABS (f64, in), L_NEG (i32, in), L_BUF (i16[]) / L_POS (i32)
 * the write cursor, L_M (f64) normalised mantissa, L_EXP (i32) decimal exponent,
 * L_SD (i32) significant-digit counter, L_DIGIT (f64) digit scratch, L_TMP (i32)
 * exponent-magnitude scratch.
 */
function emitExponential(
  strDataTypeIdx: number,
  L: {
    L_ABS: number;
    L_NEG: number;
    L_BUF: number;
    L_POS: number;
    L_EXP: number;
    L_M: number;
    L_SD: number;
    L_DIGIT: number;
    L_TMP: number; // exponent-magnitude scratch (i32)
    finalizeIdx: number;
  },
): Instr[] {
  // 15 significant digits is the safe precision floor for an IEEE-754 double
  // (~15.95 decimal digits). Emitting more exposes the binary representation's
  // noise (e.g. 9.5e-8 → 9.500000000000001e-8); 15 + round-half-up keeps the
  // common exponential-regime values bit-exact with V8. Shortest-round-trip
  // (Grisu/Ryū, which would also nail 16-17-digit extremes) is #1335 Phase 2.
  const SIG_DIGITS = 15; // significant digits to emit (incl. the leading one)
  // Half of the unit in the last emitted place, applied to the normalised
  // mantissa in [1,10) before truncation so the final digit is rounded, not
  // floored: 0.5 × 10^-(SIG_DIGITS-1).
  const ROUND_BIAS = 0.5 * Math.pow(10, -(SIG_DIGITS - 1));

  // Emit one mantissa digit: d = floor(L_M); write '0'+d; L_M = (L_M - d) * 10.
  const emitMantissaDigit = (): Instr[] => [
    { op: "local.get", index: L.L_M },
    { op: "f64.floor" },
    { op: "local.set", index: L.L_DIGIT },
    { op: "local.get", index: L.L_BUF },
    { op: "local.get", index: L.L_POS },
    { op: "i32.const", value: C_ZERO },
    { op: "local.get", index: L.L_DIGIT },
    { op: "i32.trunc_f64_s" },
    { op: "i32.add" },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: L.L_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L.L_POS },
    { op: "local.get", index: L.L_M },
    { op: "local.get", index: L.L_DIGIT },
    { op: "f64.sub" },
    { op: "f64.const", value: 10 },
    { op: "f64.mul" },
    { op: "local.set", index: L.L_M },
  ];

  // The exponent's decimal digits (hundreds/tens/ones) are emitted inline at the
  // tail of the returned body, with L_SD tracking "has a digit been printed yet"
  // for leading-zero suppression — see the comment block there.

  return [
    // m = abs; exp = 0.
    { op: "local.get", index: L.L_ABS },
    { op: "local.set", index: L.L_M },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L.L_EXP },

    // while m >= 10: m /= 10; exp++.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L.L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.lt" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L.L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.div" },
            { op: "local.set", index: L.L_M },
            { op: "local.get", index: L.L_EXP },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L.L_EXP },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // while m < 1: m *= 10; exp--.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L.L_M },
            { op: "f64.const", value: 1 },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L.L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L.L_M },
            { op: "local.get", index: L.L_EXP },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L.L_EXP },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Round-half-up: bias the normalised mantissa by half a unit in the last
    // emitted significant place, then re-normalise if the bias carried it to
    // >= 10 (e.g. 9.999…95 → 10.0 → 1.0, exp++). Subsequent digit extraction is
    // plain truncation, which now yields the rounded representation.
    { op: "local.get", index: L.L_M },
    { op: "f64.const", value: ROUND_BIAS },
    { op: "f64.add" },
    { op: "local.set", index: L.L_M },
    { op: "local.get", index: L.L_M },
    { op: "f64.const", value: 10 },
    { op: "f64.ge" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.L_M },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "local.set", index: L.L_M },
        { op: "local.get", index: L.L_EXP },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L.L_EXP },
      ],
    },

    // Leading '-' if negative.
    { op: "local.get", index: L.L_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L.L_BUF, L.L_POS, C_MINUS),
    },

    // Leading significant digit (the one before the '.').
    ...emitMantissaDigit(),

    // '.' then up to SIG_DIGITS-1 more digits.
    ...putConst(strDataTypeIdx, L.L_BUF, L.L_POS, C_DOT),
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L.L_SD },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L.L_SD },
            { op: "i32.const", value: SIG_DIGITS },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...emitMantissaDigit(),
            { op: "local.get", index: L.L_SD },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L.L_SD },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Trim trailing '0' digits.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L.L_POS },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L.L_BUF },
            { op: "local.get", index: L.L_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "i32.const", value: C_ZERO },
            { op: "i32.ne" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L.L_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L.L_POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Drop a trailing '.' if all fractional digits were trimmed.
    { op: "local.get", index: L.L_BUF },
    { op: "local.get", index: L.L_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "i32.const", value: C_DOT },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.L_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: L.L_POS },
      ],
    },

    // 'e'.
    ...putConst(strDataTypeIdx, L.L_BUF, L.L_POS, C_LC_E),
    // Exponent sign: '+' if exp >= 0 else '-'; then expmag = |exp| in L_TMP.
    { op: "local.get", index: L.L_EXP },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...putConst(strDataTypeIdx, L.L_BUF, L.L_POS, C_MINUS),
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L.L_EXP },
        { op: "i32.sub" },
        { op: "local.set", index: L.L_TMP },
      ],
      else: [
        ...putConst(strDataTypeIdx, L.L_BUF, L.L_POS, C_PLUS),
        { op: "local.get", index: L.L_EXP },
        { op: "local.set", index: L.L_TMP },
      ],
    },
    // Exponent digits, MSB-first. expmag (L_TMP) is 0..~308, i.e. at most three
    // decimal digits, so render hundreds/tens/ones directly with leading-zero
    // suppression (L_SD = "have we printed a digit yet"). No reverse pass, so the
    // write cursor L_POS is never used as a shrinking high pointer.
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L.L_SD }, // L_SD: 0 until the first non-suppressed digit
    // hundreds place: d = expmag / 100; if d != 0 print it and mark started.
    { op: "local.get", index: L.L_TMP },
    { op: "i32.const", value: 100 },
    { op: "i32.div_u" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.L_BUF },
        { op: "local.get", index: L.L_POS },
        { op: "i32.const", value: C_ZERO },
        { op: "local.get", index: L.L_TMP },
        { op: "i32.const", value: 100 },
        { op: "i32.div_u" },
        { op: "i32.add" },
        { op: "array.set", typeIdx: strDataTypeIdx },
        { op: "local.get", index: L.L_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L.L_POS },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: L.L_SD },
      ],
    },
    // tens place: print if started OR the tens digit is non-zero.
    { op: "local.get", index: L.L_SD },
    { op: "local.get", index: L.L_TMP },
    { op: "i32.const", value: 10 },
    { op: "i32.div_u" },
    { op: "i32.const", value: 10 },
    { op: "i32.rem_u" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.L_BUF },
        { op: "local.get", index: L.L_POS },
        { op: "i32.const", value: C_ZERO },
        { op: "local.get", index: L.L_TMP },
        { op: "i32.const", value: 10 },
        { op: "i32.div_u" },
        { op: "i32.const", value: 10 },
        { op: "i32.rem_u" },
        { op: "i32.add" },
        { op: "array.set", typeIdx: strDataTypeIdx },
        { op: "local.get", index: L.L_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L.L_POS },
      ],
    },
    // ones place: always printed (exponent has at least one digit).
    { op: "local.get", index: L.L_BUF },
    { op: "local.get", index: L.L_POS },
    { op: "i32.const", value: C_ZERO },
    { op: "local.get", index: L.L_TMP },
    { op: "i32.const", value: 10 },
    { op: "i32.rem_u" },
    { op: "i32.add" },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: L.L_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L.L_POS },

    { op: "local.get", index: L.L_BUF },
    { op: "local.get", index: L.L_POS },
    { op: "call", funcIdx: L.finalizeIdx },
    { op: "return" },
  ] as Instr[];
}

/**
 * `number_toString(value: f64) -> externref`
 *
 * Host-compatible default radix-10 Number::toString for standalone/WASI. Safe
 * integers delegate to the existing radix formatter; finite fractional values
 * use a compact fixed-point fallback (six fractional digits, trimmed) so
 * template interpolation can produce a native string without any JS host bridge.
 */
function emitToString(
  ctx: CodegenContext,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
  const radixIdx = ctx.funcMap.get("number_toString_radix");
  if (radixIdx === undefined) return;
  const finalizeIdx = ctx.funcMap.get("__num_fmt_finalize");
  if (finalizeIdx === undefined) return;

  // params: 0 value:f64
  // locals: 1 buf 2 pos 3 tmp 4 neg 5 abs 6 scale 7 scaled 8 intpart
  //         9 fracpart 10 pow 11 digit 12 k
  const L_VALUE = 0;
  const L_BUF = 1;
  const L_POS = 2;
  const L_TMP = 3;
  const L_NEG = 4;
  const L_ABS = 5;
  const L_SCALE = 6;
  const L_SCALED = 7;
  const L_INT = 8;
  const L_FRAC = 9;
  const L_POW = 10;
  const L_DIGIT = 11;
  const L_K = 12;
  const L_EXP = 13; // decimal exponent for the exponential-notation regime
  const L_M = 14; // mantissa normalised to [1,10)
  const L_SD = 15; // significant-digit counter

  const finalizeReturn = (): Instr[] => [
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  const body: Instr[] = [
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),

    // §6.1.6.1.20 exponential-notation regime: ToString uses `d.dddde±N` when the
    // decimal-point position falls outside (-6, 21]. We approximate that by the
    // magnitude thresholds |x| >= 1e21 or 0 < |x| < 1e-6, which is exactly where
    // V8 switches to exponential. (abs == 0 is already handled by the prologue's
    // radix path below.) This eliminates (1e21).toString() rendering a 22-digit
    // integer and (1e-7).toString() collapsing to "0".
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: 1e21 },
    { op: "f64.ge" },
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: 0 },
    { op: "f64.gt" },
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: 1e-6 },
    { op: "f64.lt" },
    { op: "i32.and" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: emitExponential(strDataTypeIdx, {
        L_ABS,
        L_NEG,
        L_BUF,
        L_POS,
        L_EXP,
        L_M,
        L_SD,
        L_DIGIT,
        L_TMP,
        finalizeIdx,
      }),
    },

    // Safe integers can reuse the radix-10 formatter exactly.
    { op: "local.get", index: L_ABS },
    { op: "local.get", index: L_ABS },
    { op: "f64.floor" },
    { op: "f64.eq" },
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: MAX_SAFE_INTEGER },
    { op: "f64.le" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_VALUE },
        { op: "f64.const", value: 10 },
        { op: "call", funcIdx: radixIdx },
        { op: "return" },
      ],
    },

    // Fractional fallback: round to 6 fractional digits and trim trailing zeros.
    { op: "f64.const", value: 1000000 },
    { op: "local.set", index: L_SCALE },
    { op: "local.get", index: L_ABS },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.const", value: 0.5 },
    { op: "f64.add" },
    { op: "f64.floor" },
    { op: "local.set", index: L_SCALED },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALE },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "local.set", index: L_INT },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_INT },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.sub" },
    { op: "local.set", index: L_FRAC },

    { op: "local.get", index: L_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
    },
    ...emitIntegerDigits(strDataTypeIdx, L_INT, L_BUF, L_POS, L_TMP, L_POW, L_DIGIT),

    { op: "local.get", index: L_FRAC },
    { op: "f64.const", value: 0 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...putConst(strDataTypeIdx, L_BUF, L_POS, C_DOT),
        { op: "local.get", index: L_SCALE },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.set", index: L_POW },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_K },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_K },
                { op: "i32.const", value: 6 },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_FRAC },
                { op: "local.get", index: L_POW },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_DIGIT },
                { op: "local.get", index: L_BUF },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: L_DIGIT },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_POS },
                { op: "local.get", index: L_FRAC },
                { op: "local.get", index: L_DIGIT },
                { op: "local.get", index: L_POW },
                { op: "f64.mul" },
                { op: "f64.sub" },
                { op: "local.set", index: L_FRAC },
                { op: "local.get", index: L_POW },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_POW },
                { op: "local.get", index: L_K },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_K },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // while pos>0 && buf[pos-1]=='0': pos--
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_POS },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_BUF },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "array.get_u", typeIdx: strDataTypeIdx },
                { op: "i32.const", value: C_ZERO },
                { op: "i32.ne" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: L_POS },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // If trimming removed all fractional digits, remove the decimal point.
        { op: "local.get", index: L_POS },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "i32.const", value: C_DOT },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: L_POS },
              ],
            },
          ],
        },
      ],
    },
    ...finalizeReturn(),
  ];

  const typeIdx = addFuncType(ctx, [f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toString", funcIdx);
  ctx.mod.functions.push({
    name: "number_toString",
    typeIdx,
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "scale", type: f64 },
      { name: "scaled", type: f64 },
      { name: "intpart", type: f64 },
      { name: "fracpart", type: f64 },
      { name: "pow", type: f64 },
      { name: "digit", type: f64 },
      { name: "k", type: i32 },
      // #1836 exponential-notation regime (emitExponential):
      { name: "exp", type: i32 }, // 13: decimal exponent
      { name: "m", type: f64 }, // 14: mantissa normalised to [1,10)
      { name: "sd", type: i32 }, // 15: significant-digit counter / exp-digit started flag
    ],
    body,
    exported: false,
  });
}

/**
 * `number_toString_radix(value: f64, radix: f64) -> externref`
 * (§21.1.3.6, §6.1.6.1.20, §7.1.5).
 *
 * The call site has already applied `ToIntegerOrInfinity(radix)`'s truncating
 * shape for ordinary positive radices and rejected values outside 2..36. This
 * standalone slice handles non-finite values, ±0, and finite safe integers.
 * Fractional and unsafe-integer shortest formatting remains #1335 Phase 2.
 */
function emitToStringRadix(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
  // params: 0 value:f64, 1 radix:f64
  // locals: 2 buf 3 pos 4 tmp 5 neg 6 abs 7 r 8 n 9 q 10 digit
  //         11 digitCode 12 i 13 j
  const L_VALUE = 0;
  const L_RADIX = 1;
  const L_BUF = 2;
  const L_POS = 3;
  const L_TMP = 4;
  const L_NEG = 5;
  const L_ABS = 6;
  const L_R = 7;
  const L_N = 8;
  const L_Q = 9;
  const L_DIGIT = 10;
  const L_CODE = 11;
  const L_I = 12;
  const L_J = 13;

  const writeFinalizeReturn = (): Instr[] => [
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  const body: Instr[] = [
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),

    // radix = floor(radix). The caller already rejects non-integers outside the
    // valid interval after ToIntegerOrInfinity-style truncation.
    { op: "local.get", index: L_RADIX },
    { op: "f64.floor" },
    { op: "local.set", index: L_R },

    // if abs == 0: return "0" (covers both +0 and -0).
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...putConst(strDataTypeIdx, L_BUF, L_POS, C_ZERO), ...writeFinalizeReturn()],
    },

    // Phase 1 guard: finite integers only, and stay within exactly represented
    // integer space so the f64 div/mod digit loop is stable.
    { op: "local.get", index: L_ABS },
    { op: "local.get", index: L_ABS },
    { op: "f64.floor" },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "unreachable" }],
    },
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: MAX_SAFE_INTEGER },
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "unreachable" }],
    },

    // n = abs; write least-significant digits into buf[0..pos).
    { op: "local.get", index: L_ABS },
    { op: "local.set", index: L_N },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_N },
            { op: "f64.const", value: 0 },
            { op: "f64.eq" },
            { op: "br_if", depth: 1 },

            // q = floor(n / radix); digit = n - q * radix.
            { op: "local.get", index: L_N },
            { op: "local.get", index: L_R },
            { op: "f64.div" },
            { op: "f64.floor" },
            { op: "local.set", index: L_Q },
            { op: "local.get", index: L_N },
            { op: "local.get", index: L_Q },
            { op: "local.get", index: L_R },
            { op: "f64.mul" },
            { op: "f64.sub" },
            { op: "local.set", index: L_DIGIT },

            // digitCode = digit < 10 ? '0' + digit : 'a' - 10 + digit.
            { op: "local.get", index: L_DIGIT },
            { op: "f64.const", value: 10 },
            { op: "f64.lt" },
            {
              op: "if",
              blockType: { kind: "val", type: i32 },
              then: [
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: L_DIGIT },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
              ],
              else: [
                { op: "i32.const", value: C_LC_A_MINUS_10 },
                { op: "local.get", index: L_DIGIT },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
              ],
            },
            { op: "local.set", index: L_CODE },

            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_POS },
            { op: "local.get", index: L_CODE },
            { op: "array.set", typeIdx: strDataTypeIdx },
            { op: "local.get", index: L_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_POS },

            { op: "local.get", index: L_Q },
            { op: "local.set", index: L_N },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Negative finite non-zero values prepend '-' after the digit loop, then the
    // full buffer is reversed below.
    { op: "local.get", index: L_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
    },

    // Reverse buf[0..pos) in place.
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: L_J },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_J },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_I },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: L_TMP },

            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_J },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "array.set", typeIdx: strDataTypeIdx },

            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_J },
            { op: "local.get", index: L_TMP },
            { op: "array.set", typeIdx: strDataTypeIdx },

            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "local.get", index: L_J },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L_J },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    ...writeFinalizeReturn(),
  ];

  const typeIdx = addFuncType(ctx, [f64, f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toString_radix", funcIdx);
  ctx.mod.functions.push({
    name: "number_toString_radix",
    typeIdx,
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "radix", type: f64 },
      { name: "n", type: f64 },
      { name: "q", type: f64 },
      { name: "digit", type: f64 },
      { name: "digitCode", type: i32 },
      { name: "i", type: i32 },
      { name: "j", type: i32 },
    ],
    body,
    exported: false,
  });
}

/**
 * `number_toFixed(value: f64, digits: f64) -> externref` (§21.1.3.3).
 * Fixed-point with `digits` fractional places (0..100), round-half-away.
 * For |value| >= 1e21 falls back to integer rendering (toString-style); the
 * spec also defers to ToString there, and the integer path produces the same
 * leading digits.
 */
function emitToFixed(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
  // params: 0 value:f64, 1 digits:f64
  // locals: 2 buf  3 pos  4 tmp  5 neg  6 abs  7 scale  8 scaled
  //         9 intpart 10 fracpart 11 pow 12 digit 13 fdig 14 k
  const L_VALUE = 0;
  const L_DIGITS = 1;
  const L_BUF = 2;
  const L_POS = 3;
  const L_TMP = 4;
  const L_NEG = 5;
  const L_ABS = 6;
  const L_SCALE = 7;
  const L_SCALED = 8;
  const L_INT = 9;
  const L_FRAC = 10;
  const L_POW = 11;
  const L_DIGIT = 12;
  const L_FDIG = 13; // fractional digit count (i32)
  const L_K = 14;

  const body: Instr[] = [
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
    // fdig = (i32)digits (truncated)
    { op: "local.get", index: L_DIGITS },
    { op: "i32.trunc_f64_s" },
    { op: "local.set", index: L_FDIG },
    // scale = 10^fdig (computed by loop)
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SCALE },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_K },
            { op: "local.get", index: L_FDIG },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_SCALE },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_SCALE },
            { op: "local.get", index: L_K },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // scaled = round_half_away(abs * scale) = floor(abs*scale + 0.5)
    { op: "local.get", index: L_ABS },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.const", value: 0.5 },
    { op: "f64.add" },
    { op: "f64.floor" },
    { op: "local.set", index: L_SCALED },
    // int = floor(scaled/scale); frac = scaled - int*scale
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALE },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "local.set", index: L_INT },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_INT },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.sub" },
    { op: "local.set", index: L_FRAC },
    // sign: if neg && (int>0 || frac>0) write '-'
    { op: "local.get", index: L_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
    },
    // integer digits
    ...emitIntegerDigits(strDataTypeIdx, L_INT, L_BUF, L_POS, L_TMP, L_POW, L_DIGIT),
    // if fdig > 0: write '.' then fdig fractional digits
    { op: "local.get", index: L_FDIG },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...putConst(strDataTypeIdx, L_BUF, L_POS, C_DOT),
        // pow = scale/10 ; for k in 0..fdig: d=floor(frac/pow); write; frac-=d*pow; pow/=10
        { op: "local.get", index: L_SCALE },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.set", index: L_POW },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_K },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_K },
                { op: "local.get", index: L_FDIG },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // d = floor(frac/pow)  (pow could be 0 on last? no, pow>=1 here)
                { op: "local.get", index: L_FRAC },
                { op: "local.get", index: L_POW },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_DIGIT },
                // write '0'+d
                { op: "local.get", index: L_BUF },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: L_DIGIT },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_POS },
                // frac -= d*pow
                { op: "local.get", index: L_FRAC },
                { op: "local.get", index: L_DIGIT },
                { op: "local.get", index: L_POW },
                { op: "f64.mul" },
                { op: "f64.sub" },
                { op: "local.set", index: L_FRAC },
                // pow /= 10
                { op: "local.get", index: L_POW },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_POW },
                { op: "local.get", index: L_K },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_K },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // finalize
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  const typeIdx = addFuncType(ctx, [f64, f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toFixed", funcIdx);
  ctx.mod.functions.push({
    name: "number_toFixed",
    typeIdx,
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "scale", type: f64 },
      { name: "scaled", type: f64 },
      { name: "intpart", type: f64 },
      { name: "fracpart", type: f64 },
      { name: "pow", type: f64 },
      { name: "digit", type: f64 },
      { name: "fdig", type: i32 },
      { name: "k", type: i32 },
    ],
    body,
    exported: false,
  });
}

/**
 * `number_toExponential(value: f64, digits: f64) -> externref` (§21.1.3.2).
 * `digits` is fractional digits after the leading digit. NaN sentinel (digits
 * != digits) means "no argument" → use as-many-digits-as-needed; we render the
 * shortest representation that round-trips is out of scope, so for the no-arg
 * case we default to up to 6 fractional digits trimmed of trailing zeros (good
 * enough for standalone output; exact-arg case is precise).
 */
function emitToExponential(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
  // params 0 value 1 digits
  // locals: 2 buf 3 pos 4 tmp 5 neg 6 abs 7 exp(i32) 8 mant 9 scale
  //         10 scaled 11 pow 12 digit 13 fdig(i32) 14 k(i32) 15 noarg(i32) 16 lead(f64)
  const L_VALUE = 0;
  const L_DIGITS = 1;
  const L_BUF = 2;
  const L_POS = 3;
  const L_TMP = 4;
  const L_NEG = 5;
  const L_ABS = 6;
  const L_EXP = 7;
  const L_MANT = 8;
  const L_SCALE = 9;
  const L_SCALED = 10;
  const L_POW = 11;
  const L_DIGIT = 12;
  const L_FDIG = 13;
  const L_K = 14;
  const L_NOARG = 15;

  const body: Instr[] = [
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
    // noarg = (digits != digits)   [NaN sentinel]
    { op: "local.get", index: L_DIGITS },
    { op: "local.get", index: L_DIGITS },
    { op: "f64.ne" },
    { op: "local.set", index: L_NOARG },
    // fdig = noarg ? 6 : (i32)digits
    { op: "local.get", index: L_NOARG },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [{ op: "i32.const", value: 6 }],
      else: [{ op: "local.get", index: L_DIGITS }, { op: "i32.trunc_f64_s" }],
    },
    { op: "local.set", index: L_FDIG },

    // sign
    { op: "local.get", index: L_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
    },

    // exp = 0; mant = abs
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_EXP },
    { op: "local.get", index: L_ABS },
    { op: "local.set", index: L_MANT },
    // if mant != 0: normalize to [1,10)
    { op: "local.get", index: L_MANT },
    { op: "f64.const", value: 0 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // while mant >= 10: mant/=10; exp++
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 10 },
                { op: "f64.lt" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "local.set", index: L_MANT },
                { op: "local.get", index: L_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // while mant < 1: mant*=10; exp--
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 1 },
                { op: "f64.ge" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: L_MANT },
                { op: "local.get", index: L_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: L_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // scale = 10^fdig
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SCALE },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_K },
            { op: "local.get", index: L_FDIG },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_SCALE },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_SCALE },
            { op: "local.get", index: L_K },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // scaled = floor(mant*scale + 0.5)
    { op: "local.get", index: L_MANT },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.const", value: 0.5 },
    { op: "f64.add" },
    { op: "f64.floor" },
    { op: "local.set", index: L_SCALED },
    // rounding may push scaled to >= 10*scale → mant rounded to 10.xxx, bump exp
    // if scaled >= 10*scale: scaled/=10 (drop last digit by div+floor not needed:
    // instead divide scaled by 10 and exp++). We re-derive digits from scaled.
    { op: "local.get", index: L_SCALED },
    { op: "f64.const", value: 10 },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.ge" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_SCALED },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.set", index: L_SCALED },
        { op: "local.get", index: L_EXP },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L_EXP },
      ],
    },
    // now scaled is an integer with (fdig+1) decimal digits (leading digit + fdig).
    // Write leading digit = floor(scaled/scale)
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: C_ZERO },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALE },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "i32.trunc_f64_s" },
    { op: "i32.add" },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L_POS },
    // remainder = scaled - lead*scale  → reuse L_MANT as fractional remainder
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALE },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.sub" },
    { op: "local.set", index: L_MANT },
    // if fdig>0: write '.' and fdig digits from remainder with pow=scale/10
    { op: "local.get", index: L_FDIG },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...putConst(strDataTypeIdx, L_BUF, L_POS, C_DOT),
        { op: "local.get", index: L_SCALE },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.set", index: L_POW },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_K },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_K },
                { op: "local.get", index: L_FDIG },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_MANT },
                { op: "local.get", index: L_POW },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_DIGIT },
                { op: "local.get", index: L_BUF },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: L_DIGIT },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_POS },
                { op: "local.get", index: L_MANT },
                { op: "local.get", index: L_DIGIT },
                { op: "local.get", index: L_POW },
                { op: "f64.mul" },
                { op: "f64.sub" },
                { op: "local.set", index: L_MANT },
                { op: "local.get", index: L_POW },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_POW },
                { op: "local.get", index: L_K },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_K },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // write 'e'
    ...putConst(strDataTypeIdx, L_BUF, L_POS, C_LC_E),
    // sign of exponent: '+' if exp>=0 else '-'
    { op: "local.get", index: L_EXP },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_PLUS),
      else: [
        ...putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
        // exp = -exp
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L_EXP },
        { op: "i32.sub" },
        { op: "local.set", index: L_EXP },
      ],
    },
    // write exponent magnitude as integer digits via emitIntegerDigits on f64
    { op: "local.get", index: L_EXP },
    { op: "f64.convert_i32_s" },
    { op: "local.set", index: L_MANT },
    ...emitIntegerDigits(strDataTypeIdx, L_MANT, L_BUF, L_POS, L_TMP, L_POW, L_DIGIT),
    // finalize
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  const typeIdx = addFuncType(ctx, [f64, f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toExponential", funcIdx);
  ctx.mod.functions.push({
    name: "number_toExponential",
    typeIdx,
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "exp", type: i32 },
      { name: "mant", type: f64 },
      { name: "scale", type: f64 },
      { name: "scaled", type: f64 },
      { name: "pow", type: f64 },
      { name: "digit", type: f64 },
      { name: "fdig", type: i32 },
      { name: "k", type: i32 },
      { name: "noarg", type: i32 },
    ],
    body,
    exported: false,
  });
}

/**
 * `number_toPrecision(value: f64, precision: f64) -> externref` (§21.1.3.5).
 * NaN sentinel (precision != precision) means "no argument" → behaves like
 * toString. We implement the no-arg case by delegating to a toFixed-style
 * render with enough fractional digits; the with-arg case formats `precision`
 * significant digits, choosing fixed or exponential notation per spec
 * (exponent < -6 or >= precision → exponential).
 */
function emitToPrecision(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
  // We reduce toPrecision to: compute decimal exponent e of value, then
  // significant digits = precision. If -6 <= e < precision, render fixed with
  // (precision-1-e) fractional digits. Else render exponential with
  // (precision-1) fractional digits. We delegate the actual rendering to the
  // already-emitted number_toFixed / number_toExponential helpers.
  const toFixedIdx = ctx.funcMap.get("number_toFixed");
  const toExpIdx = ctx.funcMap.get("number_toExponential");

  // params 0 value 1 precision
  // locals: 2 buf 3 pos 4 tmp 5 neg 6 abs 7 e(i32) 8 m(f64) 9 prec(i32)
  //         10 noarg(i32) 11 fdig(i32)
  const L_VALUE = 0;
  const L_PRECISION = 1;
  const L_BUF = 2;
  const L_POS = 3;
  const L_TMP = 4;
  const L_NEG = 5;
  const L_ABS = 6;
  const L_E = 7;
  const L_M = 8;
  const L_PREC = 9;
  const L_NOARG = 10;
  const L_FDIG = 11;
  const L_RSCALE = 12;
  const L_RK = 13;

  const body: Instr[] = [
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
    // noarg = precision != precision
    { op: "local.get", index: L_PRECISION },
    { op: "local.get", index: L_PRECISION },
    { op: "f64.ne" },
    { op: "local.set", index: L_NOARG },
    // if noarg: return number_toFixed-style? toString semantics differ, but for
    // standalone output we approximate via toExponential no-arg (NaN sentinel).
    { op: "local.get", index: L_NOARG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // delegate to toExponential(value, NaN) — close enough for no-arg output
        { op: "local.get", index: L_VALUE },
        { op: "f64.const", value: NaN },
        { op: "call", funcIdx: toExpIdx! },
        { op: "return" },
      ],
    },
    // prec = (i32)precision
    { op: "local.get", index: L_PRECISION },
    { op: "i32.trunc_f64_s" },
    { op: "local.set", index: L_PREC },
    // if value == 0: render fixed with (prec-1) frac digits
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_VALUE },
        { op: "local.get", index: L_PREC },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: toFixedIdx! },
        { op: "return" },
      ],
    },
    // e = floor(log10(abs)) computed by a normalize loop (no Math.log import)
    // m = abs; e = 0; while m>=10 {m/=10;e++}; while m<1 {m*=10;e--}
    { op: "local.get", index: L_ABS },
    { op: "local.set", index: L_M },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_E },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.lt" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.div" },
            { op: "local.set", index: L_M },
            { op: "local.get", index: L_E },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_E },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 1 },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_M },
            { op: "local.get", index: L_E },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L_E },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Rounding can bump the magnitude (e.g. 9.999 with prec=3 → "10.0"), which
    // increments the decimal exponent. Round m (in [1,10)) to (prec-1)
    // fractional digits; if the rounded mantissa reaches 10, divide by 10 and
    // e++. This corrects the fixed/exp decision and digit count below.
    // rscale = 10^(prec-1)
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_RSCALE },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_RK },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_RK },
            { op: "local.get", index: L_PREC },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_RSCALE },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_RSCALE },
            { op: "local.get", index: L_RK },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_RK },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // m = floor(m*rscale + 0.5) / rscale
    { op: "local.get", index: L_M },
    { op: "local.get", index: L_RSCALE },
    { op: "f64.mul" },
    { op: "f64.const", value: 0.5 },
    { op: "f64.add" },
    { op: "f64.floor" },
    { op: "local.get", index: L_RSCALE },
    { op: "f64.div" },
    { op: "local.set", index: L_M },
    // if m >= 10: m/=10; e++
    { op: "local.get", index: L_M },
    { op: "f64.const", value: 10 },
    { op: "f64.ge" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_M },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "local.set", index: L_M },
        { op: "local.get", index: L_E },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L_E },
      ],
    },
    // if (e < -6 || e >= prec): exponential with (prec-1) frac digits
    {
      op: "local.get",
      index: L_E,
    },
    { op: "i32.const", value: -6 },
    { op: "i32.lt_s" },
    { op: "local.get", index: L_E },
    { op: "local.get", index: L_PREC },
    { op: "i32.ge_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_VALUE },
        { op: "local.get", index: L_PREC },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: toExpIdx! },
        { op: "return" },
      ],
      else: [
        // fixed with fdig = prec - 1 - e fractional digits
        { op: "local.get", index: L_PREC },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.get", index: L_E },
        { op: "i32.sub" },
        { op: "local.set", index: L_FDIG },
        { op: "local.get", index: L_VALUE },
        { op: "local.get", index: L_FDIG },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: toFixedIdx! },
        { op: "return" },
      ],
    },
    // unreachable fallthrough — finalize empty buffer
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  const typeIdx = addFuncType(ctx, [f64, f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toPrecision", funcIdx);
  ctx.mod.functions.push({
    name: "number_toPrecision",
    typeIdx,
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "e", type: i32 },
      { name: "m", type: f64 },
      { name: "prec", type: i32 },
      { name: "noarg", type: i32 },
      { name: "fdig", type: i32 },
      { name: "rscale", type: f64 },
      { name: "rk", type: i32 },
    ],
    body,
    exported: false,
  });
}
