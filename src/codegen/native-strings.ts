// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helpers — $AnyString, $FlatString, $ConsString types
 * and ensureNativeStringHelpers which emits the full string runtime.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { ensureAnyValueType } from "./any-helpers.js";
import { emitNativeHtmlWrapperHelpers } from "./html-wrapper-native.js";
import { emitStrSearchHelpers, emitStrTrimHelpers } from "./native-strings-search.js";
import { emitStrPadRepeatHelpers, emitStrCaseHelpers } from "./native-strings-transform.js";
import {
  emitStrReplaceHelpers,
  emitStrSplitHelper,
  emitStrConstructHelpers,
  emitStrRegexEscapeHelper,
} from "./native-strings-rewrite.js";
import { makeNativeStrShared } from "./native-strings-shared.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { addImport } from "./registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterErrorStructType,
  getOrRegisterVecType,
} from "./registry/types.js";

export function nativeStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * #1588 PR-B part 2: the cons-string flatten body — `__str_flatten`'s `else`
 * arm for a non-flat, non-Utf8String input (i.e. a ConsString rope). Extracted
 * so the Utf8String dispatch arm can wrap it. Operates on locals: s(0), len(1),
 * buf(2). Returns the rope flattened to a `NativeString`.
 */
function flattenConsBody(
  strDataTypeIdx: number,
  strTypeIdx: number,
  anyStrTypeIdx: number,
  copyTreeIdx: number,
): Instr[] {
  return [
    // len = s.len (field 0 of AnyString)
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 1 },
    // buf = array.new_default(len)
    { op: "local.get", index: 1 },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: 2 },
    // copy_tree(s, buf, 0)
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: copyTreeIdx },
    { op: "drop" },
    // return struct.new $NativeString(len, 0, buf)
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 2 },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];
}

/**
 * Build the inline instruction sequence that materializes a string literal as
 * a NativeString (FlatString) struct ref. Mirrors `compileNativeStringLiteral`
 * but returns an `Instr[]` for callers that build instruction streams without
 * a `FunctionContext` (e.g. throw-instr builders that return `Instr[]`).
 */
export function nativeStringLiteralInstrs(ctx: CodegenContext, value: string, encoding?: StringEncoding): Instr[] {
  // #1588 PR-B: when `--utf8-storage` is on and the literal is proven
  // `ascii`/`utf8-guaranteed`, materialize an i8-backed `Utf8String` instead
  // of the i16 `NativeString`. When off (or the literal is `wtf16`/unknown),
  // this is byte-identical to before.
  if (ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && (encoding === "ascii" || encoding === "utf8-guaranteed")) {
    return utf8StringLiteralInstrs(ctx, value);
  }

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const instrs: Instr[] = [];
  // len (i32), off (i32) = 0
  instrs.push({ op: "i32.const", value: value.length });
  instrs.push({ op: "i32.const", value: 0 });
  // code units, then array.new_fixed
  for (let i = 0; i < value.length; i++) {
    instrs.push({ op: "i32.const", value: value.charCodeAt(i) });
  }
  instrs.push({
    op: "array.new_fixed",
    typeIdx: strDataTypeIdx,
    length: value.length,
  });
  // struct.new $NativeString(len, off, data)
  instrs.push({ op: "struct.new", typeIdx: strTypeIdx });
  return instrs;
}

/** #1588 PR-B: encoding annotation values the lowering sites consume. Mirrors
 *  `Encoding` in `src/ir/analysis/encoding.ts` (kept as a local string-union to
 *  avoid a codegen→ir import cycle). */
export type StringEncoding = "ascii" | "utf8-guaranteed" | "wtf16";

/**
 * #1588 PR-B: materialize a string literal as an i8-backed `Utf8String`.
 * Precondition (asserted): `value` contains no lone surrogate — guaranteed by
 * the encoding classifier (a lone surrogate is always `wtf16`, never reaches
 * here). The assert is a defensive guard against a future classifier bug
 * emitting malformed UTF-8 bytes.
 */
function utf8StringLiteralInstrs(ctx: CodegenContext, value: string): Instr[] {
  const bytes = utf8Encode(value);
  const instrs: Instr[] = [];
  // len = code-unit (UTF-16) length, byteLen = UTF-8 byte length, off = 0.
  instrs.push({ op: "i32.const", value: value.length });
  instrs.push({ op: "i32.const", value: bytes.length });
  instrs.push({ op: "i32.const", value: 0 });
  for (const b of bytes) {
    instrs.push({ op: "i32.const", value: b });
  }
  instrs.push({
    op: "array.new_fixed",
    typeIdx: ctx.utf8StrDataTypeIdx,
    length: bytes.length,
  });
  // struct.new $Utf8String(len, byteLen, off, data)
  instrs.push({ op: "struct.new", typeIdx: ctx.utf8StrTypeIdx });
  return instrs;
}

/**
 * Encode a JS (WTF-16) string to UTF-8 bytes. Asserts no lone surrogate — the
 * caller only invokes this for `ascii`/`utf8-guaranteed` strings, which the
 * classifier guarantees are well-formed. Uses code points (handles
 * well-formed surrogate pairs for astral scalars).
 */
