// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Node `node:fs` + `process` std-IO lowering for WASI (#2633).
 *
 * This keeps Node-shaped host API support out of the generic call-expression
 * compiler. It recognizes the synchronous std-IO surface — `node:fs`
 * `readSync`/`writeSync(fd, buf, …)` and `process.stdout`/`stderr.write` — and
 * lowers them to WASI syscalls (or, under `--link-node-shims`, to the imported
 * `node:fs` shim). It also rejects the hallucinated `process.stdin.read(buf,
 * offset)` with a clear pointer to `node:fs` `readSync`.
 */
import { isStringType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./expressions/helpers.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import {
  ensureWasiWriteAnyStringHelper,
  ensureWasiWriteArrayBufferHelper,
  ensureWasiWriteUint8ArrayHelper,
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  WASI_STDIN_BUF_START,
  WASI_WRITE_SCRATCH_START,
} from "./index.js";
import type { InnerResult } from "./shared.js";
import { compileExpression, VOID_RESULT } from "./shared.js";
import { getLinearU8Buffer, tryEmitLinearU8StdWrite } from "./linear-uint8-codegen.js";

export function tryCompileNodeProcessCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  // #2633 — `process.stdin.read(buf, offset)` is a HALLUCINATED API that matches
  // no real Node surface: `process.stdin` is an async Duplex stream with no
  // synchronous buffer-filling `read`. The faithful synchronous primitive is
  // `node:fs` `readSync(0, buf, …)` (this is also what Javy uses:
  // `Javy.IO.readSync`). Reject it with a clear compile error directing to the
  // real API rather than silently lowering the fake shape.
  if (ctx.wasi && matchProcessStdinRead(fctx, expr)) {
    ctx.errors.push({
      message:
        "process.stdin.read(buf, offset) is not a real Node API (process.stdin is an async " +
        "Duplex stream with no synchronous read). Use the synchronous fd-based primitive " +
        'instead: `import { readSync } from "node:fs"; readSync(0, buf, { offset, length })`.',
      line: 1,
      column: 1,
      severity: "error",
    });
    return VOID_RESULT;
  }

  // #1766: In the current WASI Preview 1 lowering, process.std*.write()
  // maps to a direct fd_write host call. Accept the Node stream backpressure
  // subscription shape so idiomatic `if (!stdout.write(...)) stdout.once("drain", cb)`
  // compiles without a JS-host EventEmitter import. Since write() returns true
  // below, the drain callback is never needed on this path. Track real WASI
  // 0.3/Preview 3 async stream semantics separately in #1774.
  if (matchProcessStdStreamDrainOnce(ctx, fctx, expr)) {
    return VOID_RESULT;
  }

  const stdoutWrite = matchProcessStdStreamWrite(ctx, fctx, expr);
  if (!stdoutWrite) return undefined;

  const { useStderr } = stdoutWrite;
  const argExpr = expr.arguments[0]!;
  const fd = useStderr ? 2 : 1;

  // #1886 Slice B: zero-copy `process.std*.write(buf)` for a linear-backed
  // Uint8Array — the write reads straight from `ptr` for `len` bytes (no
  // GC→linear staging copy). Only fires for a registered linear-safe buffer.
  // #2633: under the node shims there is no fd_write idx; `tryEmitLinearU8StdWrite`
  // routes to the imported `node:fs` `writeSync(fd, ptr, len)` instead (the passed
  // idx is unused on that branch).
  const writeSinkIdx = ctx.linkNodeShims ? ctx.nodeFsWriteSyncIdx : ctx.wasiFdWriteIdx;
  if (writeSinkIdx !== undefined && writeSinkIdx >= 0) {
    if (tryEmitLinearU8StdWrite(ctx, fctx, argExpr, writeSinkIdx, fd)) {
      // Match the GC Uint8Array write path's contract: push `1` (write
      // succeeded) and return i32, so the expression-statement wrapper drops it
      // exactly like the GC path. (#1886)
      fctx.body.push({ op: "i32.const", value: 1 } as Instr);
      return { kind: "i32" };
    }
  }

  const argTsType = ctx.checker.getTypeAtLocation(argExpr);
  if (isStringType(argTsType)) {
    const compiled = compileExpression(ctx, fctx, argExpr);
    flushLateImportShifts(ctx, fctx);
    if (compiled && ctx.nativeStrTypeIdx >= 0) {
      if (compiled.kind === "ref_null") {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
      }
      const writeStrIdx = ensureWasiWriteAnyStringHelper(ctx, useStderr);
      if (writeStrIdx >= 0) {
        fctx.body.push({ op: "call", funcIdx: writeStrIdx } as Instr);
        fctx.body.push({ op: "i32.const", value: 1 } as Instr);
        return { kind: "i32" };
      }
    }
    if (compiled) fctx.body.push({ op: "drop" } as Instr);
    return VOID_RESULT;
  }

  const argSymName = argTsType.getSymbol?.()?.name;
  const isArrayBufferArg = argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer";
  const elemKey: "i8_byte" | "i32_byte" | "f64" =
    noJsHost(ctx) && argSymName === "Uint8Array" ? "i8_byte" : isArrayBufferArg ? "i32_byte" : "f64";
  const elemType: ValType =
    elemKey === "i8_byte" ? { kind: "i8" } : elemKey === "i32_byte" ? { kind: "i32" } : { kind: "f64" };
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
  const argType = compileExpression(ctx, fctx, argExpr);
  flushLateImportShifts(ctx, fctx);

  if (argType) {
    if (argType.kind === "ref_null") {
      if ("typeIdx" in argType && argType.typeIdx !== vecTypeIdx) {
        fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
      } else {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
      }
    } else if (argType.kind === "ref" && "typeIdx" in argType && argType.typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
    }
  }

  const helperIdx = isArrayBufferArg
    ? ensureWasiWriteArrayBufferHelper(ctx, vecTypeIdx, useStderr)
    : ensureWasiWriteUint8ArrayHelper(ctx, vecTypeIdx, useStderr);
  if (helperIdx >= 0) {
    fctx.body.push({ op: "call", funcIdx: helperIdx } as Instr);
    fctx.body.push({ op: "i32.const", value: 1 } as Instr);
    return { kind: "i32" };
  }
  if (argType) fctx.body.push({ op: "drop" } as Instr);
  return VOID_RESULT;
}

