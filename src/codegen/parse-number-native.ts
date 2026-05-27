// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `parseInt` / `parseFloat` for standalone / WASI targets (#1663).
 *
 * In JS-host mode `parseInt` / `parseFloat` are `env` imports. Under
 * `--target wasi` / `--target standalone` there is no JS runtime to satisfy
 * them, so this module emits WasmGC-native implementations registered under
 * the same `ctx.funcMap` names ("parseInt" / "parseFloat"). All existing call
 * sites push the string argument as an `externref`, so the native functions
 * take `externref` too: they `any.convert_extern` + `ref.cast` to the WasmGC
 * `$AnyString`, flatten it to a contiguous i16 buffer via `__str_flatten`, then
 * scan the UTF-16 code units.
 *
 * Spec references:
 * - parseInt   — ECMA-262 §19.2.5 (sign, optional 0x prefix, radix digit loop)
 * - parseFloat — ECMA-262 §19.2.4 (longest StrDecimalLiteral prefix, Infinity)
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

const C_TAB = 9;
const C_LF = 10;
const C_VT = 11;
const C_FF = 12;
const C_CR = 13;
const C_SPACE = 32;
const C_NBSP = 0xa0;
const C_PLUS = 43;
const C_MINUS = 45;
const C_DOT = 46;
const C_ZERO = 48;
const C_NINE = 57;
const C_UC_A = 65;
const C_UC_E = 69;
const C_UC_X = 88;
const C_UC_Z = 90;
const C_LC_A = 97;
const C_LC_E = 101;
const C_LC_X = 120;
const C_LC_Z = 122;

/**
 * Push the instructions that take an `externref` string on the stack and leave
 * a flat `$NativeString` ref. Mirrors the charCodeAt flatten preamble.
 */
function externToFlat(ctx: CodegenContext, flattenIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
    { op: "call", funcIdx: flattenIdx } as Instr,
  ];
}

/**
 * `isWhiteSpace(c)` inline test: c==space|tab|LF|VT|FF|CR|NBSP. Leaves i32 bool.
 * Operand: the code unit on the stack is consumed via a local.
 */
function isWsBody(cLocal: number): Instr[] {
  const eq = (code: number): Instr[] => [
    { op: "local.get", index: cLocal } as Instr,
    { op: "i32.const", value: code } as Instr,
    { op: "i32.eq" } as Instr,
  ];
  // c==space || c==tab || c==LF || c==VT || c==FF || c==CR || c==NBSP
  return [
    ...eq(C_SPACE),
    ...eq(C_TAB),
    { op: "i32.or" } as Instr,
    ...eq(C_LF),
    { op: "i32.or" } as Instr,
    ...eq(C_VT),
    { op: "i32.or" } as Instr,
    ...eq(C_FF),
    { op: "i32.or" } as Instr,
    ...eq(C_CR),
    { op: "i32.or" } as Instr,
    ...eq(C_NBSP),
    { op: "i32.or" } as Instr,
  ];
}

/**
 * Emit native `parseInt` / `parseFloat` functions and register them in
 * `ctx.funcMap` (and a dedicated set on ctx for idempotency). Must run before
 * any function bodies that `call ctx.funcMap.get("parseInt")` are compiled, and
 * after `ensureNativeStringHelpers` (which it calls) so `__str_flatten` exists.
 *
 * @param which Set of names to emit — subset of {"parseInt","parseFloat"}.
 */