function utf8Encode(value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let cp = value.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else {
        throw new Error(
          `#1588 utf8Encode: lone high surrogate in a string annotated utf8-guaranteed/ascii — classifier bug`,
        );
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new Error(
        `#1588 utf8Encode: lone low surrogate in a string annotated utf8-guaranteed/ascii — classifier bug`,
      );
    }
    if (cp <= 0x7f) {
      out.push(cp);
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

/**
 * Build inline instructions that push a string constant onto the stack as an
 * externref (the type expected by the throw tag and by host imports). In
 * nativeStrings mode, materializes the FlatString struct inline and converts
 * to externref. In legacy mode, emits a plain `global.get` of the
 * `string_constants` import. Both branches require the value to be present
 * in `ctx.stringGlobalMap` — call `addStringConstantGlobal(ctx, value)` first.
 */
export function stringConstantExternrefInstrs(ctx: CodegenContext, value: string): Instr[] {
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const instrs = nativeStringLiteralInstrs(ctx, value);
    // ref $NativeString -> externref
    instrs.push({ op: "extern.convert_any" });
    return instrs;
  }
  const strIdx = ctx.stringGlobalMap.get(value);
  if (strIdx === undefined || strIdx < 0) {
    // Defensive: caller forgot to register, or sentinel. Push undefined.
    return [{ op: "ref.null.extern" }];
  }
  return [{ op: "global.get", index: strIdx }];
}

/**
 * Get the nullable ValType for a string reference (ref null $AnyString).
 */
export function nativeStringTypeNullable(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Get the ValType for a flat string reference (ref $NativeString).
 */
export function flatStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
}

/**
 * Emit native string helper functions into the module.
 * Called lazily when string operations are first encountered in fast mode.
 *
 * IMPORTANT: All imports must be registered BEFORE any module functions,
 * because wasm function indices are: imports first, then module functions.
 */
export function ensureNativeStringHelpers(ctx: CodegenContext): void {
  if (ctx.nativeStrHelpersEmitted) return;
  ctx.nativeStrHelpersEmitted = true;
  // #2039: settle any deferred ensureLateImport batch before baking funcIdx
  // values. Registering these helpers mid-batch would bake post-batch indices
  // that the deferred flush then over-shifts by its delta. Same guard as
  // ensureObjectRuntime / addUnionImports.
  flushLateImportShifts(ctx, null);
  // #1677: snapshot the import-function count at the instant the helpers are
  // emitted. Imports added later during the same finalize phase shift these
  // helpers' true indices but NOT their baked-in sibling-call targets;
  // `reconcileNativeStrFinalizeShift` applies that delta at finalize end.
  if (ctx.nativeStrHelperImportBase < 0) {
    ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
  }

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx; // NativeString (FlatString) struct type index
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // AnyString base type index
  const consStrTypeIdx = ctx.consStrTypeIdx; // ConsString type index
  // strRef = ref $AnyString — used in all helper function signatures (params and results).
  // All string values in the system can be either FlatString or ConsString.
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx }; // ref $NativeString
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // Helper: get the flatten function index (available after flatten is registered)
  const getFlattenIdx = () => ctx.nativeStrHelpers.get("__str_flatten")!;

  /**
   * Wrap a helper body with flatten preambles for string params.
   * For each string param index in `strParamIndices`, adds:
   *   local.get $param → call $__str_flatten → local.set $param
   * This ensures the param (typed ref $AnyString) actually holds a NativeString.
   * Also inserts ref.cast $NativeString before every struct.get $NativeString
   * to satisfy the wasm type checker.
   */
  function wrapBodyWithFlatten(body: Instr[], strParamIndices: number[]): Instr[] {
    // 1. Build flatten preamble
    const preamble: Instr[] = [];
    for (const idx of strParamIndices) {
      preamble.push(
        { op: "local.get", index: idx },
        { op: "call", funcIdx: getFlattenIdx() },
        // flatten returns ref $NativeString which is subtype of ref $AnyString — can store in param
        { op: "local.set", index: idx },
      );
    }

    // 2. Insert ref.cast before every struct.get $NativeString
    const processed: Instr[] = [];
    for (const instr of body) {
      if (instr.op === "struct.get" && (instr as any).typeIdx === strTypeIdx) {
        processed.push({ op: "ref.cast", typeIdx: strTypeIdx });
      }
      // Recurse into if/block/loop bodies
      if (instr.op === "if") {
        const ifInstr = instr as any;
        const newIf: any = { ...ifInstr };
        if (ifInstr.then) newIf.then = wrapBodyWithFlatten(ifInstr.then, []).slice(0); // no preamble for sub-bodies
        if (ifInstr.else) newIf.else = wrapBodyWithFlatten(ifInstr.else, []).slice(0);
        processed.push(newIf);
        continue;
      }
      if (instr.op === "block" || instr.op === "loop") {
        const blockInstr = instr as any;
        const newBlock: any = { ...blockInstr };
        if (blockInstr.body) newBlock.body = wrapBodyWithFlatten(blockInstr.body, []).slice(0);
        processed.push(newBlock);
        continue;
      }
      processed.push(instr);
    }

    return [...preamble, ...processed];
  }

  // ── Step 2: Now add all module functions ─────────────────────────

  // --- $__str_copy_tree(node: ref $AnyString, buf: ref $__str_data, pos: i32) -> i32 ---
  // Iteratively copies rope tree into a flat buffer. Returns next write position.
  //
  // Previously this used self-recursion to traverse the rope tree, which caused
  // a wasm `call stack exhausted` trap on left-leaning ropes built by `text +=
  // expr` patterns over many thousands of iterations (#1178). The deep
  // left-spine of `Cons(Cons(Cons(..., c2), c1), c0)` made one stack frame per
  // cons node.
  //
  // The iterative version uses an explicit worklist of right-children. We
  // descend the leftmost spine (pushing right-children onto the worklist),
  // copy each flat leaf, then pop and resume from the most recently pushed
  // right-child. Stack usage is now O(1); heap usage is O(node.len) for the
  // worklist (overestimate; depth ≤ leaves ≤ len since each leaf has ≥ 1 char).
  {
    // Register the worklist's array type: (array (mut (ref null $AnyString))).
    // Reuses the same registration as `__str_split` (keyed by `ref_<anyStr>`).
    const wlElemKey = `ref_${anyStrTypeIdx}`;
    const wlElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const wlArrTypeIdx = getOrRegisterArrayType(ctx, wlElemKey, wlElemType);
    const wlArrRefNull: ValType = { kind: "ref_null", typeIdx: wlArrTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strDataRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_copy_tree", funcIdx);

    // params: node(0), buf(1), pos(2)
    // locals:
    //   flat(3): ref_null $NativeString — current flat node being copied
    //   flatOff(4): i32
    //   flatLen(5): i32
    //   cur(6): ref_null $AnyString — current node in the descent
    //   worklist(7): ref_null $AnyString_arr — pending right-children
    //   wlTop(8): i32 — number of items currently on the worklist
    //   newWl(9): ref_null $AnyString_arr — scratch slot for grow-on-push reallocation (#1184)
    const FLAT = 3;
    const FLAT_OFF = 4;
    const FLAT_LEN = 5;
    const CUR = 6;
    const WL = 7;
    const WL_TOP = 8;
    const NEW_WL = 9;

    const body: Instr[] = [
      // Fast path: if node is already a FlatString, copy directly and return.
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
          { op: "local.set", index: FLAT },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.set", index: FLAT_OFF },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
          { op: "local.set", index: FLAT_LEN },

          // array.copy(buf, pos, flat.data, flatOff, flatLen)
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: FLAT_OFF },
          { op: "local.get", index: FLAT_LEN },
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // return pos + flatLen
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT_LEN },
          { op: "i32.add" },
          { op: "return" },
        ],
      },

      // Slow path: rope traversal with an explicit worklist of right-children.
      //
      // #1184: pre-#1184, this allocated a worklist sized at `node.len` (a generous
      // upper bound on rope depth — depth ≤ leaves ≤ chars). For balanced ropes
      // (depth ~log N) on a long string, that's a huge over-allocation: a 1MB
      // ConsString with a balanced rope has depth ~20 but allocates 1M ref slots
      // (≈8MB on 64-bit WasmGC). Each `String.prototype.charAt` / `charCodeAt` /
      // `substring` etc. on a ConsString triggers a fresh flatten → copy_tree →
      // huge allocation, producing severe GC pressure on string-heavy workloads.
      //
      // Strategy: dynamic growth. Start with a small fixed initial capacity (16
      // slots — enough for any rope of depth ≤ 16, which covers virtually all
      // balanced ropes up to ~1MB). When the worklist would overflow on push,
      // double its capacity via array.copy. Final capacity is at most the rope
      // depth; geometric reallocation gives O(depth) total allocation.
      //
      // Worst-case (left-leaning rope of depth N): log2(N/16) reallocations,
      // total slots allocated = 2N (geometric series). Same order as the
      // pre-#1184 N-slot single-allocation, but spread across log N small
      // allocations. The common case (depth ≤ 16) does ONE 16-slot allocation
      // — orders of magnitude smaller than `node.len`.
      //
      // worklist = array.new_default<ref_null $AnyString>(16)
      { op: "i32.const", value: 16 },
      { op: "array.new_default", typeIdx: wlArrTypeIdx },
      { op: "local.set", index: WL },

      // wlTop = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: WL_TOP },

      // cur = node
      { op: "local.get", index: 0 },
      { op: "local.set", index: CUR },

      // Outer loop: descend left, copy a flat segment, pop next right-child.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // Inner loop: walk left while cur is a ConsString, pushing
              // right-children onto the worklist. Exits when cur is FlatString.
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if cur is FlatString: br to end of inner block (depth 1)
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.test", typeIdx: strTypeIdx },
                      { op: "br_if", depth: 1 },

                      // #1184: grow worklist if full (wlTop >= worklist.len).
                      // Doubling-grow: array.new_default(len * 2), array.copy old → new.
                      { op: "local.get", index: WL_TOP },
                      { op: "local.get", index: WL },
                      { op: "ref.as_non_null" },
                      { op: "array.len" },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          // newWl = array.new_default(worklist.len << 1)
                          { op: "local.get", index: WL },
                          { op: "ref.as_non_null" },
                          { op: "array.len" },
                          { op: "i32.const", value: 1 },
                          { op: "i32.shl" },
                          {
                            op: "array.new_default",
                            typeIdx: wlArrTypeIdx,
                          },
                          { op: "local.set", index: NEW_WL },

                          // array.copy(newWl, 0, worklist, 0, wlTop)
                          { op: "local.get", index: NEW_WL },
                          { op: "ref.as_non_null" },
                          { op: "i32.const", value: 0 },
                          { op: "local.get", index: WL },
                          { op: "ref.as_non_null" },
                          { op: "i32.const", value: 0 },
                          { op: "local.get", index: WL_TOP },
                          {
                            op: "array.copy",
                            dstTypeIdx: wlArrTypeIdx,
                            srcTypeIdx: wlArrTypeIdx,
                          },

                          // worklist = newWl
                          { op: "local.get", index: NEW_WL },
                          { op: "local.set", index: WL },
                        ],
                      },

                      // worklist[wlTop] = (cur as ConsString).right
                      { op: "local.get", index: WL },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: WL_TOP },
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      {
                        op: "struct.get",
                        typeIdx: consStrTypeIdx,
                        fieldIdx: 2,
                      },
                      { op: "array.set", typeIdx: wlArrTypeIdx },

                      // wlTop++
                      { op: "local.get", index: WL_TOP },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: WL_TOP },

                      // cur = (cur as ConsString).left
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      {
                        op: "struct.get",
                        typeIdx: consStrTypeIdx,
                        fieldIdx: 1,
                      },
                      { op: "local.set", index: CUR },

                      // continue inner loop
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },

              // cur is a FlatString — copy its contents into buf at pos.
              { op: "local.get", index: CUR },
              { op: "ref.as_non_null" },
              { op: "ref.cast", typeIdx: strTypeIdx },
              { op: "local.set", index: FLAT },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
              { op: "local.set", index: FLAT_OFF },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
              { op: "local.set", index: FLAT_LEN },

              // array.copy(buf, pos, flat.data, flatOff, flatLen)
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
              { op: "local.get", index: FLAT_OFF },
              { op: "local.get", index: FLAT_LEN },
              {
                op: "array.copy",
                dstTypeIdx: strDataTypeIdx,
                srcTypeIdx: strDataTypeIdx,
              },

              // pos += flatLen
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT_LEN },
              { op: "i32.add" },
              { op: "local.set", index: 2 },

              // if wlTop == 0: br to end of outer block (depth 1) — done
              { op: "local.get", index: WL_TOP },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },

              // wlTop--
              { op: "local.get", index: WL_TOP },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: WL_TOP },

              // cur = worklist[wlTop]
              { op: "local.get", index: WL },
              { op: "ref.as_non_null" },
              { op: "local.get", index: WL_TOP },
              { op: "array.get", typeIdx: wlArrTypeIdx },
              { op: "local.set", index: CUR },

              // continue outer loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return pos
      { op: "local.get", index: 2 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_copy_tree",
      typeIdx,
      locals: [
        { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatOff", type: { kind: "i32" } },
        { name: "flatLen", type: { kind: "i32" } },
        { name: "cur", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "worklist", type: wlArrRefNull },
        { name: "wlTop", type: { kind: "i32" } },
        { name: "newWl", type: wlArrRefNull },
      ],
      body,
      exported: false,
    });
  }

  // #1588 PR-B part 2: $__str_utf8_to_flat(u: ref $Utf8String) -> ref $NativeString
  // Decode the i8 UTF-8 bytes back to i16 WTF-16 code units. Only emitted when
  // --utf8-storage is on (the Utf8String type exists). The output array is
  // pre-sized to `u.len` (the code-unit count stored at allocation time), so no
  // resize is needed. Well-formed UTF-8 is assumed (the encoder only produces it
  // for ascii/utf8-guaranteed strings; lone surrogates never reach i8 storage).
  if (ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0) {
    const u8StrRef: ValType = { kind: "ref", typeIdx: ctx.utf8StrTypeIdx };
    const typeIdx = addFuncType(ctx, [u8StrRef], [flatStrRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_utf8_to_flat", funcIdx);
    // params: u(0)
    // locals: len(1) code-unit count, byteLen(2), data(3) i8 array, out(4) i16 array,
    //         b(5) byte index, o(6) out index, c0(7) lead byte, cp(8) code point
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 0 }, // len
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 1 }, // byteLen
      { op: "local.set", index: 2 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 3 }, // data (ref $__str_data_u8)
      { op: "local.set", index: 3 },
      // out = array.new_default $__str_data(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 }, // b = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 6 }, // o = 0
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if b >= byteLen break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // c0 = data[b] & 0xFF (array.get_u zero-extends an i8 lane)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get_u", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.set", index: 7 },
              // dispatch on c0
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 0x80 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // 1-byte: cp = c0
                  { op: "local.get", index: 7 },
                  { op: "local.set", index: 8 },
                  { op: "local.get", index: 5 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 5 },
                ],
                else: [
                  { op: "local.get", index: 7 },
                  { op: "i32.const", value: 0xe0 },
                  { op: "i32.lt_u" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // 2-byte: cp = ((c0 & 0x1F)<<6) | (data[b+1] & 0x3F)
                      { op: "local.get", index: 7 },
                      { op: "i32.const", value: 0x1f },
                      { op: "i32.and" },
                      { op: "i32.const", value: 6 },
                      { op: "i32.shl" },
                      { op: "local.get", index: 3 },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: ctx.utf8StrDataTypeIdx },
                      { op: "i32.const", value: 0x3f },
                      { op: "i32.and" },
                      { op: "i32.or" },
                      { op: "local.set", index: 8 },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 2 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                    ],
                    else: [
                      { op: "local.get", index: 7 },
                      { op: "i32.const", value: 0xf0 },
                      { op: "i32.lt_u" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          // 3-byte: cp = ((c0&0x0F)<<12)|((b1&0x3F)<<6)|(b2&0x3F)
                          { op: "local.get", index: 7 },
                          { op: "i32.const", value: 0x0f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 12 },
                          { op: "i32.shl" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 6 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 2 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.or" },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 3 },
                          { op: "i32.add" },
                          { op: "local.set", index: 5 },
                        ],
                        else: [
                          // 4-byte: cp = ((c0&0x07)<<18)|((b1&0x3F)<<12)|((b2&0x3F)<<6)|(b3&0x3F)
                          { op: "local.get", index: 7 },
                          { op: "i32.const", value: 0x07 },
                          { op: "i32.and" },
                          { op: "i32.const", value: 18 },
                          { op: "i32.shl" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 12 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 2 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 6 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 3 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.or" },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 4 },
                          { op: "i32.add" },
                          { op: "local.set", index: 5 },
                        ],
                      },
                    ],
                  },
                ],
              },
              // emit cp into out: BMP → one code unit; astral → surrogate pair
              { op: "local.get", index: 8 },
              { op: "i32.const", value: 0xffff },
              { op: "i32.gt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // cp -= 0x10000; high = 0xD800 | (cp>>10); low = 0xDC00 | (cp&0x3FF)
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 0x10000 },
                  { op: "i32.sub" },
                  { op: "local.set", index: 8 },
                  // out[o] = 0xD800 | (cp>>10)
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 0xd800 },
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 10 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                  // out[o] = 0xDC00 | (cp & 0x3FF)
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 0xdc00 },
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 0x3ff },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                ],
                else: [
                  // out[o] = cp
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "local.get", index: 8 },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                ],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return struct.new $NativeString(len, 0, out)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 4 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];
    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_utf8_to_flat",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "byteLen", type: { kind: "i32" } },
        {
          name: "data",
          type: { kind: "ref", typeIdx: ctx.utf8StrDataTypeIdx },
        },
        { name: "out", type: strDataRef },
        { name: "b", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "c0", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_flatten(s: ref $AnyString) -> ref $NativeString ---
  // If s is already a FlatString, returns it. Otherwise flattens the rope tree.
  {
    const typeIdx = addFuncType(ctx, [strRef], [flatStrRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_flatten", funcIdx);
    // Also register in funcMap so the deferred late-import shift
    // (flushLateImportShifts walks ctx.funcMap) keeps __str_flatten's index
    // correct when imports are added after this registration. Internal callers
    // that emit a `call __str_flatten` between flatten's registration and a
    // late-import addition (notably ensureNativeStringExternBridge's
    // __str_to_extern, which adds 3 fd-bridge imports first) would otherwise
    // read a stale-low nativeStrHelpers index. funcMap is the authoritative,
    // shift-maintained map; no code looks up __str_flatten via funcMap so adding
    // it is side-effect-free. (#1618)
    ctx.funcMap.set("__str_flatten", funcIdx);

    const copyTreeIdx = ctx.nativeStrHelpers.get("__str_copy_tree")!;
    // #1588 PR-B part 2: present iff --utf8-storage is on.
    const utf8ToFlatIdx = ctx.nativeStrHelpers.get("__str_utf8_to_flat");

    // params: s(0)
    // locals: len(1), buf(2)
    const body: Instr[] = [
      // if s is already a FlatString, return it
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: flatStrRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
        ],
        else:
          ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined
            ? [
                // #1588 PR-B part 2: if s is a Utf8String, decode it to a NativeString.
                { op: "local.get", index: 0 },
                { op: "ref.test", typeIdx: ctx.utf8StrTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: flatStrRef },
                  then: [
                    { op: "local.get", index: 0 },
                    { op: "ref.cast", typeIdx: ctx.utf8StrTypeIdx },
                    { op: "call", funcIdx: utf8ToFlatIdx },
                  ],
                  else: flattenConsBody(strDataTypeIdx, strTypeIdx, anyStrTypeIdx, copyTreeIdx),
                },
              ]
            : flattenConsBody(strDataTypeIdx, strTypeIdx, anyStrTypeIdx, copyTreeIdx),
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_flatten",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "buf", type: strDataRef },
      ],
      body,
      exported: false,
    });
  }

  // #1588 PR-C: $__str_to_utf8(s: ref $AnyString) -> ref $__str_data_u8
  //
  // Standalone (pure-Wasm, no JS host call) WTF-16 → UTF-8 transcoder. Takes any
  // string value (NativeString, ConsString, or Utf8String), flattens it to a
  // contiguous i16 buffer, then encodes the code units to a freshly-allocated i8
  // UTF-8 byte array. This is the missing primitive the Component-Model boundary
  // (Edge B, deferred — see ADR-0015) will eventually call instead of a host
  // `TextEncoder` import, satisfying the "JS host optional" architecture rule.
  //
  // Semantics: this is the *conservative* encoder. Unlike the compile-time
  // `utf8Encode` (which asserts well-formedness for ascii/utf8-guaranteed
  // literals), this runtime helper handles arbitrary WTF-16 input. A lone
  // surrogate is encoded with the WTF-8 generalization (3-byte form of the raw
  // code unit 0xD800–0xDFFF) so the function is total and never traps. The
  // Component-Model fast path is only ever selected for values the encoding
  // analysis proved `utf8-guaranteed`, so a lone surrogate never reaches the
  // boundary fast path; this helper's surrogate handling is a defensive
  // totality guarantee, not a correctness path.
  //
  // Two passes over the flattened i16 buffer: pass 1 sums the UTF-8 byte length
  // so the output array is allocated exactly once (no realloc); pass 2 writes
  // the bytes. Only emitted when `--utf8-storage` is on (the i8 backing array
  // type `__str_data_u8` is registered only then).
  if (ctx.utf8Storage && ctx.utf8StrDataTypeIdx >= 0) {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const u8DataRef: ValType = { kind: "ref", typeIdx: ctx.utf8StrDataTypeIdx };
    const typeIdx = addFuncType(ctx, [strRef], [u8DataRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_to_utf8", funcIdx);

    // params: s(0)
    // locals:
    //   flat(1): ref $NativeString — flattened input
    //   data(2): ref $__str_data — i16 code units
    //   off(3): i32 — flat.off
    //   len(4): i32 — flat.len (code-unit count)
    //   out(5): ref $__str_data_u8 — UTF-8 output array
    //   i(6): i32 — code-unit cursor (shared by both passes)
    //   o(7): i32 — output byte cursor
    //   byteLen(8): i32 — total UTF-8 byte length (pass 1 result)
    //   cu(9): i32 — current code unit
    //   cp(10): i32 — current code point (after surrogate-pair decode)
    //   lo(11): i32 — trailing low surrogate scratch
    const FLAT = 1;
    const DATA = 2;
    const OFF = 3;
    const LEN = 4;
    const OUT = 5;
    const I = 6;
    const O = 7;
    const BYTELEN = 8;
    const CU = 9;
    const CP = 10;
    const LO = 11;

    // Shared sub-sequence: read the code point starting at code-unit index I of
    // `data`+`off`, advancing I past the consumed unit(s). Leaves cp in CP.
    // Handles a well-formed high+low surrogate pair (astral scalar) and treats a
    // lone surrogate as its raw code-unit value (WTF-8). `bodyAfterCp` is emitted
    // after CP is set and I is advanced; it differs between the two passes.
    const decodeCp = (bodyAfterCp: Instr[]): Instr[] => [
      // cu = data[off + i]
      { op: "local.get", index: DATA },
      { op: "local.get", index: OFF },
      { op: "local.get", index: I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: CU },
      // cp = cu (default)
      { op: "local.get", index: CU },
      { op: "local.set", index: CP },
      // i++ (consume the lead unit)
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: I },
      // if cu is a high surrogate (0xD800..0xDBFF) and a low surrogate follows,
      // combine into an astral code point and consume the low unit too.
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xdbff },
      { op: "i32.le_u" },
      { op: "i32.and" },
      // && i < len (a low unit exists)
      { op: "local.get", index: I },
      { op: "local.get", index: LEN },
      { op: "i32.lt_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // lo = data[off + i]
          { op: "local.get", index: DATA },
          { op: "local.get", index: OFF },
          { op: "local.get", index: I },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: LO },
          // if lo in 0xDC00..0xDFFF: cp = 0x10000 + ((cu-0xD800)<<10) + (lo-0xDC00); i++
          { op: "local.get", index: LO },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.ge_u" },
          { op: "local.get", index: LO },
          { op: "i32.const", value: 0xdfff },
          { op: "i32.le_u" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 0x10000 },
              { op: "local.get", index: CU },
              { op: "i32.const", value: 0xd800 },
              { op: "i32.sub" },
              { op: "i32.const", value: 10 },
              { op: "i32.shl" },
              { op: "i32.add" },
              { op: "local.get", index: LO },
              { op: "i32.const", value: 0xdc00 },
              { op: "i32.sub" },
              { op: "i32.add" },
              { op: "local.set", index: CP },
              // i++ (consume the low unit)
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
            ],
          },
        ],
      },
      ...bodyAfterCp,
    ];

    // Byte-length contribution of cp (UTF-8 / WTF-8): 1/2/3/4 bytes.
    // <=0x7F → 1; <=0x7FF → 2; <=0xFFFF → 3 (incl. lone surrogates); else 4.
    const cpByteLen = (onResult: Instr[]): Instr[] => [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, ...onResult],
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 2 }, ...onResult],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 3 }, ...onResult],
                else: [{ op: "i32.const", value: 4 }, ...onResult],
              },
            ],
          },
        ],
      },
    ];

    // Write cp as UTF-8 bytes into out[o..], advancing o.
    const writeBytes: Instr[] = [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // out[o] = cp; o += 1
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "local.get", index: CP },
          { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
          { op: "local.get", index: O },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: O },
        ],
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // 2-byte: 0xC0|(cp>>6), 0x80|(cp&0x3F)
              { op: "local.get", index: OUT },
              { op: "local.get", index: O },
              { op: "i32.const", value: 0xc0 },
              { op: "local.get", index: CP },
              { op: "i32.const", value: 6 },
              { op: "i32.shr_u" },
              { op: "i32.or" },
              { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.get", index: OUT },
              { op: "local.get", index: O },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 0x80 },
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x3f },
              { op: "i32.and" },
              { op: "i32.or" },
              { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.get", index: O },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "local.set", index: O },
            ],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // 3-byte: 0xE0|(cp>>12), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F)
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 0xe0 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 2 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 3 },
                  { op: "i32.add" },
                  { op: "local.set", index: O },
                ],
                else: [
                  // 4-byte: 0xF0|(cp>>18), 0x80|((cp>>12)&0x3F), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F)
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 0xf0 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 18 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 2 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 3 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 4 },
                  { op: "i32.add" },
                  { op: "local.set", index: O },
                ],
              },
            ],
          },
        ],
      },
    ];

    const body: Instr[] = [
      // flat = __str_flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT },
      // off = flat.off, len = flat.len, data = flat.data
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },

      // --- Pass 1: compute byteLen ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: BYTELEN },
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
              // decode cp (advances i), then byteLen += cpByteLen(cp)
              ...decodeCp(
                cpByteLen([
                  { op: "local.get", index: BYTELEN },
                  { op: "i32.add" },
                  { op: "local.set", index: BYTELEN },
                ]),
              ),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // out = array.new_default $__str_data_u8(byteLen)
      { op: "local.get", index: BYTELEN },
      { op: "array.new_default", typeIdx: ctx.utf8StrDataTypeIdx },
      { op: "local.set", index: OUT },

      // --- Pass 2: write bytes ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: O },
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
              ...decodeCp(writeBytes),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return out
      { op: "local.get", index: OUT },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_to_utf8",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "out", type: u8DataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "byteLen", type: { kind: "i32" } },
        { name: "cu", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
        { name: "lo", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_concat(a: ref $AnyString, b: ref $AnyString) -> ref $AnyString ---
  // For short strings (combined length < 64), copies into a flat string.
  // For longer strings, creates a ConsString node in O(1).
  {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const typeIdx = addFuncType(ctx, [strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_concat", funcIdx);

    // params: a(0), b(1)
    // locals: lenA(2), lenB(3), newLen(4), newArr(5), flatA(6), flatB(7)
    const body: Instr[] = [
      // lenA = a.len (field 0 of AnyString)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // lenA

      // lenB = b.len (field 0 of AnyString)
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // lenB

      // newLen = lenA + lenB
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 4 }, // newLen

      // if newLen >= 64, create ConsString (O(1) rope node)
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 64 },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // struct.new $ConsString(newLen, a, b)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "local.get", index: 0 }, // left = a
          { op: "local.get", index: 1 }, // right = b
          { op: "struct.new", typeIdx: consStrTypeIdx },
        ],
        else: [
          // Short string: flatten both sides and copy
          // flatA = flatten(a)
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 6 },

          // flatB = flatten(b)
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 7 },

          // newArr = array.new_default(newLen)
          { op: "local.get", index: 4 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 5 },

          // array.copy(newArr, 0, flatA.data, flatA.off, lenA)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 }, // dstOffset
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatA.data
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatA.off
          { op: "local.get", index: 2 }, // lenA
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // array.copy(newArr, lenA, flatB.data, flatB.off, lenB)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 }, // dstOffset = lenA
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatB.data
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatB.off
          { op: "local.get", index: 3 }, // lenB
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // result = struct.new $NativeString(newLen, 0, newArr)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "i32.const", value: 0 }, // off = 0
          { op: "local.get", index: 5 }, // data = newArr
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_concat",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
        { name: "flatA", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatB", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_buf_next_cap(curCap: i32, needed: i32) -> i32 ---
  // Returns a capacity at least as large as `needed`, doubling `curCap` until
  // the requirement is met. Used by the #1210 string-builder rewrite to size
  // the growable i16 buffer with O(log N) reallocations instead of O(N) per
  // `s += <expr>`. If `needed` exceeds INT32 doubling, returns `needed`
  // directly (caller traps on out-of-memory at the array.new_default site).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_buf_next_cap", funcIdx);

    // params: curCap(0), needed(1)
    // Strategy: ensure at least 16 bytes, then double until >= needed.
    const body: Instr[] = [
      // if curCap < 16 then curCap = 16 (ensures starting size)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 16 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 16 },
          { op: "local.set", index: 0 },
        ],
      },
      // while (curCap < needed) curCap = curCap * 2
      // block { loop { if (curCap >= needed) br outer; curCap *= 2; br inner } }
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if curCap >= needed: br outer (depth 1)
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // curCap *= 2
              { op: "local.get", index: 0 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.set", index: 0 },
              // restart loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return curCap
      { op: "local.get", index: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_buf_next_cap",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_equals(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_equals", funcIdx);

    // locals: len(2), i(3), aData(4), bData(5), aOff(6), bOff(7)
    const body: Instr[] = [
      // len = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // len

      // if a.len != b.len return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ne" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 7 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 4 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break (strings are equal)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // if aData[aOff + i] != bData[bOff + i], return 0
              { op: "local.get", index: 4 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 0 }, { op: "return" }],
              },

              // i++
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return 1 (equal)
      { op: "i32.const", value: 1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_equals",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_compare(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  // Lexicographic comparison: returns -1 (a < b), 0 (a == b), or 1 (a > b)
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_compare", funcIdx);

    // locals: lenA(2), lenB(3), minLen(4), i(5), aData(6), bData(7), aOff(8), bOff(9), ca(10), cb(11)
    const body: Instr[] = [
      // lenA = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // lenB = b.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // minLen = min(lenA, lenB)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      { op: "select" },
      { op: "local.set", index: 4 },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= minLen, break (common prefix is equal)
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ca = aData[aOff + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 10 },

              // cb = bData[bOff + i]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 11 },

              // if ca < cb return -1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },

              // if ca > cb return 1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.gt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
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

      // Common prefix is equal; compare by length
      // if lenA < lenB return -1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },

      // if lenA > lenB return 1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },

      // return 0 (equal)
      { op: "i32.const", value: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_compare",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "minLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
        { name: "ca", type: { kind: "i32" } },
        { name: "cb", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_substring(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_substring", funcIdx);

    // O(1) substring: creates a view sharing the backing array.
    // locals: sOff(3), sLen(4)
    const body: Instr[] = [
      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },

      // Clamp start: max(0, min(start, sLen))
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 1 }, // start = max(0, start)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 1 }, // start = min(start, sLen)

      // Clamp end: max(0, min(end, sLen))
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 2 }, // end = max(0, end)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 }, // end = min(end, sLen)

      // Swap if start > end (JS substring semantics)
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "local.set", index: 2 },
          { op: "local.set", index: 1 },
        ],
      },

      // struct.new(len = end - start, off = sOff + start, s.data)
      { op: "local.get", index: 2 }, // end
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" }, // len = end - start
      { op: "local.get", index: 3 }, // sOff
      { op: "local.get", index: 1 }, // start
      { op: "i32.add" }, // off = sOff + start
      { op: "local.get", index: 0 }, // s
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // s.data
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_substring",
      typeIdx,
      locals: [
        { name: "sOff", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_charAt", funcIdx);

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: off=0, len=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // Single-char string: len=1, off=0, [char]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.get", index: 1 },
          { op: "i32.add" }, // off + idx
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          // Create single-element array
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_charAt",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt_cp(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  // (#1470) Code-POINT charAt: like __str_charAt but when the code unit at
  // `idx` is a high surrogate followed by a low surrogate, returns the whole
  // 2-code-unit pair (§22.1.5.1 String iteration / §11.1.4 CodePointAt).
  // Lone surrogates and BMP scalars return the single unit. Used by the
  // for-of / spread / Array.from string-iteration lowerings; callers advance
  // their cursor by the returned string's `len`.
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_charAt_cp", funcIdx);
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: len=0, off=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // __str_substring(s, idx, idx + 1 + isPair)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          // isPair = (data[off+idx] & 0xFC00) == 0xD800 && idx + 1 < len
          //          && (data[off+idx+1] & 0xFC00) == 0xDC00
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
          { op: "local.get", index: 1 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "i32.const", value: 0xfc00 },
          { op: "i32.and" },
          { op: "i32.const", value: 0xd800 },
          { op: "i32.eq" },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // .len
          { op: "i32.lt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              // The low-surrogate read is guarded: only reached when
              // idx + 1 < len, so data[off+idx+1] is in bounds.
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
              { op: "local.get", index: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.const", value: 0xfc00 },
              { op: "i32.and" },
              { op: "i32.const", value: 0xdc00 },
              { op: "i32.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
          { op: "i32.add" }, // end = idx + 1 + isPair
          { op: "call", funcIdx: substringIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_charAt_cp",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_slice(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  // Like substring but handles negative indices
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_slice", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = len + start
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" },
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to >= 0
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 1 },
        ],
      },

      // Resolve negative end: if end < 0, end = len + end
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 2 }, // end (negative)
          { op: "i32.add" },
          { op: "local.set", index: 2 },
        ],
      },
      // Clamp end to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // §22.1.3.21 String.prototype.slice: unlike substring, slice does NOT
      // swap when start > end — it returns the empty string. __str_substring
      // swaps, so guard here: if (start >= end) return "" instead of
      // delegating. (#2123)
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 2 }, // end
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: len=0, off=0, empty backing array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // start < end: __str_substring clamps to len; no swap occurs.
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: substringIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_slice",
      typeIdx,
      locals: [{ name: "len", type: { kind: "i32" } }],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_substr(s: ref $NativeString, start: i32, length: i32) -> ref $NativeString ---
  // Annex B §B.2.2.1 String.prototype.substr(start, length):
  //   len = s.length
  //   if start < 0: start = max(len + start, 0)   (negative counts from end)
  //   length = max(min(length, len - start), 0)   (clamp; absent → len sentinel)
  //   return substring(start, start + length)
  // Unlike `substring`/`slice`, the SECOND argument is a *count*, not an end
  // index, and is never negative-relative. The caller passes 0x7fffffff for an
  // absent length so the min() clamps it to `len - start` (to the end).
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_substr", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = max(len + start, 0)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" }, // len + start
          { op: "local.set", index: 1 }, // start = len + start
          // max(start, 0): (start < 0) ? 0 : start
          { op: "i32.const", value: 0 }, // a = 0
          { op: "local.get", index: 1 }, // b = start
          { op: "local.get", index: 1 }, // start
          { op: "i32.const", value: 0 },
          { op: "i32.lt_s" }, // c = (start < 0)
          { op: "select" }, // c ? 0 : start
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to <= len (a start past the end yields the empty string).
      { op: "local.get", index: 1 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 },
          { op: "local.set", index: 1 },
        ],
      },

      // tail = len - start (chars available from `start` to the end)
      { op: "local.get", index: 3 }, // len
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" }, // len - start
      { op: "local.set", index: 4 }, // tail = len - start
      // length = min(length, tail): (length < tail) ? length : tail
      { op: "local.get", index: 2 }, // a = length
      { op: "local.get", index: 4 }, // b = tail
      { op: "local.get", index: 2 }, // length
      { op: "local.get", index: 4 }, // tail
      { op: "i32.lt_s" }, // c = (length < tail)
      { op: "select" }, // c ? length : tail
      { op: "local.set", index: 2 }, // length = min(length, tail)
      // Clamp length to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // return __str_substring(s, start, start + length)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 2 }, // length
      { op: "i32.add" }, // end = start + length
      { op: "call", funcIdx: substringIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_substr",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "tail", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // #3182 (Wave B, slice 1): the String.prototype *method* helpers (search,
  // trim, pad/repeat, case, replace, split, construction, RegExp-escape) were
  // extracted verbatim into native-strings-{search,transform,rewrite}.ts. They
  // are byte-identical relocations, invoked here in the original order — AFTER
  // the core helpers above (__str_flatten, __str_concat, __str_equals,
  // __str_substring, …) are registered, since each looks those up by name in
  // ctx.nativeStrHelpers.
  const methodShared = makeNativeStrShared(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx);
  emitStrSearchHelpers(methodShared);
  emitStrTrimHelpers(methodShared);
  emitStrPadRepeatHelpers(methodShared);
  emitStrCaseHelpers(methodShared);
  emitStrReplaceHelpers(methodShared);
  emitStrSplitHelper(methodShared);
  emitStrConstructHelpers(methodShared);
  emitStrRegexEscapeHelper(methodShared);

  // (#3069) Annex B §B.2.2 HTML string-wrapper methods — the `__str_html_escape_quot`
  // helper (CreateHTML step-4.b `"`→`&quot;` escaping). Emitted here, AFTER
  // __str_flatten/__str_concat are registered. The tag/attribute concatenation
  // is built inline at each call site in string-ops.ts via __str_concat.
  emitNativeHtmlWrapperHelpers(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx);
}