function isUnshadowedProcessIdentifier(fctx: FunctionContext, expr: ts.Expression): boolean {
  return (
    ts.isIdentifier(expr) &&
    expr.text === "process" &&
    !fctx.localMap.has("process") &&
    !(fctx.boxedCaptures?.has("process") ?? false)
  );
}

/**
 * #1651: recognize `process.stdout.write(x)` / `process.stderr.write(x)` under
 * --target wasi. This accepts global `process` and `import process from
 * "node:process"` after import preprocessing; local/captured shadows are left
 * alone.
 */
function matchProcessStdStreamWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): { useStderr: boolean } | null {
  // #2633 — under the node shims the write sink is `node:fs::writeSync(fd, …)`;
  // inline it is `wasi_snapshot_preview1.fd_write`.
  const haveWriteSink = ctx.linkNodeShims
    ? ctx.nodeFsWriteSyncIdx >= 0
    : ctx.wasiFdWriteIdx !== undefined && ctx.wasiFdWriteIdx >= 0;
  if (!ctx.wasi || !haveWriteSink) return null;
  if (expr.questionDotToken || expr.arguments.length !== 1) return null;
  const writeAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(writeAccess) || writeAccess.name.text !== "write") return null;
  const streamAccess = writeAccess.expression;
  if (!ts.isPropertyAccessExpression(streamAccess)) return null;
  const streamName = streamAccess.name.text;
  if (streamName !== "stdout" && streamName !== "stderr") return null;
  if (!isUnshadowedProcessIdentifier(fctx, streamAccess.expression)) return null;
  return { useStderr: streamName === "stderr" };
}

function matchProcessStdStreamDrainOnce(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): boolean {
  if (!ctx.wasi) return false;
  if (expr.questionDotToken || expr.arguments.length !== 2) return false;
  const onceAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(onceAccess) || onceAccess.name.text !== "once") return false;
  const streamAccess = onceAccess.expression;
  if (!ts.isPropertyAccessExpression(streamAccess)) return false;
  const streamName = streamAccess.name.text;
  if (streamName !== "stdout" && streamName !== "stderr") return false;
  if (!isUnshadowedProcessIdentifier(fctx, streamAccess.expression)) return false;
  const eventArg = expr.arguments[0]!;
  return ts.isStringLiteralLike(eventArg) && eventArg.text === "drain";
}

/**
 * #2633 — recognize the (hallucinated) `process.stdin.read(buf, offset?)` shape
 * so the caller can reject it with a compile error pointing at `node:fs`
 * `readSync`. Unlike the retired lowering, this is decoupled from any import
 * registration: the shape is rejected whenever it appears under `--target wasi`
 * (any local/captured `process` shadow is left alone). Non-WASI targets keep the
 * generic call path (it resolves through the JS host).
 */