export function emitNativeParseNumber(ctx: CodegenContext, which: Set<string>): void {
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };

  if (which.has("parseFloat") && !ctx.funcMap.has("parseFloat")) {
    // (externref) -> f64
    const typeIdx = addFuncType(ctx, [extern], [f64]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set("parseFloat", funcIdx);

    // locals (after param 0 = s:externref):
    //  1 flat:ref$NativeString  2 data:ref$i16arr  3 len:i32  4 i:i32
    //  5 c:i32  6 sign:f64  7 mant:f64  8 sawDigit:i32  9 frac:f64
    // 10 expSign:i32 11 exp:i32 12 result:f64 13 start:i32
    const L_FLAT = 1;
    const L_DATA = 2;
    const L_LEN = 3;
    const L_I = 4;
    const L_C = 5;
    const L_SIGN = 6;
    const L_MANT = 7;
    const L_SAW = 8;
    const L_EXPSIGN = 10;
    const L_EXP = 11;
    const L_RESULT = 12;

    const getC: Instr[] = [
      { op: "local.get", index: L_DATA },
      { op: "local.get", index: L_I },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: L_C },
    ];

    const body: Instr[] = [
      // flat = flatten(s); data = flat.data; len = flat.len; i = 0
      ...externToFlat(ctx, flattenIdx),
      { op: "local.set", index: L_FLAT },
      { op: "local.get", index: L_FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: L_DATA },
      { op: "local.get", index: L_FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: L_LEN },
      // i = off (flat strings may carry a nonzero off)
      { op: "local.get", index: L_FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: L_I },
      // len = off + len  (so L_I..L_LEN spans the logical string)
      { op: "local.get", index: L_LEN },
      { op: "local.get", index: L_I },
      { op: "i32.add" },
      { op: "local.set", index: L_LEN },
      { op: "f64.const", value: 1 },
      { op: "local.set", index: L_SIGN },
      { op: "f64.const", value: 0 },
      { op: "local.set", index: L_MANT },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_SAW },

      // --- skip leading whitespace ---
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i>=len break
              { op: "local.get", index: L_I },
              { op: "local.get", index: L_LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...getC,
              // if !ws break
              ...isWsBody(L_C),
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // --- optional sign ---
      { op: "local.get", index: L_I },
      { op: "local.get", index: L_LEN },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...getC,
          { op: "local.get", index: L_C },
          { op: "i32.const", value: C_MINUS },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "f64.const", value: -1 },
              { op: "local.set", index: L_SIGN },
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
            ],
            else: [
              { op: "local.get", index: L_C },
              { op: "i32.const", value: C_PLUS },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: L_I },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: L_I },
                ],
              },
            ],
          },
        ],
      },

      // --- Infinity check ---
      ...emitInfinityCheck(L_I, L_LEN, L_DATA, L_C, L_SIGN, strDataTypeIdx),

      // --- integer digits ---
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
              ...getC,
              // if c<'0' || c>'9' break
              { op: "local.get", index: L_C },
              { op: "i32.const", value: C_ZERO },
              { op: "i32.lt_s" },
              { op: "local.get", index: L_C },
              { op: "i32.const", value: C_NINE },
              { op: "i32.gt_s" },
              { op: "i32.or" },
              { op: "br_if", depth: 1 },
              // mant = mant*10 + (c-'0')
              { op: "local.get", index: L_MANT },
              { op: "f64.const", value: 10 },
              { op: "f64.mul" },
              { op: "local.get", index: L_C },
              { op: "i32.const", value: C_ZERO },
              { op: "i32.sub" },
              { op: "f64.convert_i32_s" },
              { op: "f64.add" },
              { op: "local.set", index: L_MANT },
              { op: "i32.const", value: 1 },
              { op: "local.set", index: L_SAW },
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // --- fraction ---
      { op: "local.get", index: L_I },
      { op: "local.get", index: L_LEN },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...getC,
          { op: "local.get", index: L_C },
          { op: "i32.const", value: C_DOT },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // advance past '.'
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              // scale local reused: use L_EXP as f64? need separate f64 scale.
              // Use mant accumulation with a divisor tracked in local 9 (frac scale).
              { op: "f64.const", value: 0.1 },
              { op: "local.set", index: 9 },
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
                      ...getC,
                      { op: "local.get", index: L_C },
                      { op: "i32.const", value: C_ZERO },
                      { op: "i32.lt_s" },
                      { op: "local.get", index: L_C },
                      { op: "i32.const", value: C_NINE },
                      { op: "i32.gt_s" },
                      { op: "i32.or" },
                      { op: "br_if", depth: 1 },
                      // mant += (c-'0') * scale ; scale *= 0.1
                      { op: "local.get", index: L_MANT },
                      { op: "local.get", index: L_C },
                      { op: "i32.const", value: C_ZERO },
                      { op: "i32.sub" },
                      { op: "f64.convert_i32_s" },
                      { op: "local.get", index: 9 },
                      { op: "f64.mul" },
                      { op: "f64.add" },
                      { op: "local.set", index: L_MANT },
                      { op: "local.get", index: 9 },
                      { op: "f64.const", value: 0.1 },
                      { op: "f64.mul" },
                      { op: "local.set", index: 9 },
                      { op: "i32.const", value: 1 },
                      { op: "local.set", index: L_SAW },
                      { op: "local.get", index: L_I },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: L_I },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },

      // if !sawDigit return NaN
      { op: "local.get", index: L_SAW },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "f64.const", value: NaN }, { op: "return" }],
      },

      // --- exponent ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_EXP },
      { op: "i32.const", value: 1 },
      { op: "local.set", index: L_EXPSIGN },
      ...emitExponent(L_I, L_LEN, L_DATA, L_C, L_EXP, L_EXPSIGN, strDataTypeIdx, getC),

      // result = sign * mant ; then apply exponent via a pow10 loop that
      // operates on the L_RESULT local (a value cannot be carried on the
      // operand stack across a `loop` with empty block type).
      { op: "local.get", index: L_SIGN },
      { op: "local.get", index: L_MANT },
      { op: "f64.mul" },
      { op: "local.set", index: L_RESULT },
      ...emitApplyExp(L_EXP, L_EXPSIGN, L_RESULT),
      { op: "local.get", index: L_RESULT },
      { op: "return" },
    ];

    ctx.mod.functions.push({
      name: "parseFloat",
      typeIdx,
      locals: [
        { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
        { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
        { name: "len", type: i32 },
        { name: "i", type: i32 },
        { name: "c", type: i32 },
        { name: "sign", type: f64 },
        { name: "mant", type: f64 },
        { name: "sawDigit", type: i32 },
        { name: "fracScale", type: f64 },
        { name: "expSign", type: i32 },
        { name: "exp", type: i32 },
        { name: "result", type: f64 },
      ],
      body,
      exported: false,
    });
  }

  if (which.has("parseInt") && !ctx.funcMap.has("parseInt")) {
    emitParseInt(ctx, flattenIdx, strTypeIdx, strDataTypeIdx);
  }
}

