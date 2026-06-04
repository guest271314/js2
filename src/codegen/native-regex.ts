// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — pure-WasmGC standalone regex engine (run-time half).
 *
 * Mirrors `native-strings.ts`: emits a family of hand-authored WasmGC helper
 * functions that operate directly on the `i16` `NativeString` arrays used by
 * the standalone target. No Rust, no linear memory, no `wasm-merge`, no host
 * import — the matcher reads the same `i16` arrays everything else uses.
 *
 * The compile-time half (`regex/{parse,compile}.ts`) turns a static pattern
 * into a flat `i32` bytecode program; this module emits the single generic
 * backtracking VM (`__regex_run`) that interprets it. The reference VM in
 * `regex/vm.ts` is the executable spec this Wasm function mirrors
 * opcode-for-opcode. See the issue file's "Implementation Notes (sd-1539)" for
 * the why-bytecode-not-specialised-emission rationale.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";
import { ReOp } from "./regex/bytecode.js";

/** The frame struct holds one backtrack alternative, exactly like vm.ts. */
const RE_FRAME_STRUCT = "__ReFrame";
const RE_FRAME_ARR = "__ReFrameArr";

/** i32 array type used for program, class table, and capture slots. */
export function regexI32ArrayType(ctx: CodegenContext): number {
  return getOrRegisterArrayType(ctx, "i32", { kind: "i32" });
}

/**
 * Ensure the `$__ReFrame { pc, sp, caps }` struct and its array type exist.
 * Returns `[frameTypeIdx, frameArrTypeIdx]`.
 */
function ensureFrameTypes(ctx: CodegenContext): [number, number] {
  const i32ArrIdx = regexI32ArrayType(ctx);
  let frameIdx = ctx.structMap.get(RE_FRAME_STRUCT);
  if (frameIdx === undefined) {
    frameIdx = ctx.mod.types.length;
    const fields = [
      { name: "pc", type: { kind: "i32" } as ValType, mutable: true },
      { name: "sp", type: { kind: "i32" } as ValType, mutable: true },
      { name: "caps", type: { kind: "ref", typeIdx: i32ArrIdx } as ValType, mutable: true },
    ];
    ctx.mod.types.push({ kind: "struct", name: RE_FRAME_STRUCT, fields });
    ctx.structMap.set(RE_FRAME_STRUCT, frameIdx);
    ctx.typeIdxToStructName.set(frameIdx, RE_FRAME_STRUCT);
    ctx.structFields.set(RE_FRAME_STRUCT, fields);
  }
  let frameArrIdx = ctx.arrayTypeMap.get(RE_FRAME_ARR);
  if (frameArrIdx === undefined) {
    frameArrIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "array",
      name: RE_FRAME_ARR,
      element: { kind: "ref_null", typeIdx: frameIdx },
      mutable: true,
    });
    ctx.arrayTypeMap.set(RE_FRAME_ARR, frameArrIdx);
  }
  return [frameIdx, frameArrIdx];
}

/** Step cap mirrors `REGEX_STEP_CAP` in regex/vm.ts. */
const REGEX_STEP_CAP = 1_000_000;
/** Initial backtrack-stack capacity (frames). Grows on demand. */
const INITIAL_STACK_CAP = 64;

/**
 * Emit `__regex_class_match(classTable, offset, c, negated) -> i32`.
 *
 * Walks the run-length range table for one class and returns 1/0. Mirrors
 * `classMatch` in vm.ts.
 */
