// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — search & trim (#3182 Wave B, slice 1).
 *
 * Extracted verbatim from the tail of `ensureNativeStringHelpers` in
 * `native-strings.ts` (which had grown to ~4.8k LOC). This module emits
 * the scan-based query methods (`indexOf`, `lastIndexOf`, `includes`,
 * `startsWith`, `endsWith`) and whitespace trimming (`__str_isWhitespace`,
 * `trimStart`, `trimEnd`, `trim`).
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
import type { NativeStrShared } from "./native-strings-shared.js";

/**
 * `String.prototype` search methods: `indexOf`, `lastIndexOf`, `includes`,
 * `startsWith`, `endsWith`.
 */
export function emitStrSearchHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__str_indexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_indexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      // hLen = haystack.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // nLen = needle.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if nLen == 0, return clamp(fromIndex, 0, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "i32.gt_s" },
          { op: "select" },
          { op: "local.tee", index: 5 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 5 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff = haystack.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // nOff = needle.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData = haystack.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      // nData = needle.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // outer loop: scan i from fromIndex to hLen - nLen
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i > hLen - nLen, break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "i32.sub" },
              { op: "i32.gt_s" },
              { op: "br_if", depth: 1 },
              // j = 0; inner loop to compare needle chars
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if j >= nLen, match found — return i
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "local.get", index: 5 }, { op: "return" }],
                      },
                      // if hData[hOff + i + j] != nData[nOff + j], break inner
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 5 },
                      { op: "i32.add" },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 10 },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "i32.ne" },
                      { op: "br_if", depth: 1 },
                      // j++
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_indexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_lastIndexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_lastIndexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // (#2875) §22.1.3.9 step 8: start candidates are bounded by
      // min(max(pos, 0), …) — clamp fromIndex to ≥ 0 ONCE here so both the
      // empty-needle arm (min(fromIndex, hLen)) and the scan init
      // (min(fromIndex, hLen - nLen)) see the spec's max(pos, 0). Without it,
      // lastIndexOf('a', -1) started the reverse scan at -1 and returned -1
      // instead of checking position 0.
      // fromIndex = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // if nLen == 0, return min(fromIndex, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff, nOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData, nData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = min(fromIndex, hLen - nLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "i32.sub" },
      { op: "local.tee", index: 5 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 5 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // reverse scan
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "br_if", depth: 1 },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "local.get", index: 5 }, { op: "return" }],
                      },
                      // hData[hOff + i + j]
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 5 },
                      { op: "i32.add" },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      // nData[nOff + j]
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 10 },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "i32.ne" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_lastIndexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_includes(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_includes", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_includes",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_startsWith(s: ref $NativeString, prefix: ref $NativeString, position: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_startsWith", funcIdx);

    // params: s(0), prefix(1), position(2)
    // locals: sLen(3), pLen(4), i(5), sData(6), pData(7), sOff(8), pOff(9)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // (#2875) §22.1.3.23 step 12: start = min(max(pos, 0), len). Without the
      // clamp, position=INT_MAX (the trunc-sat of Infinity) overflows the
      // `position + pLen` check below into a negative and the scan reads OOB
      // (trap), and a negative position reads sData[sOff-…] (trap) instead of
      // searching from 0 — startsWith('!', Infinity) / ('The', -1).
      // position = max(position, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // position = min(position, sLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // if position + pLen > sLen, return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.add" },
      { op: "local.get", index: 3 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // sOff, pOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // sData, pData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      // compare loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              // sData[sOff + position + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              // pData[pOff + i]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // mismatch found
      { op: "i32.const", value: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_startsWith",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "pLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "pData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
        { name: "pOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_endsWith(s: ref $NativeString, suffix: ref $NativeString, endPos: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_endsWith", funcIdx);

    // params: s(0), suffix(1), endPos(2)
    // locals: sxLen(3), i(4), sData(5), xData(6), startPos(7), sLen(8), sOff(9), xOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // sLen = s.len; clamp endPos to sLen
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 8 },
      // (#2875) §22.1.3.6 step 7: end = min(max(pos, 0), len). The max(0) arm
      // was missing — endsWith('', -1) computed startPos = -1 - 0 < 0 → false,
      // but the spec clamps a negative endPosition to 0 (empty suffix → true).
      // endPos = max(endPos, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // endPos = min(endPos, sLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // startPos = endPos - sxLen
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.sub" },
      { op: "local.set", index: 7 },
      // if startPos < 0, return 0
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // sOff, xOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // sData, xData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              // sData[sOff + startPos + i]
              { op: "local.get", index: 5 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 7 },
              { op: "i32.add" },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              // xData[xOff + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 10 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_endsWith",
      typeIdx,
      locals: [
        { name: "sxLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "xData", type: strDataRef },
        { name: "startPos", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
        { name: "xOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }
}

/**
 * Whitespace trimming: the `__str_isWhitespace` predicate plus
 * `trimStart`, `trimEnd`, `trim`.
 */
export function emitStrTrimHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__str_isWhitespace(codeUnit: i32) -> i32 (helper, not exported) ---
  // §22.1.3.32 TrimString trims WhiteSpace + LineTerminator. The full set
  // (#1963) mirrors the regex `\s` SPACE table in src/codegen/regex/parse.ts:
  //   0x09-0x0D, 0x20, 0xA0, 0x1680, 0x2000-0x200A, 0x2028, 0x2029, 0x202F,
  //   0x205F, 0x3000, 0xFEFF (BOM/ZWNBSP).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_isWhitespace", funcIdx);

    // Membership test as an OR-chain. `eq(v)` / `range(lo,hi)` each push one i32
    // truthy value; all are OR-ed together. The two ASCII forms (0x20 and
    // 0x09-0x0D) stay first so the common case folds cheaply.
    const eq = (v: number): Instr[] => [{ op: "local.get", index: 0 }, { op: "i32.const", value: v }, { op: "i32.eq" }];
    const range = (lo: number, hi: number): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: lo },
      { op: "i32.ge_u" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: hi },
      { op: "i32.le_u" },
      { op: "i32.and" },
    ];

    const body: Instr[] = [
      ...eq(0x20),
      ...range(0x09, 0x0d),
      { op: "i32.or" },
      ...eq(0xa0),
      { op: "i32.or" },
      ...eq(0x1680),
      { op: "i32.or" },
      ...range(0x2000, 0x200a),
      { op: "i32.or" },
      ...eq(0x2028),
      { op: "i32.or" },
      ...eq(0x2029),
      { op: "i32.or" },
      ...eq(0x202f),
      { op: "i32.or" },
      ...eq(0x205f),
      { op: "i32.or" },
      ...eq(0x3000),
      { op: "i32.or" },
      ...eq(0xfeff),
      { op: "i32.or" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_isWhitespace",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_trimStart(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_trimStart", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: len(1), i(2), sData(3), sOff(4)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 }, // sData
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      // scan forward while whitespace
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // sData[sOff + i]
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "call", funcIdx: isWsIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return substring(s, i, len)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_trimStart",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trimEnd(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_trimEnd", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: end(1), sData(2), sOff(3)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 }, // end = len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 }, // sData
      // scan backward while whitespace
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 0 },
              { op: "i32.le_s" },
              { op: "br_if", depth: 1 },
              // sData[sOff + end - 1]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "call", funcIdx: isWsIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 1 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return substring(s, 0, end)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_trimEnd",
      typeIdx,
      locals: [
        { name: "end", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trim(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_trim", funcIdx);

    const trimStartIdx = ctx.nativeStrHelpers.get("__str_trimStart")!;
    const trimEndIdx = ctx.nativeStrHelpers.get("__str_trimEnd")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: trimStartIdx },
      { op: "call", funcIdx: trimEndIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_trim",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }
}