/**
 * #1470 — Emit `$__any_to_string(v: anyref) -> ref $AnyString`, the standalone
 * (no-JS-host) replacement for the `__extern_toString` host import. Dispatches
 * on the concrete WasmGC type of `v`:
 *   - ref $AnyString    → returned as-is (already a native string)
 *   - ref $AnyValue     → switch on the boxed tag:
 *       0 null      → "null"
 *       1 undefined → "undefined"
 *       2 i32 num   → number_toString(f64.convert_i32_s(i32val))
 *       3 f64 num   → number_toString(f64val)
 *       4 bool      → "true" / "false"
 *       5 string    → externval → any.convert_extern → ref.cast $AnyString
 *       6 ref / else→ "[object Object]"
 *   - anything else     → "[object Object]"
 *
 * Spec-correct dispatch for ordinary objects (walking @@toPrimitive / toString
 * via the object's vtable) lands with #1472; the Phase-1 fallback here is the
 * canonical `"[object Object]"` so a standalone module never traps on a string
 * coercion of an arbitrary value.
 *
 * Idempotent — caches the function index under `nativeStrHelpers["__any_to_string"]`.
 */
/**
 * (#2962) §20.5.3.4 `Error.prototype.toString` for the native `$Error_struct` —
 * `__error_to_string(v: anyref) -> ref $AnyString`, where `v` MUST already be
 * a `$Error_struct` (callers guard with `ref.test`; the entry `ref.cast` is
 * defensive).
 *
 *   1. name = $name field when it is a native string, else the literal
 *      "Error" (our constructors always materialize a non-empty name, so the
 *      spec's empty-name arm is unreachable — see emitErrorStructConstructor).
 *   2. msg  = $message field; `null` (constructed argument-less), a NON-string
 *      (documented residual: §20.5.1.1 stores ToString(message) at
 *      construction, our ctor stores the raw arg), or the empty string all
 *      yield `name` alone per §20.5.3.4 steps 4–6.
 *   3. else `name + ": " + msg`.
 *
 * Standalone/WASI only: in JS-host mode the `__new_<Kind>` imports resolve to
 * the real JS constructors, so thrown errors are host objects and never
 * `$Error_struct`s — the helper would be dead weight. Registering the error
 * struct type here (idempotent) makes the arm order-independent: a module
 * whose first string coercion happens BEFORE its first error construction
 * still gets the arm.
 *
 * Index-shift safety (#1448 pattern): the only baked dependency is
 * `__str_concat` (already emitted by ensureNativeStringHelpers); the body is
 * built and pushed with no intervening helper emission. Registered in
 * `funcMap` so deferred late-import flushes keep the index authoritative.
 *
 * Idempotent — cached under `nativeStrHelpers["__error_to_string"]`.
 */