/** Emit `if (substring starting at i == "Infinity") return sign*Infinity`. */
function emitInfinityCheck(
  L_I: number,
  L_LEN: number,
  L_DATA: number,
  L_C: number,
  L_SIGN: number,
  strDataTypeIdx: number,
): Instr[] {
  const word = "Infinity";
  // The array reads must be guarded by the length check FIRST — Wasm `i32.and`
  // does not short-circuit, so reading data[i+k] before confirming i+8<=len
  // would trap (array OOB). Structure: if (i+8<=len) { chained char compare; if
  // (allMatch) return sign*Infinity }.
  const charChecks: Instr[] = [];
  for (let k = 0; k < word.length; k++) {
    charChecks.push({ op: "local.get", index: L_DATA });
    charChecks.push({ op: "local.get", index: L_I });
    charChecks.push({ op: "i32.const", value: k });
    charChecks.push({ op: "i32.add" });
    charChecks.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    charChecks.push({ op: "i32.const", value: word.charCodeAt(k) });
    charChecks.push({ op: "i32.eq" });
    if (k > 0) charChecks.push({ op: "i32.and" });
  }
  void L_C;
  return [
    { op: "local.get", index: L_I },
    { op: "i32.const", value: word.length },
    { op: "i32.add" },
    { op: "local.get", index: L_LEN },
    { op: "i32.le_s" }, // i+8 <= len
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...charChecks,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_SIGN },
            { op: "f64.const", value: Infinity },
            { op: "f64.mul" },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** Scan optional exponent `[eE][+-]?digits`, accumulating into L_EXP / L_EXPSIGN. */
function emitExponent(
  L_I: number,
  L_LEN: number,
  L_DATA: number,
  L_C: number,
  L_EXP: number,
  L_EXPSIGN: number,
  strDataTypeIdx: number,
  getC: Instr[],
): Instr[] {
  return [
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_LEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_LC_E },
        { op: "i32.eq" },
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_E },
        { op: "i32.eq" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // tentatively consume 'e'
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            // optional sign
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_LEN },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...getC,
                { op: "local.get", index: L_C },
                { op: "i32.const", value: C_MINUS },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: -1 },
                    { op: "local.set", index: L_EXPSIGN },
                    { op: "local.get", index: L_I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_I },
                  ],
                  else: [
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_PLUS },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: L_I },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: L_I },
                      ],
                    },
                  ],
                },
              ],
            },
            // exponent digits
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
                    { op: "local.get", index: L_DATA },
                    { op: "local.get", index: L_I },
                    { op: "array.get_u", typeIdx: strDataTypeIdx },
                    { op: "local.set", index: L_C },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_ZERO },
                    { op: "i32.lt_s" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_NINE },
                    { op: "i32.gt_s" },
                    { op: "i32.or" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_EXP },
                    { op: "i32.const", value: 10 },
                    { op: "i32.mul" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_ZERO },
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    { op: "local.set", index: L_EXP },
                    { op: "local.get", index: L_I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_I },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Scale the f64 in `L_RESULT` by 10^(expSign*exp) using a count-down loop that
 * reads and writes the local each iteration (an operand-stack value cannot be
 * carried across a `loop` with an empty block type).
 */