function emitClassMatch(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_class_match");
  if (existing !== undefined) return existing;
  const i32Arr = regexI32ArrayType(ctx);
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const typeIdx = addFuncType(ctx, [i32ArrRef, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_class_match", funcIdx);

  // params: table(0), offset(1), c(2), negated(3)
  // locals: rangeCount(4), p(5), i(6), inside(7), lo(8), hi(9)
  const TABLE = 0,
    OFFSET = 1,
    C = 2,
    NEG = 3;
  const RANGE_COUNT = 4,
    P = 5,
    I = 6,
    INSIDE = 7,
    LO = 8,
    HI = 9;
  const body: Instr[] = [
    // rangeCount = table[offset]
    { op: "local.get", index: TABLE },
    { op: "local.get", index: OFFSET },
    { op: "array.get", typeIdx: i32Arr },
    { op: "local.set", index: RANGE_COUNT },
    // p = offset + 1
    { op: "local.get", index: OFFSET },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: P },
    // inside = 0; i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: INSIDE },
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
            // if i >= rangeCount: break
            { op: "local.get", index: I },
            { op: "local.get", index: RANGE_COUNT },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // lo = table[p]; hi = table[p+1]
            { op: "local.get", index: TABLE },
            { op: "local.get", index: P },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: LO },
            { op: "local.get", index: TABLE },
            { op: "local.get", index: P },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: HI },
            // if c >= lo && c <= hi: inside=1; break
            { op: "local.get", index: C },
            { op: "local.get", index: LO },
            { op: "i32.ge_s" },
            { op: "local.get", index: C },
            { op: "local.get", index: HI },
            { op: "i32.le_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "i32.const", value: 1 },
                { op: "local.set", index: INSIDE },
                { op: "br", depth: 2 },
              ],
            },
            // p += 2; i++
            { op: "local.get", index: P },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.set", index: P },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // result = negated ? !inside : inside
    { op: "local.get", index: NEG },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: INSIDE }, { op: "i32.eqz" }],
      else: [{ op: "local.get", index: INSIDE }],
    },
  ];

  ctx.mod.functions.push({
    name: "__regex_class_match",
    typeIdx,
    locals: [
      { name: "rangeCount", type: { kind: "i32" } },
      { name: "p", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "inside", type: { kind: "i32" } },
      { name: "lo", type: { kind: "i32" } },
      { name: "hi", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Emit the backtracking VM `__regex_run` and its dependencies. Returns the
 * `__regex_run` function index.
 *
 * Signature:
 *   __regex_run(prog: ref array<i32>, classTable: ref array<i32>,
 *               nSlots: i32, strData: ref array<i16>, strOff: i32, strLen: i32,
 *               startIdx: i32, caps: ref array<i32>) -> i32
 *
 * `caps` is caller-allocated, length `nSlots`, pre-filled with -1. On a match
 * (1 returned) the slots hold `[g0s,g0e,g1s,g1e,…]`; -1 = unset. This is one
 * anchored attempt at `startIdx`; the start-position scan lives in the
 * higher-level helpers (`__regex_search`).
 */
export function ensureRegexRun(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_run");
  if (existing !== undefined) return existing;

  const classMatchIdx = emitClassMatch(ctx);
  const [frameIdx, frameArrIdx] = ensureFrameTypes(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx; // array i16
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataIdx };
  const frameArrRef: ValType = { kind: "ref", typeIdx: frameArrIdx };

  const typeIdx = addFuncType(
    ctx,
    [
      i32ArrRef, // prog
      i32ArrRef, // classTable
      { kind: "i32" }, // nSlots
      strDataRef, // strData
      { kind: "i32" }, // strOff
      { kind: "i32" }, // strLen
      { kind: "i32" }, // startIdx
      i32ArrRef, // caps
    ],
    [{ kind: "i32" }],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_run", funcIdx);

  // params
  const PROG = 0,
    CTAB = 1,
    NSLOTS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    START = 6,
    CAPS = 7;
  // locals
  const PC = 8; // i32 program counter (instruction index)
  const SP = 9; // i32 string position
  const STEPS = 10; // i32 step counter
  const STACK = 11; // ref $__ReFrameArr — backtrack stack
  const TOP = 12; // i32 stack top (count of live frames)
  const CAP_USED = 13; // i32 stack capacity
  const OP = 14; // i32 current opcode
  const A = 15; // i32 operand a
  const B = 16; // i32 operand b
  const FAILED = 17; // i32 fail flag
  const CH = 18; // i32 current code unit
  const FRAME = 19; // ref null $__ReFrame — popped/pushed frame
  const SNAP = 20; // ref array<i32> — caps snapshot
  const TMPI = 21; // i32 scratch
  const NEWSTACK = 22; // ref $__ReFrameArr — grown stack

  // Helper: read prog[pc*3 + k]
  const readProg = (k: number): Instr[] => [
    { op: "local.get", index: PROG },
    { op: "local.get", index: PC },
    { op: "i32.const", value: 3 },
    { op: "i32.mul" },
    ...(k === 0 ? [] : [{ op: "i32.const", value: k } as Instr, { op: "i32.add" } as Instr]),
    { op: "array.get", typeIdx: i32Arr },
  ];

  // Helper: copy caps -> a fresh array<i32> of length NSLOTS (snapshot).
  const snapshotCaps = (intoLocal: number): Instr[] => [
    // SNAP = array.new_default(NSLOTS)
    { op: "local.get", index: NSLOTS },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: intoLocal },
    // array.copy(dst=SNAP, dstIdx=0, src=CAPS, srcIdx=0, len=NSLOTS)
    { op: "local.get", index: intoLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: CAPS },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: NSLOTS },
    { op: "array.copy", dstTypeIdx: i32Arr, srcTypeIdx: i32Arr },
  ];

  // Helper: restore CAPS <- snapshot SNAP (copy back).
  const restoreCaps = (fromLocal: number): Instr[] => [
    { op: "local.get", index: CAPS },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: fromLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: NSLOTS },
    { op: "array.copy", dstTypeIdx: i32Arr, srcTypeIdx: i32Arr },
  ];

  // The dispatch switch over OP. We emit an if/else chain (op === k) … .
  // Each arm sets PC/SP/CAPS or FAILED. MATCH returns 1 directly.
  const dispatch: Instr[] = [
    // CHAR / CHARI: compare a code unit.
    // ch = (sp < slen) ? strData[soff+sp] : -1
    { op: "local.get", index: SP },
    { op: "local.get", index: SLEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: SDATA },
        { op: "local.get", index: SOFF },
        { op: "local.get", index: SP },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataIdx },
      ],
      else: [{ op: "i32.const", value: -1 }],
    },
    { op: "local.set", index: CH },

    // if op == CHAR
    { op: "local.get", index: OP },
    { op: "i32.const", value: ReOp.CHAR },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // matched = sp<slen && ch==a
        { op: "local.get", index: SP },
        { op: "local.get", index: SLEN },
        { op: "i32.lt_s" },
        { op: "local.get", index: CH },
        { op: "local.get", index: A },
        { op: "i32.eq" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: SP },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: SP },
            { op: "local.get", index: PC },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: PC },
          ],
          else: [
            { op: "i32.const", value: 1 },
            { op: "local.set", index: FAILED },
          ],
        },
      ],
      else: [
        // if op == CHARI
        { op: "local.get", index: OP },
        { op: "i32.const", value: ReOp.CHARI },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // fold ch (A-Z -> a-z) then compare to a
            { op: "local.get", index: SP },
            { op: "local.get", index: SLEN },
            { op: "i32.lt_s" },
            { op: "local.get", index: CH },
            ...foldCh(),
            { op: "local.get", index: A },
            { op: "i32.eq" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: SP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: SP },
                { op: "local.get", index: PC },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: PC },
              ],
              else: [
                { op: "i32.const", value: 1 },
                { op: "local.set", index: FAILED },
              ],
            },
          ],
          else: dispatchTail(),
        },
      ],
    },
  ];

  // ANY/CLASS/SPLIT/JMP/SAVE/BOL/EOL/MATCH chain — split out so the CHAR/CHARI
  // arm above stays readable. Uses the same locals.
  function foldCh(): Instr[] {
    // stack: ch ; produce fold(ch)
    // fold = (ch>=0x41 && ch<=0x5a) ? ch+0x20 : ch
    return [
      { op: "local.set", index: TMPI },
      { op: "local.get", index: TMPI },
      { op: "i32.const", value: 0x41 },
      { op: "i32.ge_s" },
      { op: "local.get", index: TMPI },
      { op: "i32.const", value: 0x5a },
      { op: "i32.le_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "local.get", index: TMPI }, { op: "i32.const", value: 0x20 }, { op: "i32.add" }],
        else: [{ op: "local.get", index: TMPI }],
      },
    ];
  }

  function dispatchTail(): Instr[] {
    return [
      // ANY: a = dotAll flag
      { op: "local.get", index: OP },
      { op: "i32.const", value: ReOp.ANY },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: anyArm(),
        else: [
          { op: "local.get", index: OP },
          { op: "i32.const", value: ReOp.CLASS },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: classArm(),
            else: [
              { op: "local.get", index: OP },
              { op: "i32.const", value: ReOp.SPLIT },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: splitArm(),
                else: [
                  { op: "local.get", index: OP },
                  { op: "i32.const", value: ReOp.JMP },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: A },
                      { op: "local.set", index: PC },
                    ],
                    else: [
                      { op: "local.get", index: OP },
                      { op: "i32.const", value: ReOp.SAVE },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: saveArm(),
                        else: [
                          { op: "local.get", index: OP },
                          { op: "i32.const", value: ReOp.BOL },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: anchorArm(/*eol*/ false),
                            else: [
                              { op: "local.get", index: OP },
                              { op: "i32.const", value: ReOp.EOL },
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "empty" },
                                then: anchorArm(/*eol*/ true),
                                // op == MATCH (the only remaining op): return 1
                                else: [{ op: "i32.const", value: 1 }, { op: "return" }],
                              },
                            ],
                          },
                        ],
                      },
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

  function anyArm(): Instr[] {
    // matched = sp<slen && (a!=0 || !isLineTerminator(ch))
    return [
      { op: "local.get", index: SP },
      { op: "local.get", index: SLEN },
      { op: "i32.lt_s" },
      // (a != 0) | (!isLineTerm(ch))
      { op: "local.get", index: A },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      ...isLineTerm(CH),
      { op: "i32.eqz" },
      { op: "i32.or" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: advance1(),
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: FAILED },
        ],
      },
    ];
  }

  function classArm(): Instr[] {
    // matched = sp<slen && class_match(ctab, a, ch, b)
    return [
      { op: "local.get", index: SP },
      { op: "local.get", index: SLEN },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: CTAB },
          { op: "local.get", index: A },
          { op: "local.get", index: CH },
          { op: "local.get", index: B },
          { op: "call", funcIdx: classMatchIdx },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: advance1(),
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: FAILED },
        ],
      },
    ];
  }

  function advance1(): Instr[] {
    return [
      { op: "local.get", index: SP },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: SP },
      { op: "local.get", index: PC },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: PC },
    ];
  }

  function isLineTerm(local: number): Instr[] {
    // ch==0x0a | ch==0x0d | ch==0x2028 | ch==0x2029
    return [
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x0a },
      { op: "i32.eq" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x0d },
      { op: "i32.eq" },
      { op: "i32.or" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x2028 },
      { op: "i32.eq" },
      { op: "i32.or" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x2029 },
      { op: "i32.eq" },
      { op: "i32.or" },
    ];
  }

  function splitArm(): Instr[] {
    // push frame {pc:b, sp, caps:snapshot}; pc = a
    return [
      ...growStackIfFull(),
      ...snapshotCaps(SNAP),
      // FRAME = struct.new $__ReFrame(b, sp, SNAP)
      { op: "local.get", index: B },
      { op: "local.get", index: SP },
      { op: "local.get", index: SNAP },
      { op: "struct.new", typeIdx: frameIdx },
      { op: "local.set", index: FRAME },
      // STACK[TOP] = FRAME
      { op: "local.get", index: STACK },
      { op: "local.get", index: TOP },
      { op: "local.get", index: FRAME },
      { op: "array.set", typeIdx: frameArrIdx },
      // TOP++
      { op: "local.get", index: TOP },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: TOP },
      // pc = a
      { op: "local.get", index: A },
      { op: "local.set", index: PC },
    ];
  }

  function saveArm(): Instr[] {
    // caps[a] = sp; pc++
    return [
      { op: "local.get", index: CAPS },
      { op: "local.get", index: A },
      { op: "local.get", index: SP },
      { op: "array.set", typeIdx: i32Arr },
      { op: "local.get", index: PC },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: PC },
    ];
  }

  function anchorArm(eol: boolean): Instr[] {
    // Non-multiline: BOL matches sp==0, EOL matches sp==slen.
    // Multiline (operand a != 0): BOL also matches right after a line
    // terminator (the unit at sp-1 is a LT), EOL also matches right before a
    // line terminator (the unit at sp is a LT). The neighbour read is guarded
    // by an in-bounds check so it can never trap. `\r\n` is two terminators, so
    // an anchor between them still matches. Mirrors anchorArm in regex/vm.ts.
    //
    // matched = baseEq || (a != 0 && multilineEq)
    return [
      // baseEq: sp == (eol ? slen : 0)
      { op: "local.get", index: SP },
      eol ? ({ op: "local.get", index: SLEN } as Instr) : ({ op: "i32.const", value: 0 } as Instr),
      { op: "i32.eq" },
      // | (a != 0 && multilineEq)
      { op: "local.get", index: A },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      ...multilineAnchorMatch(eol),
      { op: "i32.and" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: PC },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: PC },
        ],
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: FAILED },
        ],
      },
    ];
  }

  /** Push i32 1/0: is the line-boundary neighbour a line terminator? For EOL
   *  the neighbour is the unit at sp (needs sp<slen); for BOL it is the unit at
   *  sp-1 (needs sp>0). Reads are guarded so they never trap out of bounds. */
  function multilineAnchorMatch(eol: boolean): Instr[] {
    return [
      // inBounds = eol ? (sp < slen) : (sp > 0)
      { op: "local.get", index: SP },
      eol ? ({ op: "local.get", index: SLEN } as Instr) : ({ op: "i32.const", value: 0 } as Instr),
      eol ? ({ op: "i32.lt_s" } as Instr) : ({ op: "i32.gt_s" } as Instr),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // ch = strData[soff + (eol ? sp : sp-1)]
          { op: "local.get", index: SDATA },
          { op: "local.get", index: SOFF },
          { op: "local.get", index: SP },
          { op: "i32.add" },
          ...(eol ? [] : [{ op: "i32.const", value: 1 } as Instr, { op: "i32.sub" } as Instr]),
          { op: "array.get_u", typeIdx: strDataIdx },
          { op: "local.set", index: CH },
          ...isLineTerm(CH),
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
  }

  // Grow STACK if TOP == CAP_USED: double capacity, array.copy old -> new.
  function growStackIfFull(): Instr[] {
    return [
      { op: "local.get", index: TOP },
      { op: "local.get", index: CAP_USED },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // newCap = CAP_USED * 2
          { op: "local.get", index: CAP_USED },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "local.set", index: CAP_USED },
          // NEWSTACK = array.new_default(newCap)
          { op: "local.get", index: CAP_USED },
          { op: "array.new_default", typeIdx: frameArrIdx },
          { op: "local.set", index: NEWSTACK },
          // copy old (TOP frames) into new
          { op: "local.get", index: NEWSTACK },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: STACK },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: TOP },
          { op: "array.copy", dstTypeIdx: frameArrIdx, srcTypeIdx: frameArrIdx },
          { op: "local.get", index: NEWSTACK },
          { op: "local.set", index: STACK },
        ],
      },
    ];
  }

  const body: Instr[] = [
    // pc = 0; sp = start; steps = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: PC },
    { op: "local.get", index: START },
    { op: "local.set", index: SP },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: STEPS },
    // stack = array.new_default(INITIAL_STACK_CAP); top=0; capUsed=INITIAL
    { op: "i32.const", value: INITIAL_STACK_CAP },
    { op: "array.new_default", typeIdx: frameArrIdx },
    { op: "local.set", index: STACK },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: TOP },
    { op: "i32.const", value: INITIAL_STACK_CAP },
    { op: "local.set", index: CAP_USED },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        // steps++; if steps > CAP return 0
        { op: "local.get", index: STEPS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.tee", index: STEPS },
        { op: "i32.const", value: REGEX_STEP_CAP },
        { op: "i32.gt_s" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        // failed = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: FAILED },
        // op = prog[pc*3]; a = prog[pc*3+1]; b = prog[pc*3+2]
        ...readProg(0),
        { op: "local.set", index: OP },
        ...readProg(1),
        { op: "local.set", index: A },
        ...readProg(2),
        { op: "local.set", index: B },
        // dispatch (sets PC/SP/CAPS/FAILED or returns 1 on MATCH)
        ...dispatch,
        // if failed: pop a frame or return 0
        { op: "local.get", index: FAILED },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // if top == 0 return 0
            { op: "local.get", index: TOP },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
            // top--; frame = stack[top]
            { op: "local.get", index: TOP },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.tee", index: TOP },
            { op: "local.set", index: TMPI },
            { op: "local.get", index: STACK },
            { op: "local.get", index: TMPI },
            { op: "array.get", typeIdx: frameArrIdx },
            { op: "ref.as_non_null" },
            { op: "local.set", index: FRAME },
            // pc = frame.pc; sp = frame.sp; restore caps from frame.caps
            { op: "local.get", index: FRAME },
            { op: "struct.get", typeIdx: frameIdx, fieldIdx: 0 },
            { op: "local.set", index: PC },
            { op: "local.get", index: FRAME },
            { op: "struct.get", typeIdx: frameIdx, fieldIdx: 1 },
            { op: "local.set", index: SP },
            { op: "local.get", index: FRAME },
            { op: "struct.get", typeIdx: frameIdx, fieldIdx: 2 },
            { op: "local.set", index: SNAP },
            ...restoreCaps(SNAP),
          ],
        },
        // continue loop
        { op: "br", depth: 0 },
      ],
    },
    // unreachable fallthrough — VM always returns inside the loop. Emit 0.
    { op: "i32.const", value: 0 },
  ];

  const fn: WasmFunction = {
    name: "__regex_run",
    typeIdx,
    locals: [
      { name: "pc", type: { kind: "i32" } },
      { name: "sp", type: { kind: "i32" } },
      { name: "steps", type: { kind: "i32" } },
      { name: "stack", type: frameArrRef },
      { name: "top", type: { kind: "i32" } },
      { name: "capUsed", type: { kind: "i32" } },
      { name: "op", type: { kind: "i32" } },
      { name: "a", type: { kind: "i32" } },
      { name: "b", type: { kind: "i32" } },
      { name: "failed", type: { kind: "i32" } },
      { name: "ch", type: { kind: "i32" } },
      { name: "frame", type: { kind: "ref_null", typeIdx: frameIdx } },
      { name: "snap", type: i32ArrRef },
      { name: "tmpi", type: { kind: "i32" } },
      { name: "newstack", type: frameArrRef },
    ],
    body,
    exported: false,
  };
  ctx.mod.functions.push(fn);
  return funcIdx;
}