function ensureErrorToStringHelper(ctx: CodegenContext): number | undefined {
  const cached = ctx.nativeStrHelpers.get("__error_to_string");
  if (cached !== undefined) return cached;
  if (!(ctx.standalone || ctx.wasi)) return undefined; // noJsHost only (see doc above)
  ensureNativeStringHelpers(ctx);
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return undefined;

  const errStructIdx = getOrRegisterErrorStructType(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);

  // params: v(0) anyref · locals: e(1) ref null $Error_struct, tmp(2) anyref,
  // name(3) ref null $AnyString, msg(4) ref null $AnyString
  const L_V = 0;
  const L_E = 1;
  const L_TMP = 2;
  const L_NAME = 3;
  const L_MSG = 4;

  const returnName: Instr[] = [{ op: "local.get", index: L_NAME }, { op: "ref.as_non_null" }, { op: "return" }];

  const body: Instr[] = [
    { op: "local.get", index: L_V },
    { op: "ref.cast", typeIdx: errStructIdx },
    { op: "local.set", index: L_E },
    // name = ($name is a native string) ? it : "Error"
    { op: "local.get", index: L_E },
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 2 }, // $name (externref)
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: L_TMP },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: litStr("Error"),
    },
    { op: "local.set", index: L_NAME },
    // msg — null / non-string → name alone (steps 4–6; non-string is the
    // documented construction-time-ToString residual).
    { op: "local.get", index: L_E },
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 1 }, // $message (externref)
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnName.map((i) => ({ ...i })) },
    { op: "local.get", index: L_TMP },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "local.set", index: L_MSG },
    // empty message → name alone (§20.5.3.4 step 6)
    { op: "local.get", index: L_MSG },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 }, // len
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnName.map((i) => ({ ...i })) },
    // name + ": " + msg
    { op: "local.get", index: L_NAME },
    { op: "ref.as_non_null" },
    ...litStr(": "),
    { op: "call", funcIdx: strConcatIdx },
    { op: "local.get", index: L_MSG },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: strConcatIdx },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "anyref" }], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__error_to_string", funcIdx);
  ctx.funcMap.set("__error_to_string", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__error_to_string",
    typeIdx,
    locals: [
      { name: "e", type: { kind: "ref_null", typeIdx: errStructIdx } },
      { name: "tmp", type: { kind: "anyref" } },
      { name: "name", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      { name: "msg", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

export function ensureAnyToStringHelper(ctx: CodegenContext): number {
  ensureNativeStringHelpers(ctx);
  const existing = ctx.nativeStrHelpers.get("__any_to_string");
  if (existing !== undefined) return existing;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const anyref: ValType = { kind: "anyref" };

  // The $AnyValue box must exist for the tag-dispatch arm. It is registered
  // lazily; ensure it here so the struct.get / ref.cast below resolve.
  ensureAnyValueType(ctx);
  const anyValueTypeIdx = ctx.anyValueTypeIdx;

  // (#3216) Register the native `number_toString` BEFORE any funcIdx below is
  // captured, so `__any_to_string`'s number arms (the tag-2/tag-3 dispatch arms
  // AND the residual boxed-`$__box_number_struct` arm) bake the REAL conversion
  // rather than the "[object Object]" fallback. Root cause: when
  // `ensureAnyToStringHelper` is the FIRST consumer of number stringification in
  // a module — e.g. a reflective `String.prototype.<m>.call(<number|boolean>)`
  // body's `ToString(this)` is the first `__any_to_string` caller — the lazily-
  // registered `number_toString` did not yet exist, so `numToStrIdx` below was
  // `undefined` and every `numberArm(...)` captured the literal "[object Object]".
  // The helper is cached, so the WHOLE module then stringified boxed primitives
  // wrong (`String.prototype.charAt.call(12345, 2)` read `"[object Object]"[2]`
  // instead of `"12345"[2]`). Other consumers (array `join`, `String(x)`,
  // template literals) pulled `number_toString` in first, which is why they
  // worked and masked this ordering hazard. Idempotent + append-only DEFINED
  // function (no import → the #1448 late-import shift risk it can trigger via
  // string constants happens HERE, before the `errToStrIdx`/`numToStrIdx`
  // captures below, so those stay consistent). Native-strings-gated so host/gc
  // lanes stay byte-identical (there `number_toString` is host-provided/absent
  // and the numberArm keeps its prior fallback).
  if (ctx.nativeStrings && !ctx.funcMap.has("number_toString")) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }

  // (#2962) Emit the §20.5.3.4 `__error_to_string` helper BEFORE this
  // function's own index is baked (it appends a function — no import, so no
  // index shift for anything already emitted). `undefined` in JS-host mode
  // (errors are host objects there) — every arm below then degrades to the
  // prior "[object Object]" literal, keeping host lanes byte-identical.
  const errToStrIdx = ensureErrorToStringHelper(ctx);
  const errStructTypeIdx = errToStrIdx !== undefined ? ctx.errorStructTypeIdx : -1;

  // number_toString returns an externref that is really a `ref $AnyString` in
  // native-strings mode; convert it back with any.convert_extern + ref.cast.
  const numToStrIdx = ctx.funcMap.get("number_toString");

  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);

  // (#2962) Shared terminal for an unrecognized object ref: `$Error_struct` →
  // `__error_to_string` (a real "TypeError: boom"), anything else → the
  // canonical "[object Object]". `loadRef` is a FACTORY (fresh instruction
  // objects per use) because the ref is loaded twice (test + call) — aliasing
  // one instr array into two tree positions double-shifts funcIdx fields when
  // post-codegen passes walk the tree (the #1448 corruption class).
  const objectOrErrorTag = (loadRef: () => Instr[]): Instr[] =>
    errToStrIdx !== undefined && errStructTypeIdx >= 0
      ? [
          ...loadRef(),
          { op: "ref.test", typeIdx: errStructTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [...loadRef(), { op: "call", funcIdx: errToStrIdx }],
            else: litStr("[object Object]"),
          },
        ]
      : litStr("[object Object]");

  // `box` (the $AnyValue ref) lives in local 1; the original anyref param in 0.
  const L_V = 0;
  const L_BOX = 1;
  // #1910/#1472 S2 — scratch anyref for the tag-5 string-vs-wrapper recovery.
  const L_RECOVER = 2;

  const numberArm = (loadNumeric: Instr[]): Instr[] =>
    numToStrIdx !== undefined
      ? [
          ...loadNumeric,
          { op: "call", funcIdx: numToStrIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
        ]
      : litStr("[object Object]");

  // #1910/#1472 S2 — recover the string for an externref that is tagged as a
  // string (tag 5) but is NOT actually a `$AnyString`. The generic
  // externref→AnyValue boxing tags EVERY externref as tag-5 (see
  // value-tags.ts:185), so a boxed-primitive WRAPPER (`new String`/`new Number`/
  // `new Boolean` → a `$Object` carrying the internal [[PrimitiveValue]] slot)
  // reaches the tag-5 arm; the raw `ref.cast $AnyString` would trap ("illegal
  // cast"). When the value is a `$Object`, reduce it with `__to_primitive`
  // (registered by ensureObjectRuntime BEFORE this helper bakes, so its funcIdx
  // is known here — same no-intervening-shift invariant the rest of this helper
  // relies on), which reads the wrapper's internal slot and returns its boxed
  // primitive. That primitive is then a `$AnyString` (string wrapper) or a
  // `$__box_number_struct`/`$__box_boolean_struct` (number/boolean wrapper), all
  // of which the existing $AnyString test + residual box-recovery format
  // correctly — so we route the reduced value back through that recovery
  // (`stringifyExtern`). Non-`$Object` tag-5 externrefs (boxed primitive carriers
  // crossing the open-any boundary) skip straight to that recovery unchanged.
  const toPrimitiveIdx = ctx.funcMap.get("__to_primitive");
  const objectRtTypes = ctx.objectRuntimeTypes;
  const boxNumIdxEarly = ctx.nativeBoxNumberTypeIdx;
  const boxBoolIdxEarly = ctx.nativeBoxBooleanTypeIdx;
  // Format an externref already known NOT to be a $AnyString: recover a
  // $__box_number_struct / $__box_boolean_struct, else "[object Object]".
  const stringifyBoxedExtern = (loadExtern: Instr[]): Instr[] =>
    boxNumIdxEarly >= 0 && boxBoolIdxEarly >= 0
      ? [
          ...loadExtern,
          { op: "any.convert_extern" },
          { op: "local.tee", index: L_RECOVER },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [
              { op: "local.get", index: L_RECOVER },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
            ],
            else: [
              { op: "local.get", index: L_RECOVER },
              { op: "ref.test", typeIdx: boxNumIdxEarly },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: numberArm([
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.cast", typeIdx: boxNumIdxEarly },
                  { op: "struct.get", typeIdx: boxNumIdxEarly, fieldIdx: 0 },
                ]),
                else: [
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.test", typeIdx: boxBoolIdxEarly },
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: boxBoolIdxEarly },
                      { op: "struct.get", typeIdx: boxBoolIdxEarly, fieldIdx: 0 },
                      {
                        op: "if",
                        blockType: { kind: "val", type: strRef },
                        then: litStr("true"),
                        else: litStr("false"),
                      },
                    ],
                    // (#2962) a `$Error_struct` reaching the tag-5 boxed-extern
                    // recovery (a caught error re-boxed as `any`) renders
                    // "Name: message" instead of "[object Object]".
                    else: objectOrErrorTag(() => [{ op: "local.get", index: L_RECOVER }]),
                  },
                ],
              },
            ],
          },
        ]
      : litStr("[object Object]");
  const recoverNonStringExtern = (loadExtern: Instr[]): Instr[] =>
    toPrimitiveIdx !== undefined && objectRtTypes !== undefined
      ? [
          // if (value is a $Object wrapper) value = __to_primitive(value, default)
          ...loadExtern,
          { op: "any.convert_extern" },
          { op: "local.tee", index: L_RECOVER },
          { op: "ref.test", typeIdx: objectRtTypes.objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: stringifyBoxedExtern([
              { op: "local.get", index: L_RECOVER },
              { op: "extern.convert_any" },
              { op: "ref.null.extern" }, // default hint
              { op: "call", funcIdx: toPrimitiveIdx },
            ]),
            else: stringifyBoxedExtern([{ op: "local.get", index: L_RECOVER }, { op: "extern.convert_any" }]),
          },
        ]
      : stringifyBoxedExtern(loadExtern);

  const tagEq = (tag: number): Instr[] => [
    { op: "local.get", index: L_BOX },
    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
  ];

  // tag dispatch as a nested if/else chain producing `ref $AnyString`.
  const boxDispatch: Instr[] = [
    ...tagEq(0),
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: litStr("null"),
      else: [
        ...tagEq(1),
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: litStr("undefined"),
          else: [
            ...tagEq(2),
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: numberArm([
                { op: "local.get", index: L_BOX },
                { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                { op: "f64.convert_i32_s" },
              ]),
              else: [
                ...tagEq(3),
                {
                  op: "if",
                  blockType: { kind: "val", type: strRef },
                  then: numberArm([
                    { op: "local.get", index: L_BOX },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 2 },
                  ]),
                  else: [
                    ...tagEq(4),
                    {
                      op: "if",
                      blockType: { kind: "val", type: strRef },
                      then: [
                        { op: "local.get", index: L_BOX },
                        {
                          op: "struct.get",
                          typeIdx: anyValueTypeIdx,
                          fieldIdx: 1,
                        },
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          then: litStr("true"),
                          else: litStr("false"),
                        },
                      ],
                      else: [
                        ...tagEq(5),
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          // tag 5 (string): the externval is USUALLY a real
                          // `$AnyString`, but the generic externref boxing also
                          // tags boxed-primitive WRAPPER objects (new String /
                          // Number / Boolean → $Object) and other open externrefs
                          // as tag-5 (#1910/#1472 S2). Test $AnyString first; only
                          // cast when it really is a string, otherwise recover via
                          // __extern_toString (reads the wrapper's internal slot
                          // through ToPrimitive). Without this guard the raw cast
                          // traps with "illegal cast" for `new String("1") + x`.
                          then: [
                            { op: "local.get", index: L_BOX },
                            {
                              op: "struct.get",
                              typeIdx: anyValueTypeIdx,
                              fieldIdx: 4,
                            },
                            { op: "any.convert_extern" },
                            { op: "local.tee", index: L_RECOVER },
                            { op: "ref.test", typeIdx: anyStrTypeIdx },
                            {
                              op: "if",
                              blockType: { kind: "val", type: strRef },
                              then: [
                                { op: "local.get", index: L_RECOVER },
                                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                              ],
                              else: recoverNonStringExtern([
                                { op: "local.get", index: L_RECOVER },
                                { op: "extern.convert_any" },
                              ]),
                            },
                          ],
                          // tag 6 / unknown → $Error_struct renders
                          // "Name: message" (#2962), else "[object Object]"
                          else: objectOrErrorTag(() => [
                            { op: "local.get", index: L_BOX },
                            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 3 },
                          ]),
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

  // (#2072) Standalone primitive-box recovery — subsumes the #1988 number-only
  // arm (which lived at this exact residual location and recovered ONLY
  // `$__box_number_struct` → number_toString, e.g. the `1` in `1 + {}` after
  // ToPrimitive). An `any`-held primitive is NOT stored as a $AnyValue box on
  // the WasmGC/standalone path — `coerceType` boxes f64 via `__box_number`
  // ($__box_number_struct), bool via `__box_boolean` ($__box_boolean_struct),
  // then `extern.convert_any` makes it externref (the #1888 externref ABI the
  // test262 comparator relies on, which is why we recover the shape here rather
  // than changing the box). So when the value is neither $AnyString nor
  // $AnyValue, before yielding "[object Object]" we ref.test the boxed-primitive
  // structs and format them, matching what the $AnyValue tag-2/tag-4 arms above
  // already do. Without this, String(v) for `const v: any = 42 / true` returned
  // "[object Object]". The number sub-arm uses `numberArm(...)`, which appends
  // exactly `call number_toString; any.convert_extern; ref.cast $AnyString` —
  // byte-identical to #1988's explicit emit (and falls back to "[object Object]"
  // when `number_toString` is absent), so #1988's `1 + {}` case still holds.
  // Type indices (not func indices) are read here, so no late-import shift
  // hazard; the only func index baked in is `numToStrIdx`, which this helper
  // already bakes for tag 2/3.
  const boxNumIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolIdx = ctx.nativeBoxBooleanTypeIdx;
  const residualArm: Instr[] =
    boxNumIdx >= 0 && boxBoolIdx >= 0
      ? [
          // $__box_number_struct? → number_toString(value)
          { op: "local.get", index: L_V },
          { op: "ref.test", typeIdx: boxNumIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: numberArm([
              { op: "local.get", index: L_V },
              { op: "ref.cast", typeIdx: boxNumIdx },
              { op: "struct.get", typeIdx: boxNumIdx, fieldIdx: 0 },
            ]),
            else: [
              // $__box_boolean_struct? → "true" / "false"
              { op: "local.get", index: L_V },
              { op: "ref.test", typeIdx: boxBoolIdx },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: boxBoolIdx },
                  { op: "struct.get", typeIdx: boxBoolIdx, fieldIdx: 0 },
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: litStr("true"),
                    else: litStr("false"),
                  },
                ],
                // unknown ref → $Error_struct renders "Name: message"
                // (#2962), else "[object Object]"
                else: objectOrErrorTag(() => [{ op: "local.get", index: L_V }]),
              },
            ],
          },
        ]
      : // No box types registered — still recognize a raw `$Error_struct`
        // (#2962) before the "[object Object]" terminal.
        objectOrErrorTag(() => [{ op: "local.get", index: L_V }]);

  const body: Instr[] = [
    // if (v is a $AnyString) return it directly
    { op: "local.get", index: L_V },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: L_V },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: [
        // else if (v is a $AnyValue) dispatch on its tag
        { op: "local.get", index: L_V },
        { op: "ref.test", typeIdx: anyValueTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [
            { op: "local.get", index: L_V },
            { op: "ref.cast", typeIdx: anyValueTypeIdx },
            { op: "local.set", index: L_BOX },
            ...boxDispatch,
          ],
          // else (boxed primitive externref shape, null ref, plain object, vec,
          // …) → recover number/boolean boxes, then "[object Object]"
          else: residualArm,
        },
      ],
    },
  ];

  const typeIdx = addFuncType(ctx, [anyref], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__any_to_string", funcIdx);
  ctx.funcMap.set("__any_to_string", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__any_to_string",
    typeIdx,
    locals: [
      { name: "box", type: { kind: "ref_null", typeIdx: anyValueTypeIdx } },
      { name: "recover", type: { kind: "anyref" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #2007 — emit a per-vec-type native array-join helper
 * `__vec_join_<elemKind>(v: ref null $__vec_<elemKind>) -> ref $AnyString`.
 *
 * Joins the vec's elements with `","` using native string concat:
 *   - numeric element (f64/i32/i8/i16) → `number_toString` (native string boxed
 *     as externref → convert back to `ref $AnyString`);
 *   - native-string element (`ref $AnyString` / `$NativeString`) → passthrough
 *     (a subtype of `$AnyString`);
 *   - nested-vec element (`ref` to another registered `__vec_*`) → recurse into
 *     THAT vec's own `__vec_join_*` helper, so `[[1,2],[3]]` yields `"1,2,3"`;
 *   - any other ref / externref element → `"[object Object]"` (the same residual
 *     `$__any_to_string` would give — kept simple to avoid a cross-helper call
 *     index that the addUnionImports late shift can desync, #1839).
 *
 * **Index-shift safety (the #1448 regression fix):** every dependency
 * (`number_toString`, a nested `__vec_join_*`) is emitted *first*, so any late
 * import shift it triggers happens BEFORE this body is built; their final
 * indices are read after, then the body is built and pushed with NO intervening
 * helper emission. Otherwise a shift between baking a `call funcIdx` and pushing
 * the body leaves the not-yet-attached body un-walked by `shiftFuncIndices` →
 * stale index → "call expected (ref null 5), found anyref" (the #1448 break).
 *
 * Empty vec → `""`; single element → that element's string. Idempotent: cached
 * under `nativeStrHelpers["__vec_join_<elemKind>"]`.
 */
function ensureNativeVecJoinHelper(
  ctx: CodegenContext,
  elemKind: string,
  vecTypeIdx: number,
  arrTypeIdx: number,
): number | undefined {
  const cacheKey = `__vec_join_${elemKind}`;
  const cached = ctx.nativeStrHelpers.get(cacheKey);
  if (cached !== undefined) return cached;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return undefined;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };

  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemType: ValType = arrDef && arrDef.kind === "array" ? (arrDef.element as ValType) : { kind: "f64" };
  const isNumeric =
    elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16";
  const isNativeStrElem =
    (elemType.kind === "ref" || elemType.kind === "ref_null") &&
    (elemType as { typeIdx: number }).typeIdx === anyStrTypeIdx;
  // A non-string ref element whose target is itself a registered vec → nested
  // array; recurse into that vec's join helper.
  let nestedElemKind: string | undefined;
  if ((elemType.kind === "ref" || elemType.kind === "ref_null") && !isNativeStrElem) {
    const elemTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    for (const [k, idx] of ctx.vecTypeMap.entries()) {
      if (idx === elemTypeIdx) {
        nestedElemKind = k;
        break;
      }
    }
  }

  // ── Run EVERY side-effecting emission FIRST, then read ALL indices last ──
  // (#1448) `emitNativeNumberFormat`, a nested `ensureNativeVecJoinHelper`, and
  // `nativeStringLiteralInstrs` (string-constant global / late import
  // registration) can each trigger an `addUnionImports` function-index shift.
  // If we read a funcIdx and THEN one of these shifts, the read index goes
  // stale and the baked `call` targets the wrong function (the #1448
  // catastrophe: number_toString resolved to a (i32)→… and codegen even
  // inserted an `i32.trunc_sat_f64_s` to match it, plus a stray stack value).
  // So perform ALL emissions up front, materialize the literal-string
  // instruction arrays here too, and only THEN snapshot every funcIdx.
  if (isNumeric && ctx.funcMap.get("number_toString") === undefined) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }
  let nestedJoinIdx: number | undefined;
  if (nestedElemKind !== undefined) {
    const nestedVecTypeIdx = ctx.vecTypeMap.get(nestedElemKind)!;
    const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
    if (nestedArrTypeIdx >= 0) {
      nestedJoinIdx = ensureNativeVecJoinHelper(ctx, nestedElemKind, nestedVecTypeIdx, nestedArrTypeIdx);
    }
  }
  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);
  // Materialize the constant strings now (last possible shift source) so their
  // string-constant globals register before we snapshot any function index.
  const objObjInstrs = litStr("[object Object]");
  const sepInstrs = litStr(",");
  const emptyInstrs = litStr("");

  // Now snapshot every cross-function index — all shift sources are behind us.
  const numToStrIdx = isNumeric ? ctx.funcMap.get("number_toString") : undefined;
  if (isNumeric && numToStrIdx === undefined) return undefined;
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return undefined;

  // param v(0); locals: data(1), len(2), i(3), result(4)
  const V = 0;
  const DATA = 1;
  const LEN = 2;
  const I = 3;
  const RESULT = 4;

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // element i → ref $AnyString
  const elemToStr: Instr[] = [
    { op: "local.get", index: DATA },
    { op: "local.get", index: I },
    { op: getOp, typeIdx: arrTypeIdx },
  ];
  if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: numToStrIdx });
    elemToStr.push({ op: "any.convert_extern" });
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
  } else if (isNativeStrElem) {
    // native-string element — already a (ref null $AnyString) subtype; non-null.
    elemToStr.push({ op: "ref.as_non_null" });
  } else if (nestedJoinIdx !== undefined) {
    // nested array element → recurse into its own join helper.
    elemToStr.push({ op: "call", funcIdx: nestedJoinIdx });
  } else {
    // any other ref / externref element → residual "[object Object]".
    elemToStr.length = 0;
    elemToStr.push(...objObjInstrs);
  }

  const loopBody: Instr[] = [
    { op: "local.get", index: I },
    { op: "local.get", index: LEN },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // result = (i == 0) ? elem : __str_concat(__str_concat(result, ","), elem)
    { op: "local.get", index: I },
    { op: "i32.const", value: 0 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...elemToStr, { op: "local.set", index: RESULT }],
      else: [
        { op: "local.get", index: RESULT },
        ...sepInstrs,
        { op: "call", funcIdx: strConcatIdx },
        ...elemToStr,
        { op: "call", funcIdx: strConcatIdx },
        { op: "local.set", index: RESULT },
      ],
    },

    { op: "local.get", index: I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: I },
    { op: "br", depth: 0 },
  ];

  const body: Instr[] = [
    // null receiver → "" (defensive; concat callers never pass null vecs)
    { op: "local.get", index: V },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: emptyInstrs,
      else: [
        // len = v.length (field 0); data = v.data (field 1)
        { op: "local.get", index: V },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: LEN },
        { op: "local.get", index: V },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: DATA },
        // result = ""
        ...litStr(""),
        { op: "local.set", index: RESULT },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
        },
        { op: "local.get", index: RESULT },
      ],
    },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "ref_null", typeIdx: vecTypeIdx }], [strRef]);
  const joinFuncIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set(cacheKey, joinFuncIdx);
  ctx.funcMap.set(cacheKey, joinFuncIdx);
  pushDefinedFunc(ctx, joinFuncIdx, {
    name: cacheKey,
    typeIdx,
    locals: [
      { name: "data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "result", type: strRef },
    ],
    body,
    exported: false,
  });
  return joinFuncIdx;
}

