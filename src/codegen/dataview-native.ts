// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native (standalone / WASI) DataView and ArrayBuffer-backed TypedArray
 * support (#1654).
 *
 * In JS-host mode, DataView.prototype.{get,set}{Uint,Int,Float}* are
 * implemented by the JS runtime, which materializes a real `DataView` over the
 * WasmGC byte array (`__dv_byte_{get,set}` exports, see codegen/index.ts).
 *
 * In no-JS-host mode (`--target wasi` / `--target standalone`) there is no JS
 * runtime, so those accessors had no implementation and the compiler silently
 * dropped the call (writing nothing, reading garbage) — and the
 * ArrayBuffer-length RangeError path referenced a `global.get -1` sentinel,
 * producing an *invalid* module (`unknown global`).
 *
 * This module emits Wasm-native byte read/write directly into the `i32_byte`
 * vec struct that backs ArrayBuffer / DataView (field 0 = length i32, field 1 =
 * a PACKED `array(mut i8)`, one byte per element, values 0..255). Multi-byte
 * accessors honour the `littleEndian` flag at runtime.
 *
 * Backing-store representation:
 *   ArrayBuffer / DataView  → vec "i32_byte"  (packed i8, one byte per element)
 *   Uint8Array (native)     → vec "i8_byte"   (packed bytes, unsigned reads)
 *
 * (#2835) The `i32_byte` byte buffer is now backed by `array(mut i8)` (was
 * `array(mut i32)`) — a 4× GC-footprint cut for ArrayBuffer / DataView. The KEY
 * string is kept (`$__vec_i32_byte`, a type DISTINCT from Uint8Array's
 * `i8_byte`, so `ref.cast`-based DataView/ArrayBuffer dispatch stays
 * unambiguous), only the element type changed. Byte READS therefore MUST use
 * `array.get_u` (plain `array.get` is invalid Wasm on a packed array); the
 * assembled value is zero-extended, so the DataView accessor's own
 * sign-extension (`getInt8`/`getInt16`/…) is unaffected. WRITES use `array.set`,
 * which truncates the i32 to the low byte (the `& 0xff` masks become redundant
 * but are kept defensively).
 *
 * The receiver (`this`) of a DataView accessor is an externref holding the
 * i32_byte vec; we `any.convert_extern` + `ref.cast` to recover the struct.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./expressions/helpers.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./index.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { getOrRegisterResizableAbType, getOrRegisterTaViewType, getTaViewName } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** DataView accessor descriptor parsed from a method name like "getUint32". */
interface DvAccessor {
  kind: "get" | "set";
  /** Number of bytes the element occupies (1, 2, 4, 8). */
  bytes: number;
  /** Signed integer read (Int8/Int16/Int32) — sign-extend on read. */
  signed: boolean;
  /** Float element (Float32/Float64) — reinterpret bits. */
  float: boolean;
}

const DV_ACCESSORS: Record<string, DvAccessor> = {
  getInt8: { kind: "get", bytes: 1, signed: true, float: false },
  getUint8: { kind: "get", bytes: 1, signed: false, float: false },
  getInt16: { kind: "get", bytes: 2, signed: true, float: false },
  getUint16: { kind: "get", bytes: 2, signed: false, float: false },
  getInt32: { kind: "get", bytes: 4, signed: true, float: false },
  getUint32: { kind: "get", bytes: 4, signed: false, float: false },
  getFloat32: { kind: "get", bytes: 4, signed: false, float: true },
  getFloat64: { kind: "get", bytes: 8, signed: false, float: true },
  setInt8: { kind: "set", bytes: 1, signed: true, float: false },
  setUint8: { kind: "set", bytes: 1, signed: false, float: false },
  setInt16: { kind: "set", bytes: 2, signed: true, float: false },
  setUint16: { kind: "set", bytes: 2, signed: false, float: false },
  setInt32: { kind: "set", bytes: 4, signed: true, float: false },
  setUint32: { kind: "set", bytes: 4, signed: false, float: false },
  setFloat32: { kind: "set", bytes: 4, signed: false, float: true },
  setFloat64: { kind: "set", bytes: 8, signed: false, float: true },
};

export function isDataViewAccessor(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DV_ACCESSORS, name);
}

/**
 * #1698 — `ab.slice(begin?, end?)` in no-JS-host mode. Returns a new
 * ArrayBuffer (i32_byte vec struct) holding bytes `[begin, end)` of the
 * source, with the spec §25.1.5.3 negative-offset / clamp / default-end
 * normalisation applied at runtime. Receiver and result are externref
 * (the user's `const sliced = ab.slice(...)` local is typed externref;
 * matching that here keeps `new Uint8Array(sliced)` working without
 * additional coercion).
 */
export function emitArrayBufferSlice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }); // (#2835) packed byte buffer
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return null;

  // Recover the source vec struct from the receiver (externref → struct).
  const srcVecLocal = allocLocal(fctx, `__abs_src_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: vecTypeIdx,
  });
  const recvType = compileExpr(receiver);
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
  } else if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
    if ("typeIdx" in recvType && recvType.typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
    }
  } else {
    return null;
  }
  fctx.body.push({ op: "local.set", index: srcVecLocal } as Instr);

  // srcLen = src.length (field 0); srcArr = src.data (field 1).
  const srcLenLocal = allocLocal(fctx, `__abs_srclen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: srcVecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: srcLenLocal } as Instr);
  const srcArrLocal = allocLocal(fctx, `__abs_srcarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: srcVecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: srcArrLocal } as Instr);

  // begin (default 0). Spec §25.1.5.3 steps 5-7: ToIntegerOrInfinity, then
  // negative = max(srcLen + begin, 0), positive = min(begin, srcLen).
  const beginLocal = allocLocal(fctx, `__abs_begin_${fctx.locals.length}`, { kind: "i32" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: beginLocal } as Instr);
  emitNormalizeIndex(fctx, beginLocal, srcLenLocal);

  // end (default srcLen). Same clamp/negate.
  const endLocal = allocLocal(fctx, `__abs_end_${fctx.locals.length}`, { kind: "i32" });
  if (args.length >= 2) {
    compileExpr(args[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    fctx.body.push({ op: "local.set", index: endLocal } as Instr);
    emitNormalizeIndex(fctx, endLocal, srcLenLocal);
  } else {
    fctx.body.push({ op: "local.get", index: srcLenLocal } as Instr);
    fctx.body.push({ op: "local.set", index: endLocal } as Instr);
  }

  // sliceLen = max(end - begin, 0)
  const sliceLenLocal = allocLocal(fctx, `__abs_slen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: endLocal } as Instr);
  fctx.body.push({ op: "local.get", index: beginLocal } as Instr);
  fctx.body.push({ op: "i32.sub" } as Instr);
  fctx.body.push({ op: "local.set", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "local.get", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: sliceLenLocal } as Instr],
    else: [],
  });

  // dstArr = new i32[sliceLen]
  const dstArrLocal = allocLocal(fctx, `__abs_dstarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: dstArrLocal } as Instr);

  // for (i = 0; i < sliceLen; i++) dstArr[i] = srcArr[begin + i]
  const iLocal = allocLocal(fctx, `__abs_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: iLocal } as Instr);
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: sliceLenLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    { op: "local.get", index: dstArrLocal } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: srcArrLocal } as Instr,
    { op: "local.get", index: beginLocal } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "i32.add" } as Instr,
    // (#2835) packed i8 src/dst; read unsigned, `array.set` truncates to low byte.
    { op: "array.get_u", typeIdx: arrTypeIdx } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iLocal } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);

  // struct.new vec(sliceLen, dstArr); return as externref (matches the
  // externref local that user code declares for the slice() result).
  fctx.body.push({ op: "local.get", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "local.get", index: dstArrLocal } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx } as Instr);
  fctx.body.push({ op: "extern.convert_any" } as Instr);
  return { kind: "externref" };
}

/**
 * (#3054 C) `rab.resize(newByteLength)` in no-JS-host mode, per §25.1.6.
 * `resize` exists only on a resizable buffer (a `$__resizable_ab` instance):
 *   1. If the receiver is NOT a `$__resizable_ab` (a fixed buffer / anything
 *      else) → TypeError (§25.1.6.1 step 3, IsFixedLengthArrayBuffer).
 *   2. newByteLength = ToIndex(arg); if `newByteLength > maxByteLength` (or < 0)
 *      → RangeError (step 6).
 *   3. Reallocate: `array.new_default $__arr_i32_byte` of size `newByteLength`,
 *      `array.copy` `min(oldLen, newLen)` bytes from the old data, then
 *      `struct.set field1` (swap `data` in place on the SAME struct) and
 *      `struct.set field0` (new byteLength). Views hold the vec-struct ref, so
 *      they observe the swap → length-tracking-on-resize is free (Phase A A.1).
 * Returns undefined (`resize` is a void method) — the caller drops nothing.
 */
