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

/**
 * Register (idempotently) `__base64_digit(i32) -> i32`: maps an ASCII code unit
 * to its base64 value 0-63 (the standard `base64` alphabet), or -1 for any
 * character outside the alphabet. `A-Z`→0-25, `a-z`→26-51, `0-9`→52-61,
 * `+`→62, `/`→63.
 */
function ensureBase64DigitHelper(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__base64_digit");
  if (cached !== undefined) return cached;

  const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__base64_digit", funcIdx);

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
  const rangeArm = (lo: number, hi: number, bias: number): Instr[] => [
    ...inRange(lo, hi),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: C },
        { op: "i32.const", value: bias },
        { op: "i32.add" },
        { op: "local.set", index: R },
      ],
      else: [],
    },
  ];
  const eqArm = (code: number, val: number): Instr[] => [
    { op: "local.get", index: C },
    { op: "i32.const", value: code },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: val },
        { op: "local.set", index: R },
      ],
      else: [],
    },
  ];

  const body: Instr[] = [
    { op: "i32.const", value: -1 },
    { op: "local.set", index: R },
    // 'A'..'Z' (65..90): c - 65
    ...rangeArm(65, 90, -65),
    // 'a'..'z' (97..122): c - 71  (97-71 = 26)
    ...rangeArm(97, 122, -71),
    // '0'..'9' (48..57): c + 4  (48+4 = 52)
    ...rangeArm(48, 57, 4),
    // '+' (43): 62
    ...eqArm(43, 62),
    // '/' (47): 63
    ...eqArm(47, 63),
    { op: "local.get", index: R },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__base64_digit",
    typeIdx,
    locals: [{ name: "r", type: { kind: "i32" } }],
    body,
    exported: false,
  } as WasmFunction);

  return funcIdx;
}

/**
 * Register (idempotently) `__uint8_from_base64((ref $AnyString)) -> (ref null
 * $vec_i8_byte)` and return its stable func handle. Decodes a standard-alphabet
 * base64 string (default options: `alphabet: "base64"`, `lastChunkHandling:
 * "loose"`) into a fresh packed-`i8` Uint8Array vec.
 *
 * Spec (§ Uint8Array.fromBase64 / FromBase64, tc39/proposal-arraybuffer-base64,
 * default `loose` last-chunk handling):
 *   - ASCII whitespace (\t \n \f \r space) between characters is skipped.
 *   - Each 4-character group decodes to 3 bytes.
 *   - A trailing partial group is permitted: 2 chars → 1 byte, 3 chars → 2
 *     bytes (loose mode ignores the unused low bits); a single trailing char is
 *     a SyntaxError.
 *   - `=` padding ends the data; it is only valid when a 2- or 3-char partial
 *     chunk precedes it, and only whitespace / further `=` may follow.
 *   - Any character outside the alphabet (and not whitespace / `=`) throws a
 *     SyntaxError.
 * The `alphabet` / `lastChunkHandling` OPTIONS object is not handled here — only
 * a bare string argument routes to this path (a call with an options arg falls
 * through to the existing dynamic-shape refusal), so no wrong-default is
 * silently applied. Returns -1 if the native-string runtime is unavailable.
 */