/**
 * #2007 — call-site entry point for the standalone `+`/template concat path.
 * When a concat operand is a statically-known WasmGC vec (array) ref, emit the
 * Array.prototype.join lowering **inline into `fctx.body`** and leave a
 * `ref $AnyString` on the stack. Returns true if it handled the operand.
 *
 * The operand value is assumed already on the stack with the given
 * `vecValType` (a `ref`/`ref_null` to a registered vec struct).
 *
 * **Why inline, not a cached helper (#1448).** Emitting into the current
 * function body is the proven-safe pattern (cf. `compileArrayJoinNative`):
 * `number_toString` / `__str_concat` indices are read here and the resulting
 * `call`s live in `fctx.body`, which the late-import `shiftFuncIndices` pass
 * always walks — so a closure-method operand (`[...].map(fn)`, whose late
 * import registration desyncs a *separate cached helper's* baked indices) can
 * no longer produce an invalid module. Nested-array elements (a ref to another
 * registered vec, common in `[[1,2],[3]]` literals which are closure-free)
 * recurse into the cached per-vec join helper, which is consistent there.
 */
export function tryCompileNativeVecConcatOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecValType: ValType,
): boolean {
  if (vecValType.kind !== "ref" && vecValType.kind !== "ref_null") return false;
  const vecTypeIdx = (vecValType as { typeIdx: number }).typeIdx;
  if (vecTypeIdx === undefined) return false;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return false;
  // Confirm this typeIdx is actually a registered vec (not some other struct
  // that happens to have an array in field 1).
  let isVec = false;
  for (const idx of ctx.vecTypeMap.values()) {
    if (idx === vecTypeIdx) {
      isVec = true;
      break;
    }
  }
  if (!isVec) return false;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return false;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return false;

  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemType: ValType = arrDef && arrDef.kind === "array" ? (arrDef.element as ValType) : { kind: "f64" };
  const isNumeric =
    elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16";
  const isNativeStrElem =
    (elemType.kind === "ref" || elemType.kind === "ref_null") &&
    (elemType as { typeIdx: number }).typeIdx === anyStrTypeIdx;
  // nested array element → recurse into the cached join helper for the inner vec.
  let nestedElemKind: string | undefined;
  if ((elemType.kind === "ref" || elemType.kind === "ref_null") && !isNativeStrElem) {
    const elemTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    for (const [k, idx] of ctx.vecTypeMap.entries()) {
      if (idx === elemTypeIdx) {
        nestedElemKind = k;
        break;
      }
    }
  }

  // Only element kinds we can stringify by value qualify for the join fast-path:
  // numeric, native-string, or a nested vec. An `externref`-element vec is what a
  // closure array method (`[...].map(fn)`) produces — its elements are opaque
  // boxed `any`s, and such operands stringified as "[object Object]" on baseline.
  // Routing them here would (a) need a host/ToString bridge the standalone lane
  // lacks and (b) re-introduce the closure index-desync, so fall back to
  // `$__any_to_string` (the existing "[object Object]" behaviour — no regression).
  if (!isNumeric && !isNativeStrElem && nestedElemKind === undefined) return false;

  // (#1448) If a closure-allocating array method (`map`/`filter`/…) was already
  // lowered in this function, the native array-join lowering corrupts the
  // closure's emitted code (a pre-existing hazard `a.join(",")` exhibits too —
  // see the issue analysis). Fall back to `$__any_to_string` ("[object Object]",
  // the baseline behaviour) in that case rather than emit an invalid module —
  // no regression. The headline `"" + [1,2]` / template cases compile in plain
  // functions that never set this flag, so they keep the join fast-path.
  if (fctx.emittedClosureArrayMethod) return false;

  // Ensure dependencies (these may shift indices — fine, fctx.body is walked).
  let numToStrIdx: number | undefined;
  if (isNumeric) {
    if (ctx.funcMap.get("number_toString") === undefined) {
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    }
    numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) return false;
  }
  let nestedJoinIdx: number | undefined;
  if (nestedElemKind !== undefined) {
    const nestedVecTypeIdx = ctx.vecTypeMap.get(nestedElemKind)!;
    const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
    if (nestedArrTypeIdx >= 0) {
      nestedJoinIdx = ensureNativeVecJoinHelper(ctx, nestedElemKind, nestedVecTypeIdx, nestedArrTypeIdx);
    }
  }

  // Locals: the vec ref (tee'd from the stack), data array, length, index, result.
  const vecTmp = allocLocal(fctx, `__vcat_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__vcat_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__vcat_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__vcat_i_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__vcat_res_${fctx.locals.length}`, strRef);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
  ];
  if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: numToStrIdx });
    elemToStr.push({ op: "any.convert_extern" });
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
  } else if (isNativeStrElem) {
    elemToStr.push({ op: "ref.as_non_null" });
  } else if (nestedJoinIdx !== undefined) {
    elemToStr.push({ op: "call", funcIdx: nestedJoinIdx });
  } else {
    // any other ref / externref element → residual "[object Object]".
    elemToStr.length = 0;
    elemToStr.push(...nativeStringLiteralInstrs(ctx, "[object Object]"));
  }

  // The vec ref is on the stack — tee into vecTmp, guard null → "".
  fctx.body.push({ op: "local.tee", index: vecTmp });
  // (a null vec stringifies as "" here — concat callers never pass null vecs)
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: strRef },
    then: nativeStringLiteralInstrs(ctx, ""),
    else: [
      { op: "local.get", index: vecTmp },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenTmp },
      { op: "local.get", index: vecTmp },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: dataTmp },
      ...nativeStringLiteralInstrs(ctx, ""),
      { op: "local.set", index: resultTmp },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iTmp },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: iTmp },
              { op: "local.get", index: lenTmp },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: iTmp },
              { op: "i32.const", value: 0 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...elemToStr, { op: "local.set", index: resultTmp }],
                else: [
                  { op: "local.get", index: resultTmp },
                  ...nativeStringLiteralInstrs(ctx, ","),
                  { op: "call", funcIdx: strConcatIdx },
                  ...elemToStr,
                  { op: "call", funcIdx: strConcatIdx },
                  { op: "local.set", index: resultTmp },
                ],
              },
              { op: "local.get", index: iTmp },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iTmp },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: resultTmp },
    ],
  });
  return true;
}