function matchProcessStdinRead(fctx: FunctionContext, expr: ts.CallExpression): boolean {
  if (expr.questionDotToken) return false;
  const readAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(readAccess) || readAccess.name.text !== "read") return false;
  const streamAccess = readAccess.expression;
  if (!ts.isPropertyAccessExpression(streamAccess) || streamAccess.name.text !== "stdin") return false;
  return isUnshadowedProcessIdentifier(fctx, streamAccess.expression);
}

// ---------------------------------------------------------------------------
// #2631 / #2633 — node:fs fd-based readSync / writeSync via the `node:fs` shim.
//
// `readSync(fd, buf, …)` / `writeSync(fd, buf, …)` are the faithful synchronous
// Node primitives the Native Messaging host needs (process.stdin is an async
// Duplex with no synchronous buffer-filling read — loopdive/js2#389). They are
// fd-based (integer fd 0/1/2), NOT path-based: they map 1:1 to fd_read/fd_write
// with NO filesystem. The path-based `fs` family (readFileSync(path)) stays on
// the --allow-fs path and is rejected in standalone WASI. Since #2633 these are
// also the sole std-IO substrate under `--link-node-shims`: console.log /
// process.std*.write lower to `writeSync(1|2, …)`, and the bespoke
// `js2wasm:node-process` shim was retired.
//
// The compiler's only job is to recognize the imported `readSync`/`writeSync`
// bindings and call the registered `node:fs` shim funcs with (fd, ptr, len) —
// the syscall lives in node-fs.wat, not in codegen.
// ---------------------------------------------------------------------------

/**
 * Recognize + lower an imported node:fs `readSync(fd, buf, …)` /
 * `writeSync(fd, buf, …)` call. Returns the result (a byte count, f64), or
 * `undefined` when this isn't a node-fs fd-based call we handle (the generic
 * compiler then proceeds — path-based fs is handled / rejected elsewhere).
 */
export function tryCompileNodeFsCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.wasi || !ctx.linkNodeShims) return undefined;
  if (expr.questionDotToken) return undefined;
  if (!ts.isIdentifier(expr.expression)) return undefined;
  const callee = expr.expression.text;
  if (callee !== "readSync" && callee !== "writeSync") return undefined;
  // Only treat it as the fd-based node:fs primitive when it was imported from
  // node:fs (detected pre-preprocessing) and is not shadowed by a local.
  if (!ctx.wasiNodeFsFuncs.has(callee)) return undefined;
  if (fctx.localMap.has(callee) || (fctx.boxedCaptures?.has(callee) ?? false)) return undefined;
  // fd-based form requires at least (fd, buffer). A bare/path-based call is not ours.
  if (expr.arguments.length < 2) return undefined;
  const shimIdx = callee === "readSync" ? ctx.nodeFsReadSyncIdx : ctx.nodeFsWriteSyncIdx;
  if (shimIdx < 0) return undefined;

  return callee === "readSync"
    ? emitNodeFsReadSync(ctx, fctx, expr, shimIdx)
    : emitNodeFsWriteSync(ctx, fctx, expr, shimIdx);
}

/**
 * Extract the optional `offset` / `length` arguments shared by readSync and
 * writeSync. Supports both the positional form
 * `(fd, buf, offset?, length?, position?)` and the options form
 * `(fd, buf, { offset?, length?, position? })`. Emits two i32 locals
 * (offset, length); `length` defaults to `buf.length - offset` when absent, so
 * over-read/over-write past the buffer is impossible by construction.
 *
 * `bufLenLocal` is an i32 local already holding the buffer's element length.
 */
function emitNodeFsOffsetLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  bufLenLocal: number,
): { offLocal: number; lenLocal: number } {
  const offLocal = allocLocal(fctx, `__nodefs_off_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__nodefs_len_${fctx.locals.length}`, { kind: "i32" });

  const arg2 = expr.arguments[2];
  const optionsObj = arg2 && ts.isObjectLiteralExpression(arg2) ? arg2 : undefined;

  // ---- offset ----
  let offsetExpr: ts.Expression | undefined;
  if (optionsObj) {
    offsetExpr = findObjectProp(optionsObj, "offset");
  } else {
    offsetExpr = arg2;
  }
  if (offsetExpr) {
    compileExpression(ctx, fctx, offsetExpr, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: offLocal } as Instr);

  // ---- length ----  (default: buf.length - offset)
  let lengthExpr: ts.Expression | undefined;
  if (optionsObj) {
    lengthExpr = findObjectProp(optionsObj, "length");
  } else {
    lengthExpr = expr.arguments[3];
  }
  if (lengthExpr) {
    compileExpression(ctx, fctx, lengthExpr, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "local.get", index: bufLenLocal } as Instr);
    fctx.body.push({ op: "local.get", index: offLocal } as Instr);
    fctx.body.push({ op: "i32.sub" } as Instr);
  }
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);

  return { offLocal, lenLocal };
}