export function emitArrayBufferResize(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const rabTypeIdx = getOrRegisterResizableAbType(ctx);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }));
  if (arrTypeIdx < 0) return null;

  // Recover the receiver as anyref, then require it to be a $__resizable_ab.
  const recvType = compileExpr(receiver);
  if (recvType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
  } else if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    return null;
  }
  const anyLocal = allocLocal(fctx, `__rabz_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal } as Instr);

  // TypeError on a non-resizable receiver (IsFixedLengthArrayBuffer).
  fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx } as Instr);
  fctx.body.push({ op: "i32.eqz" } as Instr);
  {
    const msg = "TypeError: ArrayBuffer.prototype.resize called on non-resizable buffer";
    addStringConstantGlobal(ctx, msg);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [...stringConstantExternrefInstrs(ctx, msg), { op: "throw", tagIdx } as Instr],
      else: [],
    } as Instr);
  }

  // rab = ref.cast $__resizable_ab (the checked receiver).
  const rabLocal = allocLocal(fctx, `__rabz_rab_${fctx.locals.length}`, { kind: "ref", typeIdx: rabTypeIdx });
  fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: rabTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: rabLocal } as Instr);

  // newLen = ToIndex(arg): NaN→0, truncate toward zero.
  const newLenF64 = allocLocal(fctx, `__rabz_nl_f64_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: newLenF64 } as Instr);
  // NaN → 0
  fctx.body.push({ op: "local.get", index: newLenF64 } as Instr);
  fctx.body.push({ op: "local.get", index: newLenF64 } as Instr);
  fctx.body.push({ op: "f64.ne" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: newLenF64 } as Instr],
    else: [],
  } as Instr);
  fctx.body.push({ op: "local.get", index: newLenF64 } as Instr);
  fctx.body.push({ op: "f64.trunc" } as Instr);
  fctx.body.push({ op: "local.set", index: newLenF64 } as Instr);
  const newLen = allocLocal(fctx, `__rabz_nl_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: newLenF64 } as Instr);
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "local.set", index: newLen } as Instr);

  // RangeError if newLen < 0 OR newLen > maxByteLength (field 2).
  fctx.body.push({ op: "local.get", index: newLen } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  fctx.body.push({ op: "local.get", index: newLen } as Instr);
  fctx.body.push({ op: "local.get", index: rabLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 } as Instr);
  fctx.body.push({ op: "i32.gt_s" } as Instr);
  fctx.body.push({ op: "i32.or" } as Instr);
  {
    const msg = "RangeError: ArrayBuffer.prototype.resize length exceeds maxByteLength";
    addStringConstantGlobal(ctx, msg);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [...stringConstantExternrefInstrs(ctx, msg), { op: "throw", tagIdx } as Instr],
      else: [],
    } as Instr);
  }

  // oldLen = min(rab.length, newLen) — bytes to preserve.
  const oldLen = allocLocal(fctx, `__rabz_ol_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: rabLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: oldLen } as Instr);
  const copyLen = allocLocal(fctx, `__rabz_cl_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: oldLen } as Instr);
  fctx.body.push({ op: "local.get", index: newLen } as Instr);
  fctx.body.push({ op: "local.get", index: oldLen } as Instr);
  fctx.body.push({ op: "local.get", index: newLen } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  fctx.body.push({ op: "select" } as Instr);
  fctx.body.push({ op: "local.set", index: copyLen } as Instr);

  // newArr = new i8[newLen]; array.copy newArr[0..copyLen) ← rab.data[0..copyLen).
  const newArr = allocLocal(fctx, `__rabz_na_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: newLen } as Instr);
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: newArr } as Instr);
  // array.copy dst dstIdx src srcIdx len
  fctx.body.push({ op: "local.get", index: newArr } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: rabLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: copyLen } as Instr);
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

  // struct.set field1 = newArr; struct.set field0 = newLen (same struct → views observe).
  fctx.body.push({ op: "local.get", index: rabLocal } as Instr);
  fctx.body.push({ op: "local.get", index: newArr } as Instr);
  fctx.body.push({ op: "struct.set", typeIdx: rabTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.get", index: rabLocal } as Instr);
  fctx.body.push({ op: "local.get", index: newLen } as Instr);
  fctx.body.push({ op: "struct.set", typeIdx: rabTypeIdx, fieldIdx: 0 } as Instr);

  return null;
}

/**
 * Normalize an index in-place per spec §25.1.5.3:
 *   if (idx < 0) idx = max(srcLen + idx, 0);
 *   else         idx = min(idx, srcLen);
 */
function emitNormalizeIndex(fctx: FunctionContext, idxLocal: number, lenLocal: number): void {
  fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  const negBranch: Instr[] = [
    // idx = srcLen + idx; if (idx < 0) idx = 0
    { op: "local.get", index: lenLocal } as Instr,
    { op: "local.get", index: idxLocal } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: idxLocal } as Instr,
    { op: "local.get", index: idxLocal } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: idxLocal } as Instr],
      else: [],
    },
  ];
  const posBranch: Instr[] = [
    // if (idx > srcLen) idx = srcLen
    { op: "local.get", index: idxLocal } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "i32.gt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: lenLocal } as Instr, { op: "local.set", index: idxLocal } as Instr],
      else: [],
    },
  ];
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: negBranch,
    else: posBranch,
  });
}

/** Lazily ensure the i32_byte vec type exists and return its struct/array indices. */
function i32ByteVec(ctx: CodegenContext): { vecTypeIdx: number; arrTypeIdx: number } {
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }); // (#2835) packed byte buffer
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  return { vecTypeIdx, arrTypeIdx };
}

/**
 * (#2159 / #38) Lazily register the standalone `$__dv_window` wrapper struct:
 * `{buf: (ref null __vec_i32_byte), byteOffset: i32, byteLength: i32}`.
 *
 * `new DataView(buffer, byteOffset, byteLength)` produces one of these when the
 * view is *windowed* (byteOffset > 0 or an explicit byteLength); it shares the
 * parent buffer's backing array so windowed writes are visible through the full
 * view, and carries the window's byteOffset/byteLength so `dv.byteOffset` /
 * `dv.byteLength` reflect the ctor args. Offset-0 default-length views keep the
 * bare i32_byte vec representation (no wrapper) — the dominant, fully-native
 * case — so the accessor must accept BOTH a wrapper and a bare vec receiver.
 */
export function getOrRegisterDvWindowType(ctx: CodegenContext): number {
  if (ctx.dvWindowTypeIdx >= 0) return ctx.dvWindowTypeIdx;
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }); // (#2835) packed byte buffer
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__dv_window",
    fields: [
      { name: "buf", type: { kind: "ref_null", typeIdx: vecTypeIdx }, mutable: false },
      { name: "byteOffset", type: { kind: "i32" }, mutable: false },
      { name: "byteLength", type: { kind: "i32" }, mutable: false },
    ],
  });
  ctx.dvWindowTypeIdx = idx;
  ctx.structMap.set("__dv_window", idx);
  ctx.typeIdxToStructName.set(idx, "__dv_window");
  ctx.structFields.set("__dv_window", [
    { name: "buf", type: { kind: "ref_null" as const, typeIdx: vecTypeIdx }, mutable: false },
    { name: "byteOffset", type: { kind: "i32" as const }, mutable: false },
    { name: "byteLength", type: { kind: "i32" as const }, mutable: false },
  ]);
  return idx;
}

/**
 * (#2159 / #38) Recover a DataView receiver into `(backing i32_byte array,
 * base byte offset)`, stashed in the two given locals. Accepts either:
 *   - a `$__dv_window` wrapper (windowed view) → array = buf.data, base = buf's
 *     byteOffset;
 *   - a bare `$__vec_i32_byte` (offset-0 view / ArrayBuffer) → array = data,
 *     base = 0.
 * The receiver value (externref or struct ref) must already be on the stack.
 * Emits a runtime `ref.test $__dv_window` branch so both shapes work.
 */