/**
 * Emit `__regex_search(prog, classTable, nSlots, strData, strOff, strLen,
 * startIdx, sticky, caps) -> i32`.
 *
 * Drives the start-position scan: tries `__regex_run` at each position from
 * `startIdx` to `strLen`; returns 1 with `caps` filled on the first match, 0
 * otherwise. When `sticky` is non-zero (the `y` flag) only `startIdx` is tried.
 * Mirrors `search` in regex/vm.ts. `caps` must be re-initialised to -1 before
 * each attempt — done inside the loop via `array.fill`.
 */
export function ensureRegexSearch(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_search");
  if (existing !== undefined) return existing;
  const runIdx = ensureRegexRun(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx;
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataIdx };

  const typeIdx = addFuncType(
    ctx,
    [
      i32ArrRef, // prog
      i32ArrRef, // classTable
      { kind: "i32" }, // nSlots
      strDataRef, // strData
      { kind: "i32" }, // strOff
      { kind: "i32" }, // strLen
      { kind: "i32" }, // startIdx
      { kind: "i32" }, // sticky
      i32ArrRef, // caps
    ],
    [{ kind: "i32" }],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_search", funcIdx);

  const PROG = 0,
    CTAB = 1,
    NSLOTS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    START = 6,
    STICKY = 7,
    CAPS = 8;
  const I = 9; // current start position

  const body: Instr[] = [
    // i = max(0, start)
    { op: "local.get", index: START },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: START },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "select" }, // start < 0 ? 0 : start
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i > slen: break (no match)
            { op: "local.get", index: I },
            { op: "local.get", index: SLEN },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // re-init caps to -1
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "i32.const", value: -1 },
            { op: "local.get", index: NSLOTS },
            { op: "array.fill", typeIdx: i32Arr },
            // if __regex_run(...) at i: return 1
            { op: "local.get", index: PROG },
            { op: "local.get", index: CTAB },
            { op: "local.get", index: NSLOTS },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: SLEN },
            { op: "local.get", index: I },
            { op: "local.get", index: CAPS },
            { op: "call", funcIdx: runIdx },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
            // if sticky: break (only the start position is tried)
            { op: "local.get", index: STICKY },
            { op: "br_if", depth: 1 },
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
    { op: "i32.const", value: 0 },
  ];

  ctx.mod.functions.push({
    name: "__regex_search",
    typeIdx,
    locals: [{ name: "i", type: { kind: "i32" } }],
    body,
    exported: false,
  });
  return funcIdx;
}

/** Build inline instructions that materialize a `number[]` as a fixed
 *  `array i32` on the stack (used for prog + classTable literals). */
export function i32ArrayLiteralInstrs(ctx: CodegenContext, values: number[]): Instr[] {
  const i32Arr = regexI32ArrayType(ctx);
  const instrs: Instr[] = [];
  for (const v of values) instrs.push({ op: "i32.const", value: v | 0 });
  // array.new_fixed requires at least the length operand; empty arrays use
  // array.new_default(0).
  if (values.length === 0) {
    return [
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: i32Arr },
    ];
  }
  instrs.push({ op: "array.new_fixed", typeIdx: i32Arr, length: values.length });
  return instrs;
}
