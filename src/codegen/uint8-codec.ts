// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3150 — standalone-native `Uint8Array.fromHex(string)` decode.
//
// The ES2025 Uint8Array base64/hex proposal statics (`fromHex` / `fromBase64`)
// used to hard-CE standalone through the `__get_builtin` dynamic-shape refusal
// (#1472 Phase B). This module implements the hex decoder as a self-contained
// byte loop over the input string's UTF-16 code units, writing into a fresh
// packed-`i8` Uint8Array vec (the same `i8_byte` backing `new Uint8Array([...])`
// and `Uint8Array.of` produce standalone, so the result is assignment- and
// method-compatible). No host imports, no cross-cutting substrate.
//
// Spec (§ Uint8Array.fromHex, tc39/proposal-arraybuffer-base64):
//   1. If the string length is odd → throw SyntaxError.
//   2. Each character pair is two hex digits (0-9 / a-f / A-F, case-insensitive);
//      any other character (including whitespace — hex does NOT skip it) →
//      throw SyntaxError.
//   3. The result byte is (hi << 4) | lo.
// The `fromHex(arg)` step "If arg is not a String, throw a TypeError (WITHOUT
// ToString coercion)" is handled at the call site by only routing string-typed
// arguments here; a non-string argument falls through to the existing refusal.

import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

/**
 * Register (idempotently) `__hex_digit(i32) -> i32`: maps an ASCII code unit to
 * its hex value 0-15, or -1 for any non-hex character. Case-insensitive.
 */
function ensureHexDigitHelper(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__hex_digit");
  if (cached !== undefined) return cached;

  const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__hex_digit", funcIdx);

  const C = 0; // param: code unit
  const R = 1; // local: result digit (-1 default)

  const inRange = (lo: number, hi: number): Instr[] => [
    { op: "local.get", index: C },
    { op: "i32.const", value: lo },
    { op: "i32.ge_s" },
    { op: "local.get", index: C },
    { op: "i32.const", value: hi },
    { op: "i32.le_s" },
    { op: "i32.and" },
  ];

  const body: Instr[] = [
    { op: "i32.const", value: -1 },
    { op: "local.set", index: R },
    // '0'..'9' (48..57): c - 48
    ...inRange(48, 57),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: C },
        { op: "i32.const", value: 48 },
        { op: "i32.sub" },
        { op: "local.set", index: R },
      ],
      else: [],
    },
    // 'A'..'F' (65..70): c - 55
    ...inRange(65, 70),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: C },
        { op: "i32.const", value: 55 },
        { op: "i32.sub" },
        { op: "local.set", index: R },
      ],
      else: [],
    },
    // 'a'..'f' (97..102): c - 87
    ...inRange(97, 102),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: C },
        { op: "i32.const", value: 87 },
        { op: "i32.sub" },
        { op: "local.set", index: R },
      ],
      else: [],
    },
    { op: "local.get", index: R },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__hex_digit",
    typeIdx,
    locals: [{ name: "r", type: { kind: "i32" } }],
    body,
    exported: false,
  } as WasmFunction);

  return funcIdx;
}

/**
 * Register (idempotently) `__uint8_from_hex((ref $AnyString)) -> (ref null
 * $vec_i8_byte)` and return its stable func handle. Callers push a native-string
 * argument and `call` this; the result is a standalone Uint8Array vec.
 * Returns -1 if the native-string runtime is unavailable (caller falls through).
 */
export function ensureUint8FromHex(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__uint8_from_hex");
  if (cached !== undefined) return cached;

  ensureNativeStringHelpers(ctx);
  const hexDigitIdx = ensureHexDigitHelper(ctx);

  const strTypeIdx = ctx.nativeStrTypeIdx; // flat $NativeString: {len, off, data}
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx; // i16 code-unit array
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) return -1;

  const vecTypeIdx = getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "ref", typeIdx: anyStrTypeIdx }],
    [{ kind: "ref_null", typeIdx: vecTypeIdx }],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__uint8_from_hex", funcIdx);

  // params: s(0); locals below
  const S = 0;
  const FLAT = 1;
  const LEN = 2;
  const OFF = 3;
  const DATA = 4;
  const OUTLEN = 5;
  const OUT = 6;
  const I = 7;
  const HV = 8;
  const LV = 9;

  const throwSyntax = (msg: string): Instr[] =>
    buildThrowJsErrorInstrs(ctx, "SyntaxError", msg, { forceInModuleCtor: true });

  // Read code unit at logical index `data[off + expr]` (i16 packed → get_u).
  const readCodeUnit = (idxInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: DATA },
    { op: "local.get", index: OFF },
    ...idxInstrs,
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
  ];

  const body: Instr[] = [
    // flat = __str_flatten(s); len/off/data
    { op: "local.get", index: S },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: FLAT },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: LEN },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: OFF },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: DATA },

    // Odd length → SyntaxError.
    { op: "local.get", index: LEN },
    { op: "i32.const", value: 1 },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: throwSyntax("Uint8Array.fromHex: string length must be even"),
      else: [],
    },

    // outLen = len >> 1; out = new i8[outLen]
    { op: "local.get", index: LEN },
    { op: "i32.const", value: 1 },
    { op: "i32.shr_s" },
    { op: "local.set", index: OUTLEN },
    { op: "local.get", index: OUTLEN },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: OUT },

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= outLen break
            { op: "local.get", index: I },
            { op: "local.get", index: OUTLEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // hv = __hex_digit(data[off + 2i])
            ...readCodeUnit([{ op: "local.get", index: I }, { op: "i32.const", value: 1 }, { op: "i32.shl" }]),
            { op: "call", funcIdx: hexDigitIdx },
            { op: "local.set", index: HV },
            // lv = __hex_digit(data[off + 2i + 1])
            ...readCodeUnit([
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
            ]),
            { op: "call", funcIdx: hexDigitIdx },
            { op: "local.set", index: LV },

            // if hv < 0 || lv < 0 → SyntaxError
            { op: "local.get", index: HV },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            { op: "local.get", index: LV },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: throwSyntax("Uint8Array.fromHex: invalid hexadecimal character"),
              else: [],
            },

            // out[i] = (hv << 4) | lv
            { op: "local.get", index: OUT },
            { op: "local.get", index: I },
            { op: "local.get", index: HV },
            { op: "i32.const", value: 4 },
            { op: "i32.shl" },
            { op: "local.get", index: LV },
            { op: "i32.or" },
            { op: "array.set", typeIdx: arrTypeIdx },

            // i++
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return struct.new $vec_i8_byte(outLen, out)
    { op: "local.get", index: OUTLEN },
    { op: "local.get", index: OUT },
    { op: "struct.new", typeIdx: vecTypeIdx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__uint8_from_hex",
    typeIdx,
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "off", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "outLen", type: { kind: "i32" } },
      { name: "out", type: { kind: "ref", typeIdx: arrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "hv", type: { kind: "i32" } },
      { name: "lv", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  } as WasmFunction);

  return funcIdx;
}