function recoverDvBacking(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvType: ValType | null,
  arrLocal: number,
  baseLocal: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  // (#2199) Optional: i32 local that receives the view's byte length (window's
  // `byteLength` field for a windowed view; the backing array's `array.len` for
  // a bare offset-0 view). Used by the §24.2.1.1 bounds check. Pass -1 to skip.
  viewLenLocal = -1,
): boolean {
  const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
  // Normalize the receiver to an anyref-castable `(ref any)` on the stack.
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
  } else if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
    // already a gc ref
  } else {
    return false;
  }
  // Stash the anyref in a temp so we can test then cast.
  const anyLocal = allocLocal(fctx, `__dvn_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal } as Instr);

  const winBranch: Instr[] = [
    // buf = (cast $__dv_window).buf ; base = .byteOffset
    { op: "local.get", index: anyLocal } as Instr,
    { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 } as Instr,
    { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: arrLocal } as Instr,
    { op: "local.get", index: anyLocal } as Instr,
    { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: baseLocal } as Instr,
  ];
  if (viewLenLocal >= 0) {
    // viewLen = (cast $__dv_window).byteLength
    winBranch.push(
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
      { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 2 } as Instr,
      { op: "local.set", index: viewLenLocal } as Instr,
    );
  }
  const vecBranch: Instr[] = [
    // bare vec: arr = .data ; base = 0
    { op: "local.get", index: anyLocal } as Instr,
    { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: arrLocal } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: baseLocal } as Instr,
  ];
  if (viewLenLocal >= 0) {
    // viewLen = array.len(arr)  (offset-0 view spans the whole backing buffer)
    vecBranch.push(
      { op: "local.get", index: arrLocal } as Instr,
      { op: "array.len" } as Instr,
      { op: "local.set", index: viewLenLocal } as Instr,
    );
  }
  fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx } as Instr);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: winBranch, else: vecBranch } as Instr);
  void arrTypeIdx;
  return true;
}

/**
 * Emit native code for `dv.{get,set}{Uint,Int,Float}N(byteOffset[, value][, littleEndian])`
 * operating directly on the i32_byte backing array.
 *
 * Preconditions on the Wasm stack: nothing (this function compiles all operands).
 * Postcondition: for getters, the numeric result (f64) is on the stack; for
 * setters, nothing is pushed (void).
 *
 * Returns the result ValType for getters, or null for setters (void).
 *
 * `compileExpr`/`offsetArg`/`valueArg`/`leArg` are passed in so this module
 * stays decoupled from the big calls.ts dispatcher.
 */
/** Message for the §24.2.1.1 GetViewValue / SetViewValue out-of-bounds throw. */
const DV_RANGE_MESSAGE = "RangeError: Offset is outside the bounds of the DataView";

/**
 * (#2199) Build the instruction sequence for a DataView accessor bounds throw —
 * a catchable `RangeError` instance via the shared `$exc` tag, mirroring
 * `native-regex.ts`'s `regexCapExhaustionThrow`. §24.2.1.1 GetViewValue step 4/6
 * (and SetViewValue): a negative / non-finite `byteOffset`, or
 * `getIndex + elementSize > viewByteLength`, throws RangeError BEFORE the array
 * access (which would otherwise trap `array element access out of bounds`).
 *
 * MUST be called BEFORE any later funcIdx is captured in the caller: in JS-host
 * mode `ensureLateImport("__new_RangeError")` registers a host import (shifting
 * every function index); in no-JS-host mode `emitWasiErrorConstructor` emits the
 * in-module constructor (also a function push). Same ordering requirement as the
 * regex cap-throw. The caller pre-builds this template before emitting the
 * accessor body and flushes shifts.
 */
function emitDataViewRangeError(ctx: CodegenContext): Instr[] {
  if (noJsHost(ctx)) emitWasiErrorConstructor(ctx, "RangeError", 1);
  addStringConstantGlobal(ctx, DV_RANGE_MESSAGE);
  const ctorIdx = ensureLateImport(ctx, "__new_RangeError", [{ kind: "externref" }], [{ kind: "externref" }]);
  const tagIdx = ensureExnTag(ctx);
  const instrs: Instr[] = [...stringConstantExternrefInstrs(ctx, DV_RANGE_MESSAGE)];
  if (ctorIdx !== undefined) instrs.push({ op: "call", funcIdx: ctorIdx } as Instr);
  instrs.push({ op: "throw", tagIdx } as Instr);
  return instrs;
}

export function emitDataViewAccessor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  receiver: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): { kind: "get"; result: ValType } | { kind: "set" } | null {
  const acc = DV_ACCESSORS[methodName];
  if (!acc) return null;

  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  if (arrTypeIdx < 0) return null;

  // (#2199) Pre-build the §24.2.1.1 out-of-bounds RangeError template FIRST.
  // `emitDataViewRangeError` registers `__new_RangeError` as a late import (and
  // in no-JS-host mode emits the in-module constructor) — both push a function,
  // shifting every funcIdx. Building + flushing it before any operand compile or
  // backing-recovery keeps later funcIdx captures correct (same ordering rule as
  // native-regex's cap-throw). When `dv.byteLength` is unavailable we skip the
  // bounds check, so only register the template when we will emit it.
  const rangeThrow = emitDataViewRangeError(ctx);
  flushLateImportShifts(ctx, fctx);

  // Recover the i32_byte backing array AND the view's base byte offset from the
  // receiver. `dv` may be a `$__dv_window` wrapper (windowed view → base =
  // ctor byteOffset, sharing the parent's array) or a bare `$__vec_i32_byte`
  // (offset-0 view / ArrayBuffer → base = 0). (#2159/#38). `viewLenLocal`
  // receives the view's byte length for the #2199 bounds check.
  const arrLocal = allocLocal(fctx, `__dvn_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const baseLocal = allocLocal(fctx, `__dvn_base_${fctx.locals.length}`, { kind: "i32" });
  const viewLenLocal = allocLocal(fctx, `__dvn_vlen_${fctx.locals.length}`, { kind: "i32" });
  const recvType = compileExpr(receiver);
  if (!recoverDvBacking(ctx, fctx, recvType, arrLocal, baseLocal, vecTypeIdx, arrTypeIdx, viewLenLocal)) {
    return null;
  }

  // byteOffset (arg 0) → §24.2.1.1 GetViewValue: ToIndex(requestIndex) then the
  // `getIndex + elementSize > viewByteLength` bounds check, both throwing
  // RangeError BEFORE any access. Capture the f64 request, derive the i32
  // getIndex (the *view-relative* index, before adding base), then guard.
  const reqLocal = allocLocal(fctx, `__dvn_req_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: reqLocal });

  const getIdxLocal = allocLocal(fctx, `__dvn_gidx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: reqLocal } as Instr);
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "local.set", index: getIdxLocal });

  // (#2199b) The two §24.2.1.2 SetViewValue / §24.2.1.1 GetViewValue throws fire
  // at DIFFERENT points relative to `ToNumber(value)` for a setter:
  //   - INDEX throw (step 4, ToIndex): `isNaN(req) || getIndex < 0` — fires
  //     BEFORE `ToNumber(value)` (test: index-check-before-value-conversion).
  //   - BOUNDS throw (step 8): `getIndex + elementSize > viewByteLength` — fires
  //     AFTER `ToNumber(value)` runs (test: range-check-after-value-conversion;
  //     a `value` whose valueOf/Symbol throws must throw FIRST). i64 math so the
  //     +Infinity-saturated `getIndex=i32.MAX` + bytes can't overflow.
  const emitIndexThrow = (): void => {
    fctx.body.push({ op: "local.get", index: reqLocal } as Instr);
    fctx.body.push({ op: "local.get", index: reqLocal } as Instr);
    fctx.body.push({ op: "f64.ne" } as Instr); // req != req  (NaN)
    fctx.body.push({ op: "local.get", index: getIdxLocal } as Instr);
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
    fctx.body.push({ op: "i32.lt_s" } as Instr); // getIndex < 0
    fctx.body.push({ op: "i32.or" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] } as Instr);
  };
  const emitBoundsThrow = (): void => {
    fctx.body.push({ op: "local.get", index: getIdxLocal } as Instr);
    fctx.body.push({ op: "i64.extend_i32_s" } as Instr);
    fctx.body.push({ op: "i64.const", value: BigInt(acc.bytes) } as Instr);
    fctx.body.push({ op: "i64.add" } as Instr);
    fctx.body.push({ op: "local.get", index: viewLenLocal } as Instr);
    fctx.body.push({ op: "i64.extend_i32_s" } as Instr);
    fctx.body.push({ op: "i64.gt_s" } as Instr); // (getIndex + bytes) > viewLen
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] } as Instr);
  };

  // off = getIndex + base (absolute byte in the shared buffer). Computed after
  // the bounds throw at each call site.
  const offLocal = allocLocal(fctx, `__dvn_off_${fctx.locals.length}`, { kind: "i32" });
  const setOff = (): void => {
    fctx.body.push({ op: "local.get", index: getIdxLocal } as Instr);
    fctx.body.push({ op: "local.get", index: baseLocal } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
    fctx.body.push({ op: "local.set", index: offLocal });
  };

  if (acc.kind === "get") {
    // Getter has no value to convert, so both throws are adjacent (ToIndex then
    // bounds), before the read. littleEndian is the 2nd arg.
    emitIndexThrow();
    emitBoundsThrow();
    setOff();
    const leLocal = emitLittleEndianFlag(ctx, fctx, args[1], compileExpr);
    emitReadBytes(ctx, fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    return { kind: "get", result: { kind: "f64" } };
  }

  // Setter: ToIndex throw → ToNumber(value) (+littleEndian) → bounds throw →
  // write. Compiling the value/le runs their valueOf/Symbol coercions, which can
  // throw and MUST do so after the index check but before the bounds check.
  emitIndexThrow();
  const valLocal = allocLocal(fctx, `__dvn_val_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 2) {
    compileExpr(args[1]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: valLocal });
  const leLocal = emitLittleEndianFlag(ctx, fctx, args[2], compileExpr);
  emitBoundsThrow();
  setOff();
  emitWriteBytes(ctx, fctx, acc, arrLocal, offLocal, valLocal, leLocal, arrTypeIdx);
  return { kind: "set" };
}

/**
 * Compile the optional `littleEndian` argument into an i32 local (0 = big
 * endian, 1 = little endian). When absent, defaults to 0 (big endian) per the
 * DataView spec. The argument is `boolean`; truthiness is captured via the
 * standard i32 boolean lowering.
 */
function emitLittleEndianFlag(
  ctx: CodegenContext,
  fctx: FunctionContext,
  leArg: import("../ts-api.js").ts.Expression | undefined,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): number {
  const leLocal = allocLocal(fctx, `__dvn_le_${fctx.locals.length}`, { kind: "i32" });
  if (leArg) {
    const t = compileExpr(leArg, { kind: "i32" });
    // If the boolean compiled to f64 (boxed), normalize to i32 truthiness.
    if (t && t.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 } as Instr);
      fctx.body.push({ op: "f64.ne" } as Instr);
    } else if (t && t.kind !== "i32") {
      // Non-i32, non-f64 (e.g. externref) — drop and default to big endian.
      fctx.body.push({ op: "drop" } as Instr);
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: leLocal });
  return leLocal;
}

/** Push `arr[off + k]` (unsigned byte 0..255) as i32. */
function pushByte(fctx: FunctionContext, arrLocal: number, offLocal: number, k: number, arrTypeIdx: number): void {
  fctx.body.push({ op: "local.get", index: arrLocal } as Instr);
  fctx.body.push({ op: "local.get", index: offLocal } as Instr);
  if (k !== 0) {
    fctx.body.push({ op: "i32.const", value: k } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
  }
  // (#2835) Packed `i8` backing → unsigned zero-extended read (plain `array.get`
  // is invalid on a packed array). Result already in [0,255].
  fctx.body.push({ op: "array.get_u", typeIdx: arrTypeIdx } as Instr);
  // Mask to a byte — `array.get_u` already yields 0..255, but defensively
  // keep only the low 8 bits so sign/overflow can't leak in.
  fctx.body.push({ op: "i32.const", value: 0xff } as Instr);
  fctx.body.push({ op: "i32.and" } as Instr);
}

/**
 * Assemble the N bytes into an i32 (for <=4 byte ints / Float32) or an i64
 * (for Float64), honouring endianness, then convert to the f64 result.
 */
function emitReadBytes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  acc: DvAccessor,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  if (acc.bytes === 1) {
    pushByte(fctx, arrLocal, offLocal, 0, arrTypeIdx);
    if (acc.signed) {
      // sign-extend an 8-bit value: (x << 24) >> 24
      fctx.body.push({ op: "i32.const", value: 24 } as Instr);
      fctx.body.push({ op: "i32.shl" } as Instr);
      fctx.body.push({ op: "i32.const", value: 24 } as Instr);
      fctx.body.push({ op: "i32.shr_s" } as Instr);
      fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    } else {
      fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
    }
    return;
  }

  if (acc.bytes === 8) {
    // Float64 only — assemble an i64 then f64.reinterpret_i64.
    emitReadI64(fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    fctx.body.push({ op: "f64.reinterpret_i64" } as Instr);
    return;
  }

  // 2 or 4 byte values — assemble an i32 with a runtime endianness branch.
  // Result i32 is left on the stack, then converted to f64.
  emitReadI32(fctx, acc.bytes, arrLocal, offLocal, leLocal, arrTypeIdx);

  if (acc.float) {
    // Float32: reinterpret the 32-bit pattern, then promote to f64.
    fctx.body.push({ op: "f32.reinterpret_i32" } as Instr);
    fctx.body.push({ op: "f64.promote_f32" } as Instr);
    return;
  }

  if (acc.signed) {
    if (acc.bytes === 2) {
      // sign-extend 16-bit: (x << 16) >> 16
      fctx.body.push({ op: "i32.const", value: 16 } as Instr);
      fctx.body.push({ op: "i32.shl" } as Instr);
      fctx.body.push({ op: "i32.const", value: 16 } as Instr);
      fctx.body.push({ op: "i32.shr_s" } as Instr);
    }
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  } else {
    fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
  }
}

/**
 * Assemble a 2- or 4-byte little/big-endian integer into an i32 on the stack.
 * Emits a runtime branch on `leLocal`.
 */
function emitReadI32(
  fctx: FunctionContext,
  bytes: number,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  // little-endian assembly: b0 | b1<<8 | b2<<16 | b3<<24
  const leInstrs: Instr[] = [];
  buildIntoBranch(leInstrs, fctx, bytes, arrLocal, offLocal, arrTypeIdx, /*little*/ true);
  const beInstrs: Instr[] = [];
  buildIntoBranch(beInstrs, fctx, bytes, arrLocal, offLocal, arrTypeIdx, /*little*/ false);

  fctx.body.push({ op: "local.get", index: leLocal } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: leInstrs,
    else: beInstrs,
  });
}

/**
 * Build the byte-assembly instructions for one endianness into `out`.
 * The assembly does not reference `fctx.body`; it composes a self-contained
 * Instr[] that pushes a single i32.
 */
function buildIntoBranch(
  out: Instr[],
  _fctx: FunctionContext,
  bytes: number,
  arrLocal: number,
  offLocal: number,
  arrTypeIdx: number,
  little: boolean,
): void {
  const byteAt = (k: number): Instr[] => {
    const seq: Instr[] = [{ op: "local.get", index: arrLocal } as Instr, { op: "local.get", index: offLocal } as Instr];
    if (k !== 0) {
      seq.push({ op: "i32.const", value: k } as Instr);
      seq.push({ op: "i32.add" } as Instr);
    }
    seq.push({ op: "array.get_u", typeIdx: arrTypeIdx } as Instr); // (#2835) packed i8 byte read
    seq.push({ op: "i32.const", value: 0xff } as Instr);
    seq.push({ op: "i32.and" } as Instr);
    return seq;
  };

  // Accumulate: for each byte k (0..bytes-1), shift = little ? k*8 : (bytes-1-k)*8
  for (let k = 0; k < bytes; k++) {
    const shift = little ? k * 8 : (bytes - 1 - k) * 8;
    out.push(...byteAt(k));
    if (shift !== 0) {
      out.push({ op: "i32.const", value: shift } as Instr);
      out.push({ op: "i32.shl" } as Instr);
    }
    if (k > 0) out.push({ op: "i32.or" } as Instr);
  }
}

/** Assemble an 8-byte little/big-endian value into an i64 on the stack. */
function emitReadI64(
  fctx: FunctionContext,
  _acc: DvAccessor,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  const build = (little: boolean): Instr[] => {
    const out: Instr[] = [];
    const byteAt = (k: number): Instr[] => {
      const seq: Instr[] = [
        { op: "local.get", index: arrLocal } as Instr,
        { op: "local.get", index: offLocal } as Instr,
      ];
      if (k !== 0) {
        seq.push({ op: "i32.const", value: k } as Instr);
        seq.push({ op: "i32.add" } as Instr);
      }
      seq.push({ op: "array.get_u", typeIdx: arrTypeIdx } as Instr); // (#2835) packed i8 byte read
      seq.push({ op: "i32.const", value: 0xff } as Instr);
      seq.push({ op: "i32.and" } as Instr);
      seq.push({ op: "i64.extend_i32_u" } as Instr);
      return seq;
    };
    for (let k = 0; k < 8; k++) {
      const shift = little ? k * 8 : (7 - k) * 8;
      out.push(...byteAt(k));
      if (shift !== 0) {
        out.push({ op: "i64.const", value: BigInt(shift) } as Instr);
        out.push({ op: "i64.shl" } as Instr);
      }
      if (k > 0) out.push({ op: "i64.or" } as Instr);
    }
    return out;
  };
  fctx.body.push({ op: "local.get", index: leLocal } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i64" } },
    then: build(true),
    else: build(false),
  });
}

/** Store `arr[off + k] = byte` (byte already an i32 0..255 on caller's responsibility). */
function emitStoreByte(
  out: Instr[],
  arrLocal: number,
  offLocal: number,
  k: number,
  byte: Instr[],
  arrTypeIdx: number,
): void {
  out.push({ op: "local.get", index: arrLocal } as Instr);
  out.push({ op: "local.get", index: offLocal } as Instr);
  if (k !== 0) {
    out.push({ op: "i32.const", value: k } as Instr);
    out.push({ op: "i32.add" } as Instr);
  }
  out.push(...byte);
  out.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
}

/**
 * Write the value into the backing byte array. The value local is f64; we
 * convert to the integer/bit representation then store each byte with an
 * endianness branch.
 */
function emitWriteBytes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  acc: DvAccessor,
  arrLocal: number,
  offLocal: number,
  valLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  if (acc.bytes === 1) {
    // arr[off] = (value mod 256). Spec ToInt8/ToUint8 are modular; go via i64
    // (`i64.trunc_sat_f64_s` + `i32.wrap_i64`) so large values wrap rather than
    // saturate (`i32.trunc_sat_f64_s` would clamp ≥2^31), then mask the low byte.
    const out: Instr[] = [];
    emitStoreByte(
      out,
      arrLocal,
      offLocal,
      0,
      [
        { op: "local.get", index: valLocal } as Instr,
        { op: "i64.trunc_sat_f64_s" } as Instr,
        { op: "i32.wrap_i64" } as Instr,
        { op: "i32.const", value: 0xff } as Instr,
        { op: "i32.and" } as Instr,
      ],
      arrTypeIdx,
    );
    fctx.body.push(...out);
    return;
  }

  if (acc.bytes === 8) {
    // Float64: bits = i64.reinterpret_f64(val); store 8 bytes.
    const bitsLocal = allocLocal(fctx, `__dvn_bits64_${fctx.locals.length}`, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: valLocal } as Instr);
    fctx.body.push({ op: "i64.reinterpret_f64" } as Instr);
    fctx.body.push({ op: "local.set", index: bitsLocal } as Instr);
    const storeAll = (little: boolean): Instr[] => {
      const out: Instr[] = [];
      for (let k = 0; k < 8; k++) {
        const shift = little ? k * 8 : (7 - k) * 8;
        const byte: Instr[] = [{ op: "local.get", index: bitsLocal } as Instr];
        if (shift !== 0) {
          byte.push({ op: "i64.const", value: BigInt(shift) } as Instr);
          byte.push({ op: "i64.shr_u" } as Instr);
        }
        byte.push({ op: "i32.wrap_i64" } as Instr);
        byte.push({ op: "i32.const", value: 0xff } as Instr);
        byte.push({ op: "i32.and" } as Instr);
        emitStoreByte(out, arrLocal, offLocal, k, byte, arrTypeIdx);
      }
      return out;
    };
    fctx.body.push({ op: "local.get", index: leLocal } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: storeAll(true),
      else: storeAll(false),
    });
    return;
  }

  // 2 or 4 byte integers (or Float32) — derive an i32 bit pattern.
  const bitsLocal = allocLocal(fctx, `__dvn_bits32_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  if (acc.float) {
    // Float32: demote f64→f32, reinterpret to i32 bits.
    fctx.body.push({ op: "f32.demote_f64" } as Instr);
    fctx.body.push({ op: "i32.reinterpret_f32" } as Instr);
  } else {
    // Integer: the spec (SetValueInBuffer → ToInt{8,16,32}/ToUint{8,16,32}) is
    // MODULAR (`value mod 2^(8*bytes)`), not saturating. `i32.trunc_sat_f64_s`
    // *clamps* (e.g. setUint32(_, 4_000_000_000) → 0x7FFFFFFF), which is wrong
    // for any value ≥ 2^31. Truncate toward zero into an i64 first, then
    // `i32.wrap_i64` keeps the low 32 bits — i.e. `value mod 2^32`. Only the low
    // `acc.bytes` of those are stored below, giving the correct modular result
    // for 2- and 4-byte signed/unsigned setters across the ±2^53 integer range
    // that conformance exercises.
    fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
    fctx.body.push({ op: "i32.wrap_i64" } as Instr);
  }
  fctx.body.push({ op: "local.set", index: bitsLocal } as Instr);

  const storeAll = (little: boolean): Instr[] => {
    const out: Instr[] = [];
    for (let k = 0; k < acc.bytes; k++) {
      const shift = little ? k * 8 : (acc.bytes - 1 - k) * 8;
      const byte: Instr[] = [{ op: "local.get", index: bitsLocal } as Instr];
      if (shift !== 0) {
        byte.push({ op: "i32.const", value: shift } as Instr);
        byte.push({ op: "i32.shr_u" } as Instr);
      }
      byte.push({ op: "i32.const", value: 0xff } as Instr);
      byte.push({ op: "i32.and" } as Instr);
      emitStoreByte(out, arrLocal, offLocal, k, byte, arrTypeIdx);
    }
    return out;
  };
  fctx.body.push({ op: "local.get", index: leLocal } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: storeAll(true),
    else: storeAll(false),
  });
}

// ---------------------------------------------------------------------------
// (#3054 B1) Shared-backing TypedArray view element access.
//
// A `$__ta_view_<name>` is a byte-backed view over an ArrayBuffer's
// `$__vec_i32_byte` struct (field1 `buf`). Element `ta[i]` byte-decodes from
// `buf.data` at `byteOffset + i*width` using the SAME little/big-endian byte
// engine the native DataView accessors use — pinned little-endian (TypedArrays
// use native/platform endianness, and Wasm's is LE). Because the view holds a
// ref to the SHARED buffer vec, sibling views and DataViews over the same buffer
// observe each other's writes (the verified #3054 bug). Discriminated purely by
// the receiver's static ValType.typeIdx at compile time, so plain-array /
// native-TA element access never reaches these arms — byte-inert.
// ---------------------------------------------------------------------------

/** Per-view-name byte-decode descriptor (width, signedness, float, clamp-on-write). */
const TA_VIEW_DECODE: Record<string, { bytes: number; signed: boolean; float: boolean; clamp: boolean }> = {
  Int8Array: { bytes: 1, signed: true, float: false, clamp: false },
  Uint8Array: { bytes: 1, signed: false, float: false, clamp: false },
  Uint8ClampedArray: { bytes: 1, signed: false, float: false, clamp: true },
  Int16Array: { bytes: 2, signed: true, float: false, clamp: false },
  Uint16Array: { bytes: 2, signed: false, float: false, clamp: false },
  Int32Array: { bytes: 4, signed: true, float: false, clamp: false },
  Uint32Array: { bytes: 4, signed: false, float: false, clamp: false },
  Float32Array: { bytes: 4, signed: false, float: true, clamp: false },
  Float64Array: { bytes: 8, signed: false, float: true, clamp: false },
};

/** Resolve a `$__ta_view` typeIdx to its byte-decode descriptor, or undefined. */
export function taViewDecode(
  ctx: CodegenContext,
  taViewTypeIdx: number,
): { bytes: number; signed: boolean; float: boolean; clamp: boolean } | undefined {
  const name = getTaViewName(ctx, taViewTypeIdx);
  return name ? TA_VIEW_DECODE[name] : undefined;
}

/**
 * (#3054 C) Push the CURRENT element length of a `$__ta_view` (held in `tvLocal`)
 * as an i32. Field 0 stores either a fixed element count (`>= 0`, the B1/B2 case
 * — a view over a NON-resizable buffer) or the **auto-length-tracking sentinel
 * `-1`** (set by `emitTaViewConstruct` when the offset-0 view is built over a
 * `$__resizable_ab`). For the sentinel, the live length is derived from the shared
 * buffer's current byte length (`buf.length / elementSize`), so after
 * `rab.resize(n)` swaps the buffer's `length`/`data` the view reflects the new
 * length — length-tracking-on-resize (Phase A A.1), which is only "free" for the
 * BYTES (the byte engine already reads `buf.data` live); the length field is
 * cached and needs this indirection. A fixed view (field0 >= 0) takes the
 * `then`-branch → byte-identical to the pre-C direct `struct.get 0` read.
 */
export function pushTaViewEffectiveLen(
  ctx: CodegenContext,
  fctx: FunctionContext,
  tvLocal: number,
  taViewTypeIdx: number,
): void {
  // Byte-inert gate: a module with no resizable ArrayBuffer type can have NO
  // auto-length view, so the sentinel is impossible — read field0 directly,
  // byte-identical to B1. The tracking indirection is emitted only once a
  // `$__resizable_ab` exists in the module.
  if (ctx.resizableAbTypeIdx < 0) {
    fctx.body.push({ op: "local.get", index: tvLocal } as Instr);
    fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 0 } as Instr);
    return;
  }
  const { vecTypeIdx } = i32ByteVec(ctx);
  const bytes = taViewDecode(ctx, taViewTypeIdx)?.bytes ?? 1;
  const storedLocal = allocLocal(fctx, `__tav_slen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: tvLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.tee", index: storedLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.ge_s" } as Instr);
  const elseInstrs: Instr[] = [
    { op: "local.get", index: tvLocal } as Instr,
    { op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 } as Instr, // buf (ref_null $__vec_i32_byte)
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr, // buf.length (byte count)
  ];
  if (bytes !== 1) {
    elseInstrs.push({ op: "i32.const", value: bytes } as Instr);
    elseInstrs.push({ op: "i32.div_u" } as Instr);
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: storedLocal } as Instr],
    else: elseInstrs,
  } as Instr);
}

/**
 * (#3054 B1) `new <TA>(arrayBuffer)` → a shared-backing `$__ta_view_<name>` that
 * REFS the buffer's `$__vec_i32_byte` struct instead of COPYING its bytes into a
 * fresh backing array (the verified copy bug: sibling views / DataViews over the
 * same buffer didn't observe writes). Offset-0, default-length window (B1 scope;
 * B2 adds `(buffer, byteOffset, length)`). `viewName` is the TS TypedArray name.
 * `compileExpr` compiles the buffer arg expression. Returns the view ValType, or
 * null (leaving the stack balanced) when the buffer can't be recovered as a
 * native vec — the caller then falls back to the numeric-length ctor path.
 */
export function emitTaViewConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: import("../ts-api.js").ts.Expression,
  viewName: string,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = TA_VIEW_DECODE[viewName];
  if (!desc) return null;
  const taViewTypeIdx = getOrRegisterTaViewType(ctx, viewName);
  const { vecTypeIdx } = i32ByteVec(ctx);

  // Compile the buffer expression and recover the shared i32_byte vec struct.
  const bufType = compileExpr(bufExpr);
  if (!bufType) return null;
  if (bufType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
  } else if (bufType.kind === "ref" || bufType.kind === "ref_null") {
    if ("typeIdx" in bufType && (bufType as { typeIdx: number }).typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
    }
  } else {
    fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  const bufLocal = allocLocal(fctx, `__tav_buf_${fctx.locals.length}`, { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.set", index: bufLocal } as Instr);

  // struct.new order = [length, buf, byteOffset]. length field = fixed element
  // count `buf.length / elementSize` (B1/B2). (#3054 C) When the MODULE contains a
  // resizable ArrayBuffer (`ctx.resizableAbTypeIdx >= 0`), this offset-0 view may
  // be AUTO-LENGTH over a `$__resizable_ab` (§23.2.5.1 — length arg omitted +
  // resizable backing ⇒ length-tracking): store the sentinel `-1` when the runtime
  // buffer is resizable so `pushTaViewEffectiveLen` derives the live length from
  // `buf.length` at each read (reflecting a later `rab.resize()`). This extra
  // `ref.test`/`select` is emitted ONLY when a resizable buffer type exists in the
  // module, so a program that uses only fixed buffers is BYTE-IDENTICAL to B1.
  fctx.body.push({ op: "local.get", index: bufLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr);
  if (desc.bytes !== 1) {
    fctx.body.push({ op: "i32.const", value: desc.bytes } as Instr);
    fctx.body.push({ op: "i32.div_u" } as Instr);
  }
  if (ctx.resizableAbTypeIdx >= 0) {
    const rabTypeIdx = ctx.resizableAbTypeIdx;
    // -1 (auto-length sentinel). Wasm `select` yields `cond ? a : b` with `a` the
    // deeper operand (= fixedLen). We want `resizable ? -1 : fixedLen`, so invert
    // the test with `i32.eqz`: cond = !resizable ⇒ select = resizable ? -1 : fixedLen.
    fctx.body.push({ op: "i32.const", value: -1 } as Instr);
    fctx.body.push({ op: "local.get", index: bufLocal } as Instr);
    fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx } as Instr);
    fctx.body.push({ op: "i32.eqz" } as Instr);
    fctx.body.push({ op: "select" } as Instr);
  }
  // buf (shared vec ref) — `ref` widens to the field's `ref_null` type.
  fctx.body.push({ op: "local.get", index: bufLocal } as Instr);
  // byteOffset = 0 (B1: offset-0 window).
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: taViewTypeIdx } as Instr);
  return { kind: "ref_null", typeIdx: taViewTypeIdx };
}

/**
 * Recover `buf.data` (the shared i8 backing array) and the absolute byte offset
 * `byteOffset + index*width` for a `$__ta_view` receiver into the given locals.
 * The receiver ref (ref/ref_null `$__ta_view`) must already be on the stack; it
 * is consumed. `indexExpr` is compiled via `compileExpr`. Also sets `leLocal`
 * to 1 (little-endian, TypedArray native endianness).
 */
function emitTaViewAddress(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  bytes: number,
  indexExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
): { idxLocal: number; lenLocal: number } {
  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  // Stash the receiver.
  const tvLocal = allocLocal(fctx, `__tav_recv_${fctx.locals.length}`, { kind: "ref_null", typeIdx: taViewTypeIdx });
  fctx.body.push({ op: "local.set", index: tvLocal } as Instr);
  // len = the view's CURRENT element count — for the bounds check. Reads field0
  // directly for a fixed view, or derives it live from `buf.length` for an
  // auto-length view over a resizable buffer (#3054 C), so a `rab.resize()` grow
  // widens the in-bounds range and a shrink narrows it.
  const lenLocal = allocLocal(fctx, `__tav_len_${fctx.locals.length}`, { kind: "i32" });
  pushTaViewEffectiveLen(ctx, fctx, tvLocal, taViewTypeIdx);
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
  // arr = tv.buf.data  (buf is field1 → ref_null $__vec_i32_byte; .data is its field1)
  fctx.body.push({ op: "local.get", index: tvLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal } as Instr);
  // idx = ToInt32(indexExpr) — kept for the bounds check.
  const idxLocal = allocLocal(fctx, `__tav_idx_${fctx.locals.length}`, { kind: "i32" });
  const it = compileExpr(indexExpr, { kind: "i32" });
  if (it && it.kind !== "i32") coerceType(ctx, fctx, it, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: idxLocal } as Instr);
  // off = tv.byteOffset + idx*bytes
  fctx.body.push({ op: "local.get", index: tvLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 } as Instr);
  fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
  if (bytes !== 1) {
    fctx.body.push({ op: "i32.const", value: bytes } as Instr);
    fctx.body.push({ op: "i32.mul" } as Instr);
  }
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "local.set", index: offLocal } as Instr);
  // little-endian
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: leLocal } as Instr);
  void arrTypeIdx;
  return { idxLocal, lenLocal };
}

/**
 * `ta[i]` read for a `$__ta_view` receiver (already on the stack). Byte-decodes
 * the element little-endian and leaves an f64 on the stack. An out-of-bounds
 * index yields `NaN` (the f64 image of the spec's `undefined` — §10.4.5.15
 * IntegerIndexedElementGet returns undefined for OOB) rather than trapping,
 * matching the native bounds-checked vec read. Returns the result ValType, or
 * null if `taViewTypeIdx` is not a registered view.
 */
export function emitTaViewElementGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  indexExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  if (!desc) return null;
  const { arrTypeIdx } = i32ByteVec(ctx);
  const arrLocal = allocLocal(fctx, `__tav_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const offLocal = allocLocal(fctx, `__tav_off_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__tav_le_${fctx.locals.length}`, { kind: "i32" });
  const { idxLocal, lenLocal } = emitTaViewAddress(
    ctx,
    fctx,
    taViewTypeIdx,
    desc.bytes,
    indexExpr,
    compileExpr,
    arrLocal,
    offLocal,
    leLocal,
  );
  // if ((unsigned)idx < len) { decode } else { NaN }
  const readInstrs: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = readInstrs;
  emitReadBytes(
    ctx,
    fctx,
    { kind: "get", bytes: desc.bytes, signed: desc.signed, float: desc.float },
    arrLocal,
    offLocal,
    leLocal,
    arrTypeIdx,
  );
  fctx.body = savedBody;
  fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "i32.lt_u" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: readInstrs,
    else: [{ op: "f64.const", value: NaN } as Instr],
  } as Instr);
  return { kind: "f64" };
}

