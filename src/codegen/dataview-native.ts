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
 * array of i32, one byte per element, values 0..255). Multi-byte accessors
 * honour the `littleEndian` flag at runtime.
 *
 * Backing-store representation:
 *   ArrayBuffer / DataView  → vec "i32_byte"  (one i32 per byte, 0..255)
 *   Uint8Array (write path) → vec "f64"       (process.stdout.write helper)
 *
 * The receiver (`this`) of a DataView accessor is an externref holding the
 * i32_byte vec; we `any.convert_extern` + `ref.cast` to recover the struct.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./index.js";

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

/** Lazily ensure the i32_byte vec type exists and return its struct/array indices. */
function i32ByteVec(ctx: CodegenContext): { vecTypeIdx: number; arrTypeIdx: number } {
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i32" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  return { vecTypeIdx, arrTypeIdx };
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

  // Recover the i32_byte vec struct from the (externref) receiver and stash
  // its backing array in a local. `dv` may be typed as a struct ref already
  // (when DataView codegen returns the buffer struct) or externref.
  const arrLocal = allocLocal(fctx, `__dvn_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
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
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // byteOffset (arg 0) → i32 index.
  const offLocal = allocLocal(fctx, `__dvn_off_${fctx.locals.length}`, { kind: "i32" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: offLocal });

  if (acc.kind === "get") {
    // littleEndian flag is the 2nd arg for getters (getUintN(off, le)).
    const leLocal = emitLittleEndianFlag(ctx, fctx, args[1], compileExpr);
    emitReadBytes(ctx, fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    return { kind: "get", result: { kind: "f64" } };
  }

  // Setter: value is arg 1, littleEndian is arg 2.
  const valLocal = allocLocal(fctx, `__dvn_val_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 2) {
    compileExpr(args[1]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: valLocal });
  const leLocal = emitLittleEndianFlag(ctx, fctx, args[2], compileExpr);
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
  fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
  // Mask to a byte — the backing array holds 0..255 already, but defensively
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
  } as unknown as Instr);
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
    seq.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
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
      seq.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
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
  } as unknown as Instr);
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
    // arr[off] = trunc(val) & 0xff
    const out: Instr[] = [];
    emitStoreByte(
      out,
      arrLocal,
      offLocal,
      0,
      [
        { op: "local.get", index: valLocal } as Instr,
        { op: "i32.trunc_sat_f64_s" } as Instr,
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
    } as unknown as Instr);
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
    // Integer: truncate toward zero. trunc_sat_f64_s gives a 32-bit pattern;
    // for unsigned/odd widths the low N bytes are what matters.
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
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
  } as unknown as Instr);
}
