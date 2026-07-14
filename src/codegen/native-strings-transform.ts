// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — length & case transforms (#3182 Wave B, slice 1).
 *
 * Extracted verbatim from the tail of `ensureNativeStringHelpers` in
 * `native-strings.ts` (which had grown to ~4.8k LOC). This module emits
 * the length-shaping methods (`repeat`, `padStart`, `padEnd`) and
 * case mapping (`toLowerCase`/`toUpperCase`, the full-Unicode
 * `emitNativeCaseConversion`, and `isWellFormed`/`toWellFormed`).
 *
 * Each builder takes the shared per-call state ({@link NativeStrShared}) and is
 * called, in the original order, from `ensureNativeStringHelpers` AFTER the
 * core helpers (`__str_flatten`, `__str_concat`, `__str_equals`,
 * `__str_substring`, …) are registered — the builders look those up by name in
 * `ctx.nativeStrHelpers`.
 *
 * This is a pure mechanical relocation: the emitted Wasm bytes are byte-identical
 * to the pre-split inline blocks (verified via `prove-emit-identity`).
 */
import type { Instr } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitNativeCaseConversion } from "./case-convert-native.js";
import { emitNativeWellFormedHelpers } from "./wellformed-native.js";
import type { NativeStrShared } from "./native-strings-shared.js";

/**
 * Length-shaping methods: `repeat`, `padStart`, `padEnd`.
 */
export function emitStrPadRepeatHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__str_repeat(s: ref $NativeString, count: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_repeat", funcIdx);

    // params: s(0), count(1)
    // locals: sLen(2), newLen(3), newArr(4), dst(5), srcData(6), copyI(7), sOff(8)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // if count <= 0 or sLen == 0, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.le_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          { op: "i32.const", value: 0 }, // off = 0
          { op: "i32.const", value: 0 }, // len = 0
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          { op: "local.get", index: 2 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [
              { op: "i32.const", value: 0 }, // off = 0
              { op: "i32.const", value: 0 }, // len = 0
              { op: "i32.const", value: 0 },
              { op: "array.new_default", typeIdx: strDataTypeIdx },
              { op: "struct.new", typeIdx: strTypeIdx },
            ],
            else: [
              // sOff = s.off
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
              { op: "local.set", index: 8 },

              // newLen = sLen * count
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.mul" },
              { op: "local.tee", index: 3 },

              // newArr = array.new_default(newLen)
              { op: "array.new_default", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 4 },

              // srcData = s.data
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
              { op: "local.set", index: 6 },

              // dst = 0
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 5 },

              // outer loop: repeat count times
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 3 },
                      { op: "i32.ge_u" },
                      { op: "br_if", depth: 1 },

                      // array.copy newArr[dst..] <- srcData[sOff..sOff+sLen]
                      { op: "local.get", index: 4 }, // dst array
                      { op: "local.get", index: 5 }, // dst offset
                      { op: "local.get", index: 6 }, // src array
                      { op: "local.get", index: 8 }, // src offset = sOff
                      { op: "local.get", index: 2 }, // length = sLen
                      {
                        op: "array.copy",
                        dstTypeIdx: strDataTypeIdx,
                        srcTypeIdx: strDataTypeIdx,
                      },

                      // dst += sLen
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 2 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },

              // return struct.new(newLen, 0, newArr)
              { op: "local.get", index: 3 }, // len = newLen
              { op: "i32.const", value: 0 }, // off = 0
              { op: "local.get", index: 4 }, // data = newArr
              { op: "struct.new", typeIdx: strTypeIdx },
            ],
          },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_repeat",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: strDataRef },
        { name: "dst", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "copyI", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_padStart(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_padStart", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5), repeated(6), prefix(7)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // padLen = padStr.len
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // if padLen == 0, return s
          { op: "local.get", index: 4 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [{ op: "local.get", index: 0 }],
            else: [
              // fillLen = targetLen - sLen
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },

              // repeated = repeat(padStr, ceil(fillLen / padLen))
              { op: "local.get", index: 2 }, // padStr (1st arg)
              { op: "local.get", index: 5 }, // fillLen
              { op: "local.get", index: 4 }, // padLen
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.get", index: 4 },
              { op: "i32.div_u" }, // count (2nd arg)
              { op: "call", funcIdx: repeatIdx },

              // prefix = repeated.substring(0, fillLen)
              { op: "i32.const", value: 0 },
              { op: "local.get", index: 5 },
              { op: "call", funcIdx: substringIdx },

              // return concat(prefix, s)
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: concatIdx },
            ],
          },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_padStart",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "repeated", type: strRef },
        { name: "prefix", type: strRef },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }

  // --- $__str_padEnd(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_padEnd", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // padLen = padStr.len
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // if padLen == 0, return s
          { op: "local.get", index: 4 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [{ op: "local.get", index: 0 }],
            else: [
              // fillLen = targetLen - sLen
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },

              // repeated = repeat(padStr, ceil(fillLen / padLen))
              { op: "local.get", index: 2 }, // padStr (1st arg)
              { op: "local.get", index: 5 }, // fillLen
              { op: "local.get", index: 4 }, // padLen
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.get", index: 4 },
              { op: "i32.div_u" }, // count (2nd arg)
              { op: "call", funcIdx: repeatIdx },

              // suffix = repeated.substring(0, fillLen)
              { op: "i32.const", value: 0 },
              { op: "local.get", index: 5 },
              { op: "call", funcIdx: substringIdx },

              // return concat(s, suffix)
              // stack has: suffix on top. Store it, push s, push suffix back
              { op: "local.set", index: 6 }, // suffix -> local 6
              { op: "local.get", index: 0 }, // s (1st arg to concat)
              { op: "local.get", index: 6 }, // suffix (2nd arg to concat)
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: concatIdx },
            ],
          },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_padEnd",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }
}

/**
 * Case-mapping methods: the ASCII `toLowerCase`/`toUpperCase` blocks, then
 * the full-Unicode case mapping (`emitNativeCaseConversion`, which re-points the
 * public names) and the `isWellFormed`/`toWellFormed` helpers.
 */
export function emitStrCaseHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__str_toLowerCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps A-Z (65-90) to a-z (97-122), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_toLowerCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop over each code unit
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 65 && ch <= 90) ? ch + 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 65 },
              { op: "i32.ge_u" },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 90 },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.add" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_toLowerCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_toUpperCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps a-z (97-122) to A-Z (65-90), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_toUpperCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 97 && ch <= 122) ? ch - 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 97 },
              { op: "i32.ge_u" },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 122 },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.sub" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_toUpperCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // (#40) Replace the ASCII-only toUpperCase/toLowerCase above with full Unicode
  // simple + special (1:N) case mapping. emitNativeCaseConversion appends the
  // Unicode helpers and re-points the public `__str_to{Upper,Lower}Case` names in
  // nativeStrHelpers at them (the ASCII blocks become dead, wasm-opt drops them).
  // Emitted here, AFTER __str_flatten is registered, so the Unicode helpers can
  // flatten a cons-string input.
  emitNativeCaseConversion(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx);

  // (#3068) String.prototype.isWellFormed / toWellFormed — pure UTF-16
  // code-unit scans over the flattened NativeString. Emitted here (after
  // __str_flatten + the NativeString types exist) so the method arms in
  // string-ops.ts find `__str_isWellFormed` / `__str_toWellFormed` in
  // nativeStrHelpers without a mid-body late-import shift.
  emitNativeWellFormedHelpers(ctx, strTypeIdx, strDataTypeIdx);
}