/**
 * `ta[i] = v` write for a `$__ta_view` receiver (already on the stack).
 * Byte-encodes `v` little-endian into the shared buffer backing (true aliasing).
 * Leaves the (coerced) value on the stack as the assignment-expression result.
 */
export function emitTaViewElementSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  indexExpr: import("../ts-api.js").ts.Expression,
  valueExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  if (!desc) return null;
  const { arrTypeIdx } = i32ByteVec(ctx);
  const arrLocal = allocLocal(fctx, `__tav_sarr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const offLocal = allocLocal(fctx, `__tav_soff_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__tav_sle_${fctx.locals.length}`, { kind: "i32" });
  const { idxLocal, lenLocal } = emitTaViewAddress(
    ctx,
    fctx,
    taViewTypeIdx,
    desc.bytes,
    indexExpr,
    compileExpr,
    arrLocal,
    offLocal,
    leLocal,
  );
  // value → f64 (evaluated for its side effects regardless of bounds)
  const valLocal = allocLocal(fctx, `__tav_sval_${fctx.locals.length}`, { kind: "f64" });
  const vt = compileExpr(valueExpr, { kind: "f64" });
  if (vt && vt.kind !== "f64") coerceType(ctx, fctx, vt, { kind: "f64" });
  if (desc.clamp) {
    // Uint8Clamped: ToUint8Clamp §7.1.11 — round-half-to-even then clamp [0,255].
    // f64.nearest rounds ties-to-even; f64.max/min clamp; NaN propagates through
    // max/min and `emitWriteBytes` (trunc_sat_f64_s(NaN)=0) → NaN maps to 0.
    fctx.body.push({ op: "f64.nearest" } as Instr);
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    fctx.body.push({ op: "f64.max" } as Instr);
    fctx.body.push({ op: "f64.const", value: 255 } as Instr);
    fctx.body.push({ op: "f64.min" } as Instr);
  }
  fctx.body.push({ op: "local.set", index: valLocal } as Instr);
  // OOB write is a silent no-op (§10.4.5.16 IntegerIndexedElementSet): guard the
  // store on `(unsigned)idx < len` so an out-of-range write doesn't trap.
  const writeInstrs: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = writeInstrs;
  emitWriteBytes(
    ctx,
    fctx,
    { kind: "set", bytes: desc.bytes, signed: desc.signed, float: desc.float },
    arrLocal,
    offLocal,
    valLocal,
    leLocal,
    arrTypeIdx,
  );
  fctx.body = savedBody;
  fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "i32.lt_u" } as Instr);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: writeInstrs } as Instr);
  // Assignment is an expression — re-push the coerced value as the result.
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  return { kind: "f64" };
}

// ---------------------------------------------------------------------------
// (#3054 B2) View accessor props + windowing constructor on a `$__ta_view`.
//
// B1 populated a `$__ta_view {length, buf, byteOffset}` with byteOffset pinned
// 0. B2 (a) reads the accessor props off that struct (`.byteLength`,
// `.byteOffset`, `.buffer` identity, `BYTES_PER_ELEMENT`; `.length` stays on the
// B1 arm) and (b) the `(buffer, byteOffset, length)` windowing ctor that
// POPULATES byteOffset (byte offset) + a windowed element `length`. The byte
// engine is offset-agnostic (it reads `buf.data` at `byteOffset + i*width` and
// bounds-checks `i < length` — both fields the view already carries), so a
// windowed view reads/writes the correct absolute buffer bytes with ZERO byte-
// engine change. An offset-0 window is byte-identical to B1 (offsetLocal = 0).
// ---------------------------------------------------------------------------

/** Emit an `if (cond) throw RangeError(msg)` — the i32 condition is on the stack. */
function emitThrowRangeErrorIf(ctx: CodegenContext, fctx: FunctionContext, msg: string): void {
  addStringConstantGlobal(ctx, msg);
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [...stringConstantExternrefInstrs(ctx, msg), { op: "throw", tagIdx } as Instr],
    else: [],
  } as Instr);
}

/**
 * ToIndex (§7.1.22) into `outLocal` (i32): compile `expr` → f64, NaN → 0,
 * truncate toward 0, RangeError if < 0 or > 2^53-1, then narrow to i32. Used by
 * the windowing ctor for both byteOffset and (element) length args.
 */
function emitToIndexI32(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
  outLocal: number,
  rangeErrMsg: string,
): void {
  const f64Local = allocLocal(fctx, `__tav_ti_${fctx.locals.length}`, { kind: "f64" });
  const vt = compileExpr(expr, { kind: "f64" });
  if (vt && vt.kind !== "f64") coerceType(ctx, fctx, vt, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: f64Local } as Instr);
  // NaN → 0 (v != v is true only for NaN).
  fctx.body.push({ op: "local.get", index: f64Local } as Instr);
  fctx.body.push({ op: "local.get", index: f64Local } as Instr);
  fctx.body.push({ op: "f64.ne" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: f64Local } as Instr],
    else: [],
  } as Instr);
  // Truncate toward zero (ToIntegerOrInfinity for finite non-NaN).
  fctx.body.push({ op: "local.get", index: f64Local } as Instr);
  fctx.body.push({ op: "f64.trunc" } as Instr);
  fctx.body.push({ op: "local.set", index: f64Local } as Instr);
  // RangeError if < 0 or > 2^53-1.
  fctx.body.push({ op: "local.get", index: f64Local } as Instr);
  fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  fctx.body.push({ op: "f64.lt" } as Instr);
  fctx.body.push({ op: "local.get", index: f64Local } as Instr);
  fctx.body.push({ op: "f64.const", value: 9007199254740991 } as Instr); // 2^53 - 1
  fctx.body.push({ op: "f64.gt" } as Instr);
  fctx.body.push({ op: "i32.or" } as Instr);
  emitThrowRangeErrorIf(ctx, fctx, rangeErrMsg);
  fctx.body.push({ op: "local.get", index: f64Local } as Instr);
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "local.set", index: outLocal } as Instr);
}

/**
 * (#3054 B2) `new <TA>(buffer, byteOffset[, length])` → a windowed shared-backing
 * `$__ta_view` that refs the buffer's vec (like `emitTaViewConstruct`) but with a
 * non-zero `byteOffset` field and a windowed element `length`. Validates per
 * §23.2.5.1 InitializeTypedArrayFromArrayBuffer: byteOffset is ToIndex'd and must
 * be a multiple of the element size; with an explicit length, byteOffset +
 * length*elemSize must fit the buffer; with the length omitted, the remaining
 * byte span must be a multiple of the element size. `lengthExpr` undefined ⇒
 * auto-length (2-arg form). Returns the view ValType, or null (stack balanced) if
 * the buffer can't be recovered as a native vec.
 */
export function emitTaViewConstructWindowed(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: import("../ts-api.js").ts.Expression,
  offsetExpr: import("../ts-api.js").ts.Expression,
  lengthExpr: import("../ts-api.js").ts.Expression | undefined,
  viewName: string,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = TA_VIEW_DECODE[viewName];
  if (!desc) return null;
  const elemSize = desc.bytes;
  const taViewTypeIdx = getOrRegisterTaViewType(ctx, viewName);
  const { vecTypeIdx } = i32ByteVec(ctx);

  // Recover the shared buffer vec struct (mirror emitTaViewConstruct exactly).
  const bufType = compileExpr(bufExpr);
  if (!bufType) return null;
  if (bufType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
  } else if (bufType.kind === "ref" || bufType.kind === "ref_null") {
    if ("typeIdx" in bufType && (bufType as { typeIdx: number }).typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
    }
  } else {
    fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  const bufLocal = allocLocal(fctx, `__tavw_buf_${fctx.locals.length}`, { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.set", index: bufLocal } as Instr);

  // bufByteLen = buf.length (field0 = byte count for an ArrayBuffer vec).
  const bufByteLenLocal = allocLocal(fctx, `__tavw_blen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: bufLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: bufByteLenLocal } as Instr);

  // byteOffset = ToIndex(offsetExpr).
  const offsetLocal = allocLocal(fctx, `__tavw_off_${fctx.locals.length}`, { kind: "i32" });
  emitToIndexI32(ctx, fctx, offsetExpr, compileExpr, offsetLocal, "RangeError: Invalid typed array offset");

  // byteOffset must be a multiple of the element size (§23.2.5.1 step 11).
  if (elemSize !== 1) {
    fctx.body.push({ op: "local.get", index: offsetLocal } as Instr);
    fctx.body.push({ op: "i32.const", value: elemSize } as Instr);
    fctx.body.push({ op: "i32.rem_u" } as Instr);
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
    fctx.body.push({ op: "i32.ne" } as Instr);
    emitThrowRangeErrorIf(ctx, fctx, `RangeError: start offset of ${viewName} should be a multiple of ${elemSize}`);
  }

  const lenLocal = allocLocal(fctx, `__tavw_len_${fctx.locals.length}`, { kind: "i32" });
  if (lengthExpr) {
    // Explicit element length. byteOffset + length*elemSize must fit the buffer.
    emitToIndexI32(ctx, fctx, lengthExpr, compileExpr, lenLocal, "RangeError: Invalid typed array length");
    fctx.body.push({ op: "local.get", index: offsetLocal } as Instr);
    fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
    if (elemSize !== 1) {
      fctx.body.push({ op: "i32.const", value: elemSize } as Instr);
      fctx.body.push({ op: "i32.mul" } as Instr);
    }
    fctx.body.push({ op: "i32.add" } as Instr);
    fctx.body.push({ op: "local.get", index: bufByteLenLocal } as Instr);
    fctx.body.push({ op: "i32.gt_s" } as Instr);
    emitThrowRangeErrorIf(ctx, fctx, "RangeError: Invalid typed array length");
  } else {
    // Auto length. byteOffset must not exceed the buffer, and the remaining byte
    // span must be a whole number of elements. length = (bufByteLen - offset)/elemSize.
    fctx.body.push({ op: "local.get", index: offsetLocal } as Instr);
    fctx.body.push({ op: "local.get", index: bufByteLenLocal } as Instr);
    fctx.body.push({ op: "i32.gt_s" } as Instr);
    emitThrowRangeErrorIf(ctx, fctx, "RangeError: Start offset is outside the bounds of the buffer");
    const remLocal = allocLocal(fctx, `__tavw_rem_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: bufByteLenLocal } as Instr);
    fctx.body.push({ op: "local.get", index: offsetLocal } as Instr);
    fctx.body.push({ op: "i32.sub" } as Instr);
    fctx.body.push({ op: "local.set", index: remLocal } as Instr);
    if (elemSize !== 1) {
      fctx.body.push({ op: "local.get", index: remLocal } as Instr);
      fctx.body.push({ op: "i32.const", value: elemSize } as Instr);
      fctx.body.push({ op: "i32.rem_u" } as Instr);
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "i32.ne" } as Instr);
      emitThrowRangeErrorIf(ctx, fctx, `RangeError: byte length of ${viewName} should be a multiple of ${elemSize}`);
    }
    fctx.body.push({ op: "local.get", index: remLocal } as Instr);
    if (elemSize !== 1) {
      fctx.body.push({ op: "i32.const", value: elemSize } as Instr);
      fctx.body.push({ op: "i32.div_u" } as Instr);
    }
    fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
  }

  // struct.new $__ta_view {length (elements), buf (shared vec), byteOffset (bytes)}.
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "local.get", index: bufLocal } as Instr);
  fctx.body.push({ op: "local.get", index: offsetLocal } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: taViewTypeIdx } as Instr);
  return { kind: "ref_null", typeIdx: taViewTypeIdx };
}

/**
 * (#3054 B2) Read an accessor prop off a `$__ta_view` receiver:
 *   `.byteLength`   = length (field0, element count) × elementSize
 *   `.byteOffset`   = byteOffset (field2)
 *   `.buffer`       = the SHARED buffer vec (field1) itself — object IDENTITY, so
 *                     `a.buffer === b.buffer` for sibling views is `ref.eq`-true
 *   `BYTES_PER_ELEMENT` = the per-view element size (constant)
 * `.length` is intentionally NOT handled here — the B1 local-type `.length` arm
 * (property-access.ts) already reads field0. `receiverExpr` is the view receiver
 * (compiled via `compileExpr`). Returns the result ValType, or null (declining).
 */
export function emitTaViewAccessor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  propName: string,
  receiverExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  if (!desc) return null;
  const { vecTypeIdx } = i32ByteVec(ctx);
  const elemSize = desc.bytes;

  // BYTES_PER_ELEMENT is a compile-time constant — drop the (side-effecting) recv.
  if (propName === "BYTES_PER_ELEMENT") {
    const rt = compileExpr(receiverExpr);
    if (rt !== null) fctx.body.push({ op: "drop" } as Instr);
    fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: elemSize } as Instr);
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  // Compile the receiver (the $__ta_view ref) onto the stack.
  const rt = compileExpr(receiverExpr);
  if (rt?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: taViewTypeIdx } as Instr);
  }

  if (propName === "buffer") {
    // Object identity: return the shared buffer vec (field1) directly.
    fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 } as Instr);
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }
  if (propName === "byteLength") {
    // (#3054 C) Effective element count × elementSize. When a resizable buffer
    // type exists in the module, stash the receiver + derive the live length so a
    // resize is tracked; otherwise read field0 directly (BYTE-IDENTICAL to B2 —
    // no extra local, receiver stays on the stack).
    if (ctx.resizableAbTypeIdx >= 0) {
      const tvLocal = allocLocal(fctx, `__tav_bl_recv_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: taViewTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: tvLocal } as Instr);
      pushTaViewEffectiveLen(ctx, fctx, tvLocal, taViewTypeIdx);
    } else {
      fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 0 } as Instr);
    }
    if (elemSize !== 1) {
      fctx.body.push({ op: "i32.const", value: elemSize } as Instr);
      fctx.body.push({ op: "i32.mul" } as Instr);
    }
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }
  if (propName === "byteOffset") {
    fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 } as Instr);
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }
  // Unknown prop — leave the stack balanced and decline.
  fctx.body.push({ op: "drop" } as Instr);
  return null;
}