/** Find a non-shorthand object-literal property initializer by name, or undefined. */
function findObjectProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === name))
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

/**
 * Resolve the GC `$Vec`-backed Uint8Array argument into its (vecTypeIdx,
 * arrTypeIdx) and emit code that leaves nothing on the stack but stores the vec
 * ref + the underlying i8 array ref + the element length into fresh i32/ref
 * locals. Returns those locals, or `null` if the arg isn't a GC Uint8Array.
 */
function emitNodeFsResolveGcU8(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: ts.Expression,
): { arrLocal: number; arrTypeIdx: number; lenLocal: number } | null {
  const bufType = compileExpression(ctx, fctx, bufExpr);
  if (!bufType || (bufType.kind !== "ref" && bufType.kind !== "ref_null") || !("typeIdx" in bufType)) {
    if (bufType) fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  const vecTypeIdx = bufType.typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct" || vecDef.fields.length < 2) {
    fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  if (bufType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);

  const vecLocal = allocLocal(fctx, `__nodefs_vec_${fctx.locals.length}`, { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.set", index: vecLocal } as Instr);
  // element length = vec.length (field 0)
  const lenLocal = allocLocal(fctx, `__nodefs_buflen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
  // backing i8 array = vec.data (field 1)
  const arrLocal = allocLocal(fctx, `__nodefs_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: vecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal } as Instr);

  return { arrLocal, arrTypeIdx, lenLocal };
}

/** Emit `fd` (arg0) truncated to i32 into a fresh local; returns the local. */
function emitNodeFsFd(ctx: CodegenContext, fctx: FunctionContext, fdExpr: ts.Expression): number {
  const fdLocal = allocLocal(fctx, `__nodefs_fd_${fctx.locals.length}`, { kind: "i32" });
  compileExpression(ctx, fctx, fdExpr, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "local.set", index: fdLocal } as Instr);
  return fdLocal;
}

/**
 * `readSync(fd, buf, offset?, length?, position?)` /
 * `readSync(fd, buf, { offset?, length?, position? })` → read up to `length`
 * bytes from `fd` into `buf[offset .. offset+length)`; return the byte count.
 *
 * Lowering: call the shim `read_sync(fd, WASI_STDIN_BUF_START, length)` into the
 * shared linear scratch, then copy the returned bytes into the GC array at
 * `offset`. (Linear-backed buffers read straight into `ptr+offset`, zero-copy.)
 */
function emitNodeFsReadSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  shimIdx: number,
): InnerResult {
  const fdLocal = emitNodeFsFd(ctx, fctx, expr.arguments[0]!);

  // Zero-copy fast path: linear-backed Uint8Array reads straight into ptr+off.
  const linBuf = getLinearU8Buffer(ctx, fctx, expr.arguments[1]!);
  if (linBuf) {
    const { offLocal, lenLocal } = emitNodeFsOffsetLength(ctx, fctx, expr, linBuf.lenLocalIdx);
    fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
    fctx.body.push({ op: "local.get", index: linBuf.ptrLocalIdx } as Instr);
    fctx.body.push({ op: "local.get", index: offLocal } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
    fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
    fctx.body.push({ op: "call", funcIdx: shimIdx } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  const gc = emitNodeFsResolveGcU8(ctx, fctx, expr.arguments[1]!);
  if (!gc) {
    // Not a recognizable buffer — emit 0 (no bytes read) so codegen continues.
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return { kind: "f64" };
  }
  const { offLocal, lenLocal } = emitNodeFsOffsetLength(ctx, fctx, expr, gc.lenLocal);

  // Grow memory if the scratch read region (WASI_STDIN_BUF_START + length) would
  // exceed current pages.
  ensureScratchPages(fctx, WASI_STDIN_BUF_START, lenLocal);

  // nread = read_sync(fd, WASI_STDIN_BUF_START, length)
  const nreadLocal = allocLocal(fctx, `__nodefs_nread_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: WASI_STDIN_BUF_START } as Instr);
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "call", funcIdx: shimIdx } as Instr);
  fctx.body.push({ op: "local.set", index: nreadLocal } as Instr);

  // Copy buf_dest[off + j] = scratch[j] for j in [0, nread).
  emitScratchToArrayCopy(fctx, gc.arrTypeIdx, gc.arrLocal, offLocal, WASI_STDIN_BUF_START, nreadLocal);

  fctx.body.push({ op: "local.get", index: nreadLocal } as Instr);
  fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  return { kind: "f64" };
}

/**
 * `writeSync(fd, buf, offset?, length?, position?)` → write
 * `buf[offset .. offset+length)` to `fd`; return the byte count.
 *
 * Lowering: copy the GC array slice into the shared linear scratch, then call
 * the shim `write_sync(fd, WASI_WRITE_SCRATCH_START, length)`. (Linear-backed
 * buffers write straight from `ptr+offset`, zero-copy.)
 */
function emitNodeFsWriteSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  shimIdx: number,
): InnerResult {
  const fdLocal = emitNodeFsFd(ctx, fctx, expr.arguments[0]!);

  // Zero-copy fast path: linear-backed Uint8Array writes straight from ptr+off.
  const linBuf = getLinearU8Buffer(ctx, fctx, expr.arguments[1]!);
  if (linBuf) {
    const { offLocal, lenLocal } = emitNodeFsOffsetLength(ctx, fctx, expr, linBuf.lenLocalIdx);
    fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
    fctx.body.push({ op: "local.get", index: linBuf.ptrLocalIdx } as Instr);
    fctx.body.push({ op: "local.get", index: offLocal } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
    fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
    fctx.body.push({ op: "call", funcIdx: shimIdx } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  const gc = emitNodeFsResolveGcU8(ctx, fctx, expr.arguments[1]!);
  if (!gc) {
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return { kind: "f64" };
  }
  const { offLocal, lenLocal } = emitNodeFsOffsetLength(ctx, fctx, expr, gc.lenLocal);

  // Grow memory if the write scratch region would exceed current pages.
  ensureScratchPages(fctx, WASI_WRITE_SCRATCH_START, lenLocal);

  // Copy scratch[j] = buf[off + j] for j in [0, length).
  emitArrayToScratchCopy(fctx, gc.arrTypeIdx, gc.arrLocal, offLocal, WASI_WRITE_SCRATCH_START, lenLocal);

  // nwritten = write_sync(fd, WASI_WRITE_SCRATCH_START, length)
  fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr);
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "call", funcIdx: shimIdx } as Instr);
  fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  return { kind: "f64" };
}

/** Grow linear memory so [scratchStart, scratchStart + lenLocal) is addressable. */
function ensureScratchPages(fctx: FunctionContext, scratchStart: number, lenLocal: number): void {
  const needPagesLocal = allocLocal(fctx, `__nodefs_pages_${fctx.locals.length}`, { kind: "i32" });
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
}

/** for j in [0, countLocal): dest[off + j] = scratch[scratchStart + j] (i8 array). */
function emitScratchToArrayCopy(
  fctx: FunctionContext,
  arrTypeIdx: number,
  arrLocal: number,
  offLocal: number,
  scratchStart: number,
  countLocal: number,
): void {
  const jLocal = allocLocal(fctx, `__nodefs_j_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: jLocal } as Instr);
  const loopBody: Instr[] = [
    { op: "local.get", index: jLocal } as Instr,
    { op: "local.get", index: countLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    { op: "local.get", index: arrLocal } as Instr,
    { op: "local.get", index: offLocal } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    // value = scratch[scratchStart + j]
    { op: "i32.const", value: scratchStart } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.load8_u", align: 0, offset: 0 } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx } as Instr,
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
}

/** for j in [0, countLocal): scratch[scratchStart + j] = src[off + j] (i8 array). */
function emitArrayToScratchCopy(
  fctx: FunctionContext,
  arrTypeIdx: number,
  arrLocal: number,
  offLocal: number,
  scratchStart: number,
  countLocal: number,
): void {
  const jLocal = allocLocal(fctx, `__nodefs_wj_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: jLocal } as Instr);
  const loopBody: Instr[] = [
    { op: "local.get", index: jLocal } as Instr,
    { op: "local.get", index: countLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // addr = scratchStart + j
    { op: "i32.const", value: scratchStart } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    // value = src[off + j]  (array.get_u on i8 array)
    { op: "local.get", index: arrLocal } as Instr,
    { op: "local.get", index: offLocal } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    { op: "array.get_u", typeIdx: arrTypeIdx } as Instr,
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
}