export function ensureUint8FromBase64(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__uint8_from_base64");
  if (cached !== undefined) return cached;

  ensureNativeStringHelpers(ctx);
  const b64DigitIdx = ensureBase64DigitHelper(ctx);

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
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
  ctx.funcMap.set("__uint8_from_base64", funcIdx);

  // params: s(0); locals below
  const S = 0;
  const FLAT = 1;
  const LEN = 2;
  const OFF = 3;
  const DATA = 4;
  const CAP = 5;
  const OUT = 6;
  const OUTLEN = 7;
  const I = 8;
  const C = 9;
  const D = 10;
  const ACC = 11;
  const NCH = 12;
  const PAD = 13;
  const FINAL = 14;

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

  // i32 bool: is the code unit in local C an ASCII whitespace char?
  const isWhitespace: Instr[] = [
    { op: "local.get", index: C },
    { op: "i32.const", value: 9 },
    { op: "i32.eq" },
    { op: "local.get", index: C },
    { op: "i32.const", value: 10 },
    { op: "i32.eq" },
    { op: "i32.or" },
    { op: "local.get", index: C },
    { op: "i32.const", value: 12 },
    { op: "i32.eq" },
    { op: "i32.or" },
    { op: "local.get", index: C },
    { op: "i32.const", value: 13 },
    { op: "i32.eq" },
    { op: "i32.or" },
    { op: "local.get", index: C },
    { op: "i32.const", value: 32 },
    { op: "i32.eq" },
    { op: "i32.or" },
  ];

  // out[OUTLEN] = (ACC >> shift) & 0xff ; OUTLEN++
  const emitByte = (shift: number): Instr[] => [
    { op: "local.get", index: OUT },
    { op: "local.get", index: OUTLEN },
    { op: "local.get", index: ACC },
    { op: "i32.const", value: shift },
    { op: "i32.shr_u" },
    { op: "array.set", typeIdx: arrTypeIdx },
    { op: "local.get", index: OUTLEN },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: OUTLEN },
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

    // cap = (len * 3) >> 2 + 3 (upper bound on decoded bytes); out = new i8[cap]
    { op: "local.get", index: LEN },
    { op: "i32.const", value: 3 },
    { op: "i32.mul" },
    { op: "i32.const", value: 2 },
    { op: "i32.shr_u" },
    { op: "i32.const", value: 3 },
    { op: "i32.add" },
    { op: "local.set", index: CAP },
    { op: "local.get", index: CAP },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: OUT },

    // outLen = 0; i = 0; acc = 0; nch = 0; pad = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: OUTLEN },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: ACC },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: NCH },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: PAD },

    // main decode loop
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= len break
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // c = data[off + i]; i++
            ...readCodeUnit([{ op: "local.get", index: I }]),
            { op: "local.set", index: C },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },

            // whitespace → continue
            ...isWhitespace,
            { op: "br_if", depth: 0 },

            // pad = (c == '='); if pad break (padding ends the data section)
            { op: "local.get", index: C },
            { op: "i32.const", value: 61 },
            { op: "i32.eq" },
            { op: "local.set", index: PAD },
            { op: "local.get", index: PAD },
            { op: "br_if", depth: 1 },

            // d = __base64_digit(c); if d < 0 → SyntaxError
            { op: "local.get", index: C },
            { op: "call", funcIdx: b64DigitIdx },
            { op: "local.set", index: D },
            { op: "local.get", index: D },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: throwSyntax("Uint8Array.fromBase64: invalid base64 character"),
              else: [],
            },

            // acc = (acc << 6) | d; nch++
            { op: "local.get", index: ACC },
            { op: "i32.const", value: 6 },
            { op: "i32.shl" },
            { op: "local.get", index: D },
            { op: "i32.or" },
            { op: "local.set", index: ACC },
            { op: "local.get", index: NCH },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: NCH },

            // if nch == 4: emit 3 bytes, reset acc/nch
            { op: "local.get", index: NCH },
            { op: "i32.const", value: 4 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...emitByte(16),
                ...emitByte(8),
                ...emitByte(0),
                { op: "i32.const", value: 0 },
                { op: "local.set", index: ACC },
                { op: "i32.const", value: 0 },
                { op: "local.set", index: NCH },
              ],
              else: [],
            },

            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // ---- final partial chunk + padding validation ----
    // pad with nch == 0 → SyntaxError (padding with no preceding partial chunk)
    { op: "local.get", index: PAD },
    { op: "local.get", index: NCH },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: throwSyntax("Uint8Array.fromBase64: unexpected padding"),
      else: [],
    },
    // nch == 1 → SyntaxError (a single trailing sextet cannot form a byte)
    { op: "local.get", index: NCH },
    { op: "i32.const", value: 1 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: throwSyntax("Uint8Array.fromBase64: malformed trailing character"),
      else: [],
    },
    // nch == 2 → emit 1 byte (top 8 of 12 bits: acc >> 4)
    { op: "local.get", index: NCH },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...emitByte(4)],
      else: [],
    },
    // nch == 3 → emit 2 bytes (top 16 of 18 bits: acc >> 10, acc >> 2)
    { op: "local.get", index: NCH },
    { op: "i32.const", value: 3 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...emitByte(10), ...emitByte(2)],
      else: [],
    },

    // if pad: the remainder of the string may contain only '=' / whitespace
    {
      op: "local.get",
      index: PAD,
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: I },
                { op: "local.get", index: LEN },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...readCodeUnit([{ op: "local.get", index: I }]),
                { op: "local.set", index: C },
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                // allowed: whitespace or '=' ; anything else → SyntaxError
                ...isWhitespace,
                { op: "local.get", index: C },
                { op: "i32.const", value: 61 },
                { op: "i32.eq" },
                { op: "i32.or" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: throwSyntax("Uint8Array.fromBase64: unexpected character after padding"),
                  else: [],
                },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
      else: [],
    },

    // trim to exact length: final = new i8[outLen]; copy out[0..outLen) → final
    { op: "local.get", index: OUTLEN },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: FINAL },
    { op: "local.get", index: FINAL },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: OUT },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: OUTLEN },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },

    // return struct.new $vec_i8_byte(outLen, final)
    { op: "local.get", index: OUTLEN },
    { op: "local.get", index: FINAL },
    { op: "struct.new", typeIdx: vecTypeIdx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__uint8_from_base64",
    typeIdx,
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "off", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "cap", type: { kind: "i32" } },
      { name: "out", type: { kind: "ref", typeIdx: arrTypeIdx } },
      { name: "outLen", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "c", type: { kind: "i32" } },
      { name: "d", type: { kind: "i32" } },
      { name: "acc", type: { kind: "i32" } },
      { name: "nch", type: { kind: "i32" } },
      { name: "pad", type: { kind: "i32" } },
      { name: "final", type: { kind: "ref", typeIdx: arrTypeIdx } },
    ],
    body,
    exported: false,
  } as WasmFunction);

  return funcIdx;
}