/**
 * (#3054 B1, Option A) Materialize a `$__ta_view` into a fresh NATIVE
 * `$__vec_<elem>` by byte-decoding every element little-endian, so consumers that
 * expect a native typed-vec receiver (the shared array-method dispatch, which
 * `ref.cast`s the receiver to the native vec type) work on a view without
 * trapping. The view ref must already be on the stack; a `(ref null
 * nativeVecTypeIdx)` is left on the stack. This is a de-aliasing COPY — writes by
 * a mutating method (`.fill`/`.set`) land in the copy, NOT back in the buffer (B1
 * never claimed proto-method write-through; B3 will teach the methods to operate
 * on the view directly). `nativeVecTypeIdx` is the element-typed vec
 * `resolveArrayInfo` picked for the receiver's TS type, and drives the element
 * coercion (integer vecs truncate the decoded f64; f64 vecs keep it).
 */
export function emitTaViewToVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  nativeVecTypeIdx: number,
): void {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  const nativeArrTypeIdx = getArrTypeIdxFromVec(ctx, nativeVecTypeIdx);
  const nativeArrDef = ctx.mod.types[nativeArrTypeIdx];
  if (!desc || nativeArrTypeIdx < 0 || !nativeArrDef || nativeArrDef.kind !== "array") {
    // Shouldn't happen for a registered view; leave the view ref as-is (a later
    // ref.cast will surface the mismatch rather than silently miscompiling).
    return;
  }
  const nativeElemKind = nativeArrDef.element.kind;
  const { arrTypeIdx: bufArrTypeIdx } = i32ByteVec(ctx);

  // view (on stack) → local
  const vLocal = allocLocal(fctx, `__tav_mv_${fctx.locals.length}`, { kind: "ref_null", typeIdx: taViewTypeIdx });
  fctx.body.push({ op: "local.set", index: vLocal } as Instr);
  // len = view.length (field0)
  const lenLocal = allocLocal(fctx, `__tav_mlen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
  // arr = view.buf.data ; base = view.byteOffset ; le = 1
  const arrLocal = allocLocal(fctx, `__tav_marr_${fctx.locals.length}`, { kind: "ref", typeIdx: bufArrTypeIdx });
  const { vecTypeIdx: bufVecTypeIdx } = i32ByteVec(ctx);
  fctx.body.push({ op: "local.get", index: vLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: bufVecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal } as Instr);
  const baseLocal = allocLocal(fctx, `__tav_mbase_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 } as Instr);
  fctx.body.push({ op: "local.set", index: baseLocal } as Instr);
  const leLocal = allocLocal(fctx, `__tav_mle_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: leLocal } as Instr);
  // nativeArr = array.new_default(len)
  const nArrLocal = allocLocal(fctx, `__tav_mnarr_${fctx.locals.length}`, { kind: "ref", typeIdx: nativeArrTypeIdx });
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "array.new_default", typeIdx: nativeArrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: nArrLocal } as Instr);
  // for (i = 0; i < len; i++) nativeArr[i] = coerce(decode(base + i*width))
  const iLocal = allocLocal(fctx, `__tav_mi_${fctx.locals.length}`, { kind: "i32" });
  const offLocal = allocLocal(fctx, `__tav_moff_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: iLocal } as Instr);
  const isIntArr = nativeElemKind === "i8" || nativeElemKind === "i16" || nativeElemKind === "i32";
  const decodeInstrs: Instr[] = [];
  // offLocal = base + i*width
  decodeInstrs.push({ op: "local.get", index: baseLocal } as Instr);
  decodeInstrs.push({ op: "local.get", index: iLocal } as Instr);
  if (desc.bytes !== 1) {
    decodeInstrs.push({ op: "i32.const", value: desc.bytes } as Instr);
    decodeInstrs.push({ op: "i32.mul" } as Instr);
  }
  decodeInstrs.push({ op: "i32.add" } as Instr);
  decodeInstrs.push({ op: "local.set", index: offLocal } as Instr);
  // nativeArr[i] = <decoded>
  decodeInstrs.push({ op: "local.get", index: nArrLocal } as Instr);
  decodeInstrs.push({ op: "local.get", index: iLocal } as Instr);
  // NOTE: emitReadBytes pushes an f64 directly onto fctx.body; capture it by
  // temporarily swapping the body so the read lands inside decodeInstrs.
  const savedBody = fctx.body;
  fctx.body = decodeInstrs;
  emitReadBytes(
    ctx,
    fctx,
    { kind: "get", bytes: desc.bytes, signed: desc.signed, float: desc.float },
    arrLocal,
    offLocal,
    leLocal,
    bufArrTypeIdx,
  );
  fctx.body = savedBody;
  if (isIntArr) decodeInstrs.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  decodeInstrs.push({ op: "array.set", typeIdx: nativeArrTypeIdx } as Instr);
  // i++
  decodeInstrs.push({ op: "local.get", index: iLocal } as Instr);
  decodeInstrs.push({ op: "i32.const", value: 1 } as Instr);
  decodeInstrs.push({ op: "i32.add" } as Instr);
  decodeInstrs.push({ op: "local.set", index: iLocal } as Instr);
  decodeInstrs.push({ op: "br", depth: 0 } as Instr);
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    ...decodeInstrs,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);
  // struct.new nativeVec(len, nativeArr)
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "local.get", index: nArrLocal } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: nativeVecTypeIdx } as Instr);
}