/**
 * #1470 — Emit `$__str_to_char_vec(s: ref $AnyString) -> ref $vec_nstr`: the
 * pure-Wasm String-iterator materializer. Splits the string into single
 * **code point** strings per §22.1.5.1 (the String Iteration protocol that
 * `[...s]`, `Array.from(s)` and for-of observe): a well-formed surrogate
 * pair yields one 2-code-unit string; everything else (BMP scalars and lone
 * surrogates) yields a 1-code-unit string.
 *
 * The result reuses the `ref_<anyStr>` vec registration that `__str_split`
 * established, so callers get the exact vec shape `string[]` lowers to
 * (`.length`, indexing, spreads compose without conversion). The backing
 * array is sized `len` (the code-unit count — an upper bound on the code
 * point count); the vec's `len` field carries the actual element count, so
 * trailing unused slots are never observed.
 *
 * Returns both the helper funcIdx (current at call time — late-import shifts
 * keep `nativeStrHelpers` patched, #1839) and the nstr vec type index.
 */
export function ensureStrToCharVecHelper(ctx: CodegenContext): { funcIdx: number; vecTypeIdx: number } {
  ensureNativeStringHelpers(ctx);

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;

  // Same registration key/type as `__str_split` so the vec matches string[].
  const nstrElemKey = `ref_${anyStrTypeIdx}`;
  const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
  const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);

  const existing = ctx.nativeStrHelpers.get("__str_to_char_vec");
  if (existing !== undefined) return { funcIdx: existing, vecTypeIdx: nstrVecTypeIdx };

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten")!;
  const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

  // param: s(0); locals: flat(1), len(2), off(3), data(4), out(5), n(6),
  // i(7), cu(8), take(9)
  const S = 0;
  const FLAT = 1;
  const LEN = 2;
  const OFF = 3;
  const DATA = 4;
  const OUT = 5;
  const N = 6;
  const I = 7;
  const CU = 8;
  const TAKE = 9;

  const body: Instr[] = [
    // flat = __str_flatten(s); cache len/off/data
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

    // out = new (ref null $AnyString)[len] — len is an upper bound on the
    // code-point count; the vec's len field below carries the real count.
    { op: "local.get", index: LEN },
    { op: "array.new_default", typeIdx: nstrArrTypeIdx },
    { op: "local.set", index: OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: N },
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
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // cu = data[off + i]; take = 1
            { op: "local.get", index: DATA },
            { op: "local.get", index: OFF },
            { op: "local.get", index: I },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: CU },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: TAKE },

            // High surrogate with a following low surrogate → take = 2
            // (cu & 0xFC00) == 0xD800 && i + 1 < len
            { op: "local.get", index: CU },
            { op: "i32.const", value: 0xfc00 },
            { op: "i32.and" },
            { op: "i32.const", value: 0xd800 },
            { op: "i32.eq" },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: LEN },
            { op: "i32.lt_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // (data[off + i + 1] & 0xFC00) == 0xDC00 → take = 2
                { op: "local.get", index: DATA },
                { op: "local.get", index: OFF },
                { op: "local.get", index: I },
                { op: "i32.add" },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "array.get_u", typeIdx: strDataTypeIdx },
                { op: "i32.const", value: 0xfc00 },
                { op: "i32.and" },
                { op: "i32.const", value: 0xdc00 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 2 },
                    { op: "local.set", index: TAKE },
                  ],
                },
              ],
            },

            // out[n] = __str_substring(flat, i, i + take); n++; i += take
            { op: "local.get", index: OUT },
            { op: "local.get", index: N },
            { op: "local.get", index: FLAT },
            { op: "ref.as_non_null" },
            { op: "local.get", index: I },
            { op: "local.get", index: I },
            { op: "local.get", index: TAKE },
            { op: "i32.add" },
            { op: "call", funcIdx: substringIdx },
            { op: "array.set", typeIdx: nstrArrTypeIdx },
            { op: "local.get", index: N },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: N },
            { op: "local.get", index: I },
            { op: "local.get", index: TAKE },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return { len: n, data: out }
    { op: "local.get", index: N },
    { op: "local.get", index: OUT },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
  ];

  const typeIdx = addFuncType(ctx, [strRef], [{ kind: "ref", typeIdx: nstrVecTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__str_to_char_vec", funcIdx);
  ctx.funcMap.set("__str_to_char_vec", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_to_char_vec",
    typeIdx,
    locals: [
      { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "off", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "out", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "n", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "cu", type: { kind: "i32" } },
      { name: "take", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return { funcIdx, vecTypeIdx: nstrVecTypeIdx };
}

export function ensureNativeStringExternBridge(ctx: CodegenContext): void {
  ensureNativeStringHelpers(ctx);
  if (ctx.nativeStrExternBridgeEmitted) return;
  ctx.nativeStrExternBridgeEmitted = true;

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  if (ctx.mod.memories.length === 0) {
    ctx.mod.memories.push({ min: 1 });
    ctx.mod.exports.push({
      name: "__str_mem",
      desc: { kind: "memory", index: 0 },
    });
  }

  const importsBeforeBridge = ctx.numImportFuncs;
  const fromMemIdx = ensureLateImport(
    ctx,
    "__str_from_mem",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "externref" }],
  )!;
  const toMemIdx = ensureLateImport(ctx, "__str_to_mem", [{ kind: "externref" }, { kind: "i32" }], [])!;
  const externLenIdx = ensureLateImport(ctx, "__str_extern_len", [{ kind: "externref" }], [{ kind: "i32" }])!;
  // (#2934 slice 3) Close the deferred late-import batch BEFORE baking
  // `fromMemIdx`/`toMemIdx`/`externLenIdx` into the helper bodies below. The
  // deferred flush repairs STALE refs by bumping every `funcIdx >=
  // importsBefore` — it cannot distinguish a freshly-baked, already-final
  // import index (these three) from a stale defined-function ref, so leaving
  // the batch open until some later flush bumps the baked import refs onto
  // whatever defined function lands at that offset (`__str_to_extern`'s
  // `call __str_from_mem` resolved to `__str_copy_tree`, arity 3 — "not
  // enough arguments on the stack" for every object-with-own-toString string
  // coercion, S15.5.4.6_A4_T2). Flushing here settles all pre-batch stale
  // refs and makes the subsequent flush a no-op for this batch. Gated on
  // actually having REGISTERED imports (a funcMap-hit lookup is pure and must
  // not force-flush an outer batch), so already-registered paths are
  // byte-identical.
  if (ctx.numImportFuncs > importsBeforeBridge) {
    flushLateImportShifts(ctx, null);
  }

  {
    const typeIdx = addFuncType(ctx, [strRef], [{ kind: "externref" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_to_extern", funcIdx);
    ctx.funcMap.set("__str_to_extern", funcIdx);

    // The param is typed as the AnyString supertype, but the body reads
    // NativeString (FlatString) fields. We must flatten first: a ConsString /
    // Utf8String / template-literal result is NOT a NativeString, so reading
    // its fields via `struct.get NativeString` on the raw param produces an
    // invalid module (struct.get expected NativeString, found AnyString). For
    // an already-flat input __str_flatten is a cheap identity. (#1618 family —
    // surfaced by `process.stdout.write`/`console.log` of a template literal
    // under --target wasi, which emits this bridge.)
    //
    // __str_flatten via funcMap (NOT nativeStrHelpers): this body emits a `call
    // __str_flatten` after the three fd-bridge late imports above have been
    // queued, so the nativeStrHelpers index is stale-low (it's never rewritten by
    // the deferred shift). funcMap IS shift-maintained — __str_flatten is now
    // registered there too — so this resolves and shifts correctly. (#1618)
    const flattenIdx = ctx.funcMap.get("__str_flatten")!;
    const FLAT_LOCAL = 5;

    const body: Instr[] = [
      // flat = __str_flatten(s)  (locals[5])
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT_LOCAL },

      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
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
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.store16", align: 1, offset: 0 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: fromMemIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_to_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
        { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_from_extern", funcIdx);
    ctx.funcMap.set("__str_from_extern", funcIdx);

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: externLenIdx },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: toMemIdx },
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "i32.load16_u", align: 1, offset: 0 },
              { op: "array.set", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_from_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "arr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }
}

/**
 * Emit `__test_str_from_externref` and `__test_str_to_externref` exported
 * helpers (#1187). These are the test-runtime bridge that lets vitest tests
 * pass JS strings into Wasm exports whose native-string params have type
 * `(ref $AnyString)`, and read native-string results back as JS strings.
 *
 * Gated on `ctx.testRuntime && ctx.nativeStrings`. Production builds (with
 * `testRuntime` unset) never reach this code, so the helpers are absent
 * from the module entirely — zero runtime overhead.
 *
 * Preconditions (set up by the pre-pass in `generateModule`):
 *   - `addStringImports` has been called → `length`, `charCodeAt`, `concat`,
 *     `substring` are registered as `wasm:js-string` imports.
 *   - `String_fromCharCode` is registered as an `env` host import.
 *   - `ensureNativeStringHelpers` has been called → `__str_flatten` exists.
 */
export function emitTestRuntimeStringHelpers(ctx: CodegenContext): void {
  if (!ctx.testRuntime || !ctx.nativeStrings) return;
  if (ctx.testRuntimeStringHelpersEmitted) return;
  ctx.testRuntimeStringHelpersEmitted = true;

  // Make sure $__str_flatten exists. Called HERE rather than in the pre-pass
  // because emitting native-string helpers early causes a downstream
  // miscompile (the body references function indices that drift before
  // dead-elim runs). At this call site (after user code, before dead-elim)
  // index drift is impossible.
  ensureNativeStringHelpers(ctx);

  const mod = ctx.mod;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString (FlatString)
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // $AnyString

  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const externref: ValType = { kind: "externref" };

  // Resolve helper / import indices set up by the pre-pass.
  const lengthIdx = ctx.jsStringImports.get("length");
  const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
  const concatIdx = ctx.jsStringImports.get("concat");
  const substringIdx = ctx.jsStringImports.get("substring");
  const fromCharCodeIdx = ctx.funcMap.get("String_fromCharCode");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (
    lengthIdx === undefined ||
    charCodeAtIdx === undefined ||
    concatIdx === undefined ||
    substringIdx === undefined ||
    fromCharCodeIdx === undefined ||
    flattenIdx === undefined
  ) {
    // Pre-pass should have ensured these. Bail silently rather than emit a
    // module that won't validate — the test will fail noisily on missing
    // exports.
    return;
  }

  // ── __test_str_from_externref(externref s) -> (ref $AnyString) ──
  // Walks `s` char-by-char with `wasm:js-string.length` / `charCodeAt` and
  // builds a fresh `$NativeString` (subtype of `$AnyString`).
  //
  // params: s(0)
  // locals: len(1), data(2), i(3)
  {
    const typeIdx = addFuncType(ctx, [externref], [anyStrRef]);
    const funcIdx = mintDefinedFunc(ctx);

    const body: Instr[] = [
      // len = wasm:js-string.length(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lengthIdx },
      { op: "local.set", index: 1 },

      // data = array.new_default $__str_data(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // Outer block (target for the loop's break)
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break out of the surrounding block (depth 1)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // data[i] = wasm:js-string.charCodeAt(s, i)
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 3 },
              { op: "call", funcIdx: charCodeAtIdx },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i = i + 1
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },

              // continue loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // struct.new $NativeString(len, 0, data) — subtype-flows into ref $AnyString
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__test_str_from_externref",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({
      name: "__test_str_from_externref",
      desc: { kind: "func", index: funcIdx },
    });
  }

  // ── __test_str_to_externref((ref $AnyString) s) -> externref ──
  // Flattens to a `$NativeString`, then walks the data array and accumulates
  // a JS string via `wasm:js-string.concat` + `String_fromCharCode`. O(n²) by
  // string concatenation, but fine for the small strings used in tests.
  //
  // The result is seeded with an empty JS string via
  // `wasm:js-string.substring(<any>, 0, 0)` so the first concat has a string
  // operand even when len == 0.
  //
  // params: s(0)
  // locals: flat(1), len(2), off(3), result(4), i(5)
  {
    const typeIdx = addFuncType(ctx, [anyStrRef], [externref]);
    const funcIdx = mintDefinedFunc(ctx);

    const body: Instr[] = [
      // flat = __str_flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: 1 },

      // len = flat.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // off = flat.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // result = substring(String_fromCharCode(0.0), 0, 0) — gives "" as externref
      { op: "f64.const", value: 0 },
      { op: "call", funcIdx: fromCharCodeIdx },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: substringIdx },
      { op: "local.set", index: 4 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break (depth 1 = outer block)
              { op: "local.get", index: 5 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // result = concat(result, String_fromCharCode(data[off + i]))
              { op: "local.get", index: 4 }, // result

              { op: "local.get", index: 1 }, // flat
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
              { op: "local.get", index: 3 }, // off
              { op: "local.get", index: 5 }, // i
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: fromCharCodeIdx },

              { op: "call", funcIdx: concatIdx },
              { op: "local.set", index: 4 },

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

      // return result
      { op: "local.get", index: 4 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__test_str_to_externref",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "result", type: externref },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({
      name: "__test_str_to_externref",
      desc: { kind: "func", index: funcIdx },
    });
  }
}

/**
 * (#2962) Harness-readable exception rendering for standalone/WASI binaries —
 * the export pair that de-opaques the "uncaught Wasm-GC exception
 * (non-stringifiable payload)" bucket (~5.9k standalone baseline entries).
 *
 * A natively-thrown payload (an `$Error_struct`, a native string, a boxed
 * number, …) is a WasmGC value the HOST cannot stringify — `String(payload)`
 * throws `Cannot convert object to primitive value`, so the test262 harness
 * (`extractWasmExceptionMessage`) could only record the #2870 opaque label.
 * These exports let the harness render the payload with ZERO host imports,
 * following the same harness-support-export pattern as `__sget_*` / `__vec_*`:
 *
 *   - `__exn_render_prepare(payload: externref) -> i32` — runs the payload
 *     through the same `__any_to_string` chain the in-module `String(x)`
 *     coercion uses (so an `$Error_struct` renders `"TypeError: boom"` via
 *     `__error_to_string`, §20.5.3.4), flattens the result, stashes it in a
 *     module global, and returns its code-unit length (`-1` for a null
 *     payload — the harness keeps its legacy label).
 *   - `__exn_render_char(i: i32) -> i32` — code-unit readback from the
 *     prepared buffer (`0` when unprepared / out of range).
 *
 * Emitted at finalize (see the `emitExceptionRenderExports` call in
 * codegen/index.ts) and gated on `(standalone || wasi) && nativeStrings &&
 * exnTagIdx >= 0` — a module that cannot throw through the `$exc` tag gets
 * neither export nor the string-runtime pull-in, keeping non-throwing modules
 * byte-identical. JS-host binaries are untouched (payloads there are real JS
 * values the host formats directly).
 *
 * Index-shift safety: both dependencies (`__any_to_string`, `__str_flatten`)
 * are ensured/read from the authoritative `funcMap`/`nativeStrHelpers` BEFORE
 * either body is built, and both functions are pushed with no intervening
 * helper emission or import registration.
 */
export function emitExceptionRenderExports(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (!ctx.nativeStrings) return;
  if (ctx.exnTagIdx < 0) return;
  if (ctx.funcMap.has("__exn_render_prepare")) return;

  // (#2969) Force `number_toString` before `__any_to_string` bakes so its number
  // arm renders a raw thrown number ("42") instead of degrading to
  // "[object Object]" — a throwing module that never itself stringifies a number
  // otherwise leaves the arm unresolved. `emitExceptionRenderExports` is the
  // first (and here, only) consumer of `__any_to_string` for such a module, so
  // ensuring the format helper ahead of the `ensureAnyToStringHelper` call below
  // makes the number arm real. Size cost falls only on throwing standalone/WASI
  // modules. Must precede the ensure call (which snapshots the number_toString
  // funcIdx into the baked arm).
  if (ctx.funcMap.get("number_toString") === undefined) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }

  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  const flatTypeIdx = ctx.nativeStrTypeIdx;
  const dataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (anyToStrIdx === undefined || flattenIdx === undefined || flatTypeIdx < 0 || dataTypeIdx < 0) return;

  const mod = ctx.mod;

  // (mut ref null $NativeString) — the prepared render buffer.
  const bufGlobalIdx = ctx.numImportGlobals + mod.globals.length;
  mod.globals.push({
    name: "__exn_render_buf",
    type: { kind: "ref_null", typeIdx: flatTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: flatTypeIdx }],
  });

  // __exn_render_prepare(payload: externref) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$exn_render_prepare_type");
    const funcIdx = mintDefinedFunc(ctx);
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "call", funcIdx: anyToStrIdx },
      { op: "call", funcIdx: flattenIdx },
      { op: "global.set", index: bufGlobalIdx },
      { op: "global.get", index: bufGlobalIdx },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
    ];
    ctx.funcMap.set("__exn_render_prepare", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__exn_render_prepare",
      typeIdx,
      locals: [],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__exn_render_prepare", desc: { kind: "func", index: funcIdx } });
  }

  // __exn_render_char(i: i32) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$exn_render_char_type");
    const funcIdx = mintDefinedFunc(ctx);
    const L_I = 0;
    const L_BUF = 1;
    const body: Instr[] = [
      { op: "global.get", index: bufGlobalIdx },
      { op: "local.tee", index: L_BUF },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // i < 0 || i >= len → 0
      { op: "local.get", index: L_I },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: L_I },
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // data[off + i]
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 2 }, // data
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 1 }, // off
      { op: "local.get", index: L_I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: dataTypeIdx },
    ];
    ctx.funcMap.set("__exn_render_char", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__exn_render_char",
      typeIdx,
      locals: [{ name: "buf", type: { kind: "ref_null", typeIdx: flatTypeIdx } }],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__exn_render_char", desc: { kind: "func", index: funcIdx } });
  }
}