function emitApplyExp(L_EXP: number, L_EXPSIGN: number, L_RESULT: number): Instr[] {
  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if exp==0 done
            { op: "local.get", index: L_EXP },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // result = (expSign<0) ? result/10 : result*10. Each arm reads and
            // writes L_RESULT itself, so no operand crosses the `if` boundary
            // (a plain `if` block has no params under the MVP block type).
            { op: "local.get", index: L_EXPSIGN },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_RESULT },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "local.set", index: L_RESULT },
              ],
              else: [
                { op: "local.get", index: L_RESULT },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: L_RESULT },
              ],
            },
            { op: "local.get", index: L_EXP },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L_EXP },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/**
 * Native `parseInt(s, radix)` — signature `(externref, f64) -> f64`. The radix
 * arg is NaN when omitted (matches the host-import convention). Implements
 * ECMA-262 §19.2.5: trim ws, optional sign, optional 0x prefix (radix 16 /
 * auto), digit loop in radix 2..36, NaN if no digits.
 */
function emitParseInt(ctx: CodegenContext, flattenIdx: number, strTypeIdx: number, strDataTypeIdx: number): void {
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [extern, f64], [f64]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("parseInt", funcIdx);

  // params: 0 s:externref, 1 radixF:f64
  // locals: 2 flat 3 data 4 len 5 i 6 c 7 sign:f64 8 radix:i32
  //         9 value:f64 10 sawDigit:i32 11 dig:i32
  const L_FLAT = 2;
  const L_DATA = 3;
  const L_LEN = 4;
  const L_I = 5;
  const L_C = 6;
  const L_SIGN = 7;
  const L_RADIX = 8;
  const L_VALUE = 9;
  const L_SAW = 10;
  const L_DIG = 11;

  const getC: Instr[] = [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
  ];

  const body: Instr[] = [
    ...([
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: L_FLAT },
    ] as Instr[]),
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: L_DATA },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: L_I }, // i = off
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: L_I },
    { op: "i32.add" },
    { op: "local.set", index: L_LEN }, // len = off + len
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SIGN },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: L_VALUE },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_SAW },
    // radix = (radixF != radixF) ? 0 : trunc(radixF)
    { op: "local.get", index: 1 },
    { op: "local.get", index: 1 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_RADIX },
      ],
      else: [{ op: "local.get", index: 1 }, { op: "i32.trunc_sat_f64_s" }, { op: "local.set", index: L_RADIX }],
    },

    // skip whitespace
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
            ...getC,
            ...isWsBody(L_C),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // optional sign
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_LEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_MINUS },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "f64.const", value: -1 },
            { op: "local.set", index: L_SIGN },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
          ],
          else: [
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_PLUS },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
              ],
            },
          ],
        },
      ],
    },

    // 0x prefix handling: if radix==0||16 and next two chars are "0x"/"0X"
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: L_LEN },
    { op: "i32.lt_s" }, // i+1 < len
    { op: "local.get", index: L_RADIX },
    { op: "i32.eqz" },
    { op: "local.get", index: L_RADIX },
    { op: "i32.const", value: 16 },
    { op: "i32.eq" },
    { op: "i32.or" }, // radix==0||16
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_DATA },
        { op: "local.get", index: L_I },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: C_ZERO },
        { op: "i32.eq" },
        { op: "local.get", index: L_DATA },
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: C_LC_X },
        { op: "i32.eq" },
        { op: "local.get", index: L_DATA },
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: C_UC_X },
        { op: "i32.eq" },
        { op: "i32.or" }, // [i+1]=='x'||'X'
        { op: "i32.and" }, // [i]=='0' && ...
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 16 },
            { op: "local.set", index: L_RADIX },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
          ],
        },
      ],
    },

    // default radix 10 if still 0
    { op: "local.get", index: L_RADIX },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 10 },
        { op: "local.set", index: L_RADIX },
      ],
    },
    // radix range check: 2..36 else NaN
    { op: "local.get", index: L_RADIX },
    { op: "i32.const", value: 2 },
    { op: "i32.lt_s" },
    { op: "local.get", index: L_RADIX },
    { op: "i32.const", value: 36 },
    { op: "i32.gt_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },

    // digit loop
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
            ...getC,
            // dig = digitValue(c)
            ...emitDigitValue(L_C, L_DIG),
            // if dig < 0 || dig >= radix break
            { op: "local.get", index: L_DIG },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            { op: "local.get", index: L_DIG },
            { op: "local.get", index: L_RADIX },
            { op: "i32.ge_s" },
            { op: "i32.or" },
            { op: "br_if", depth: 1 },
            // value = value*radix + dig
            { op: "local.get", index: L_VALUE },
            { op: "local.get", index: L_RADIX },
            { op: "f64.convert_i32_s" },
            { op: "f64.mul" },
            { op: "local.get", index: L_DIG },
            { op: "f64.convert_i32_s" },
            { op: "f64.add" },
            { op: "local.set", index: L_VALUE },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: L_SAW },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // if !sawDigit return NaN
    { op: "local.get", index: L_SAW },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    { op: "local.get", index: L_SIGN },
    { op: "local.get", index: L_VALUE },
    { op: "f64.mul" },
    { op: "return" },
  ];

  ctx.mod.functions.push({
    name: "parseInt",
    typeIdx,
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "len", type: i32 },
      { name: "i", type: i32 },
      { name: "c", type: i32 },
      { name: "sign", type: f64 },
      { name: "radix", type: i32 },
      { name: "value", type: f64 },
      { name: "sawDigit", type: i32 },
      { name: "dig", type: i32 },
    ],
    body,
    exported: false,
  });
}

/**
 * Map code unit in L_C to its digit value in L_DIG: '0'-'9' → 0-9,
 * 'A'-'Z'/'a'-'z' → 10-35, else -1.
 */
function emitDigitValue(L_C: number, L_DIG: number): Instr[] {
  return [
    { op: "i32.const", value: -1 },
    { op: "local.set", index: L_DIG },
    // 0-9
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_ZERO },
    { op: "i32.ge_s" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_NINE },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_ZERO },
        { op: "i32.sub" },
        { op: "local.set", index: L_DIG },
      ],
      else: [
        // A-Z
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_A },
        { op: "i32.ge_s" },
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_Z },
        { op: "i32.le_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_UC_A - 10 },
            { op: "i32.sub" },
            { op: "local.set", index: L_DIG },
          ],
          else: [
            // a-z
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_LC_A },
            { op: "i32.ge_s" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_LC_Z },
            { op: "i32.le_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_C },
                { op: "i32.const", value: C_LC_A - 10 },
                { op: "i32.sub" },
                { op: "local.set", index: L_DIG },
              ],
            },
          ],
        },
      ],
    },
  ];
}