/**
 * (#2639) Stage a native DataView's bytes into the linear write scratch so
 * `node:fs` `writeSync(fd, dv)` can hand the shim a (ptr, len) pair.
 *
 * The DataView arg (an externref / GC ref already produced by compiling the
 * argument expression — its `recvType` passed in) is resolved via
 * {@link recoverDvBacking} to its i32_byte backing array + base byte offset +
 * view byte length, mirroring exactly what the DataView accessors use. Then it
 * copies `viewLen` bytes from `arr[base + j]` (masked to a byte) into
 * `scratch[scratchStart + j]`. The DataView's backing array is `i32_byte` (one
 * i32 per byte, 0..255), so each element is `& 0xff`-ed before the byte store.
 *
 * Returns the i32 local holding the view byte length (the count to write), or
 * `-1` when the receiver isn't a resolvable DataView/ArrayBuffer view. The
 * receiver value must already be on the stack (its `recvType` is consumed here).
 * Memory is assumed already grown for `[scratchStart, scratchStart+viewLen)` —
 * the caller grows it (it must, since the length is only known at runtime).
 */
export function emitDataViewToWriteScratch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvType: ValType | null,
  scratchStart: number,
): number {
  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  if (arrTypeIdx < 0) return -1;

  const arrLocal = allocLocal(fctx, `__dvw_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const baseLocal = allocLocal(fctx, `__dvw_base_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__dvw_len_${fctx.locals.length}`, { kind: "i32" });
  if (!recoverDvBacking(ctx, fctx, recvType, arrLocal, baseLocal, vecTypeIdx, arrTypeIdx, lenLocal)) {
    return -1;
  }

  // Grow linear memory so [scratchStart, scratchStart + len) is addressable.
  const needPagesLocal = allocLocal(fctx, `__dvw_pages_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: scratchStart } as Instr);
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.const", value: 65535 } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.const", value: 16 } as Instr);
  fctx.body.push({ op: "i32.shr_u" } as Instr);
  fctx.body.push({ op: "local.set", index: needPagesLocal } as Instr);
  fctx.body.push({ op: "local.get", index: needPagesLocal } as Instr);
  fctx.body.push({ op: "memory.size" } as Instr);
  fctx.body.push({ op: "i32.gt_u" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: needPagesLocal } as Instr,
      { op: "memory.size" } as Instr,
      { op: "i32.sub" } as Instr,
      { op: "memory.grow" } as Instr,
      { op: "drop" } as Instr,
    ],
  } as Instr);

  // for j in [0, len): scratch[scratchStart + j] = arr[base + j] & 0xff
  const jLocal = allocLocal(fctx, `__dvw_j_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: jLocal } as Instr);
  const loopBody: Instr[] = [
    { op: "local.get", index: jLocal } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // addr = scratchStart + j
    { op: "i32.const", value: scratchStart } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    // value = arr[base + j] & 0xff  ((#2835) packed i8 → unsigned read)
    { op: "local.get", index: arrLocal } as Instr,
    { op: "local.get", index: baseLocal } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    { op: "array.get_u", typeIdx: arrTypeIdx } as Instr,
    { op: "i32.const", value: 0xff } as Instr,
    { op: "i32.and" } as Instr,
    { op: "i32.store8", align: 0, offset: 0 } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: jLocal } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);

  return lenLocal;
}
