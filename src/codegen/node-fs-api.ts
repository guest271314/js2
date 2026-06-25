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
import { isKnownMember, isMemberSatisfiable } from "../checker/node-capability-map.js";
import { isStringType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitDataViewToWriteScratch } from "./dataview-native.js";
import { noJsHost } from "./expressions/helpers.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import {
  ensureWasiWriteAnyStringFdHelper,
  ensureWasiWriteAnyStringHelper,
  ensureWasiWriteArrayBufferHelper,
  ensureWasiWriteUint8ArrayHelper,
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  WASI_READSYNC_IOV_OFFSET,
  WASI_READSYNC_NREAD_OFFSET,
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
  // The "no provider" gate (#1772 P2-a) fires under `--target wasi` regardless of
  // `--link-node-shims`, so it must sit AFTER the `!ctx.wasi` guard but BEFORE the
  // combined `!ctx.linkNodeShims` short-circuit and the readSync/writeSync match.
  if (!ctx.wasi) return undefined;

  // #1772 P2-a — deliberate "no provider" compile error. A `node:fs` member that
  // the program imported, is known to the capability map, but is NOT satisfiable
  // under the active target (e.g. path-based `readFileSync` under standalone WASI
  // with no `--allow-fs`), must error here at compile time rather than fall
  // through to a silent link-time failure. The fd-based `readSync`/`writeSync`
  // stay satisfiable (providersFor → ["wasi-fd"]) so this is a no-op for them.
  if (ts.isIdentifier(expr.expression) && !expr.questionDotToken) {
    const member = expr.expression.text;
    // Only gate members the program actually imported from `node:fs`, and that
    // are not shadowed by a local binding — a local `function readFileSync(){}`
    // must NOT be gated. `ctx.wasiNodeFsFuncs` is the set of node:fs imports.
    const importedFromNodeFs =
      ctx.wasiNodeFsFuncs.has(member) && !fctx.localMap.has(member) && !(fctx.boxedCaptures?.has(member) ?? false);
    if (importedFromNodeFs && isKnownMember("node:fs", member)) {
      // #2647 — thread the real `--allow-fs` flag (was hardcoded `false` in the
      // atomic #1772 P2-a slice, PR #2014). With `--allow-fs` under a JS host, a
      // path-based `node:fs` member (`readFileSync(path)`) resolves through the
      // `js-host-fs` provider and becomes satisfiable; without it the precise
      // "no provider under --target wasi" error still fires. fd-based
      // `readSync`/`writeSync` are satisfiable regardless (providersFor →
      // ["wasi-fd"]), so this is a no-op for them.
      const target = { wasi: ctx.wasi, allowFs: ctx.allowFs };
      if (isMemberSatisfiable("node:fs", member, target) === false) {
        ctx.errors.push({
          message:
            `\`node:fs.${member}\` needs a filesystem provider, unavailable under \`--target wasi\`. ` +
            "Pass `--allow-fs` for the JS-host filesystem provider, or use the fd-based " +
            "`readSync`/`writeSync(fd, …)` for standalone WASI (no path_open/preopens).",
          line: 1,
          column: 1,
          severity: "error",
        });
        // Consumed: return the file's "handled" sentinel so the generic
        // host-import path does not also fire on this call.
        return VOID_RESULT;
      }
    }
  }

  // #2655 — fd-based readSync/writeSync lower via EITHER the `node:fs` shim
  // (`--link-node-shims`: the imported `(fd,ptr,len) -> i32` shim funcs) OR the
  // DIRECT WASI Preview-1 path (`!ctx.linkNodeShims`: the
  // `wasi_snapshot_preview1.fd_read`/`fd_write` syscalls). The direct path makes
  // a standalone stdio program a self-contained WASI P1 command module importing
  // ONLY `wasi_snapshot_preview1` — no shim, no Node runtime (loopdive/js2#389).
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

  // Pick the sink + mode. Shim: the imported `(fd,ptr,len)->i32` func. Direct:
  // the WASI syscall funcidx (a no-op `-1` if it somehow wasn't registered).
  const direct = !ctx.linkNodeShims;
  if (direct) {
    const syscallIdx = callee === "readSync" ? ctx.wasiFdReadIdx : ctx.wasiFdWriteIdx;
    if (syscallIdx === undefined || syscallIdx < 0) return undefined;
    return callee === "readSync"
      ? emitNodeFsReadSync(ctx, fctx, expr, syscallIdx, true)
      : emitNodeFsWriteSync(ctx, fctx, expr, syscallIdx, true);
  }
  const shimIdx = callee === "readSync" ? ctx.nodeFsReadSyncIdx : ctx.nodeFsWriteSyncIdx;
  if (shimIdx < 0) return undefined;
  return callee === "readSync"
    ? emitNodeFsReadSync(ctx, fctx, expr, shimIdx, false)
    : emitNodeFsWriteSync(ctx, fctx, expr, shimIdx, false);
}

/**
 * #2655 — emit the per-`fd` "read `len` bytes from `fd` into linear `ptrLocal`,
 * leaving the byte count on the stack as i32". Two modes:
 *   - shim (`direct=false`): `read_sync(fd, ptr, len)` — the imported shim owns
 *     the iovec + syscall over the shared memory; it returns the byte count.
 *   - direct (`direct=true`): build a `{ base=ptr, len }` iovec at
 *     `WASI_READSYNC_IOV_OFFSET`, call the BLOCKING
 *     `fd_read(fd, iovs, 1, nread=WASI_READSYNC_NREAD_OFFSET)`, then load nread.
 *     An errno != 0 yields 0 bytes (read loops treat `r <= 0` as EOF/stop).
 *
 * `ptrLocal`/`lenLocal` are i32 locals already holding the destination linear
 * pointer and the requested length; `fdLocal` holds the fd.
 */
function emitFdReadRuntime(
  fctx: FunctionContext,
  fdLocal: number,
  ptrLocal: number,
  lenLocal: number,
  sinkIdx: number,
  direct: boolean,
): void {
  if (!direct) {
    fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
    fctx.body.push({ op: "local.get", index: ptrLocal } as Instr);
    fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
    fctx.body.push({ op: "call", funcIdx: sinkIdx } as Instr);
    return;
  }
  // Build the iovec { base=ptr, len } at WASI_READSYNC_IOV_OFFSET.
  fctx.body.push({ op: "i32.const", value: WASI_READSYNC_IOV_OFFSET } as Instr);
  fctx.body.push({ op: "local.get", index: ptrLocal } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: WASI_READSYNC_IOV_OFFSET + 4 } as Instr);
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // errno = fd_read(fd, iovs=IOV, iovs_len=1, nread=NREAD)
  fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: WASI_READSYNC_IOV_OFFSET } as Instr);
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: WASI_READSYNC_NREAD_OFFSET } as Instr);
  fctx.body.push({ op: "call", funcIdx: sinkIdx } as Instr);
  // errno on the stack: if non-zero, push 0 bytes; else load nread.
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 0 } as Instr],
    else: [
      { op: "i32.const", value: WASI_READSYNC_NREAD_OFFSET } as Instr,
      { op: "i32.load", align: 2, offset: 0 } as Instr,
    ],
  } as Instr);
}

/**
 * #2655 — emit the per-`fd` "write `len` bytes from linear `ptrLocal` to `fd`,
 * leaving the byte count on the stack as i32". Two modes:
 *   - shim (`direct=false`): `write_sync(fd, ptr, len)` returns the byte count.
 *   - direct (`direct=true`): build a `{ base=ptr, len }` iovec at memory[0..7],
 *     call `fd_write(fd, iovs=0, 1, nwritten=8)`, then load nwritten. An
 *     errno != 0 yields 0 bytes (write loops treat `w <= 0` as stop). The
 *     memory[0..11] iovec/nwritten scratch matches `emitWasiWriteTail`; a single
 *     writeSync call never interleaves with another write over it.
 */
function emitFdWriteRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fdLocal: number,
  ptrLocal: number,
  lenLocal: number,
  sinkIdx: number,
  direct: boolean,
): void {
  if (!direct) {
    fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
    fctx.body.push({ op: "local.get", index: ptrLocal } as Instr);
    fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
    fctx.body.push({ op: "call", funcIdx: sinkIdx } as Instr);
    return;
  }
  // iovec.base = ptr at memory[0]; iovec.len = len at memory[4].
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: ptrLocal } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 4 } as Instr);
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // errno = fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
  fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "call", funcIdx: sinkIdx } as Instr);
  // errno on the stack: non-zero → 0 bytes; else load nwritten at memory[8].
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 0 } as Instr],
    else: [{ op: "i32.const", value: 8 } as Instr, { op: "i32.load", align: 2, offset: 0 } as Instr],
  } as Instr);
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
/**
 * #2045 C.7 — clamp the i32 in `valLocal` into `[0, hiLocal]` in place:
 * `val = min(max(val, 0), hi)`. Uses signed `select` so a negative trunc_sat
 * result (from a negative JS offset/length) maps to 0, and an over-large value
 * caps at `hi`. `hiLocal` is assumed non-negative (bufLen, or bufLen-offset
 * after offset was already clamped to <= bufLen).
 */
function emitClampI32(fctx: FunctionContext, valLocal: number, hiLocal: number): void {
  // val = max(val, 0)  ==  select(val, 0, val > 0)
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.gt_s" } as Instr);
  fctx.body.push({ op: "select" } as Instr);
  fctx.body.push({ op: "local.set", index: valLocal } as Instr);
  // val = min(val, hi)  ==  select(val, hi, val < hi)
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  fctx.body.push({ op: "local.get", index: hiLocal } as Instr);
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  fctx.body.push({ op: "local.get", index: hiLocal } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  fctx.body.push({ op: "select" } as Instr);
  fctx.body.push({ op: "local.set", index: valLocal } as Instr);
}

function emitNodeFsOffsetLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  bufLenLocal: number,
): { offLocal: number; lenLocal: number } {
  const offLocal = allocLocal(fctx, `__nodefs_off_${fctx.locals.length}`, {
    kind: "i32",
  });
  const lenLocal = allocLocal(fctx, `__nodefs_len_${fctx.locals.length}`, {
    kind: "i32",
  });

  const arg2 = expr.arguments[2];
  const optionsObj = arg2 && ts.isObjectLiteralExpression(arg2) ? arg2 : undefined;

  // ---- offset ----
  let offsetExpr: ts.Expression | undefined;
  if (optionsObj) {
    offsetExpr = findObjectProp(optionsObj, "offset");
  } else {
    offsetExpr = arg2;
  }
  const explicitOffset = offsetExpr !== undefined;
  if (offsetExpr) {
    compileExpression(ctx, fctx, offsetExpr, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: offLocal } as Instr);

  // #2045 C.7 — clamp an EXPLICIT offset into [0, bufLen] so a too-large or
  // negative offset can never address past the buffer. The default (absent)
  // offset is 0 and needs no clamp. Negative truncs to a negative i32; the
  // `max(.,0)` (signed-lt select) maps it to 0, and `min(.,bufLen)` caps it.
  if (explicitOffset) {
    emitClampI32(fctx, offLocal, bufLenLocal);
  }

  // ---- length ----  (default: buf.length - offset)
  let lengthExpr: ts.Expression | undefined;
  if (optionsObj) {
    lengthExpr = findObjectProp(optionsObj, "length");
  } else {
    lengthExpr = expr.arguments[3];
  }
  const explicitLength = lengthExpr !== undefined;
  if (lengthExpr) {
    compileExpression(ctx, fctx, lengthExpr, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "local.get", index: bufLenLocal } as Instr);
    fctx.body.push({ op: "local.get", index: offLocal } as Instr);
    fctx.body.push({ op: "i32.sub" } as Instr);
  }
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);

  // #2045 C.7 — clamp an EXPLICIT length into [0, bufLen - offset] so
  // `offset + length` can never exceed the buffer (the same soundness invariant
  // the absent-length branch satisfies by construction). Without this, an
  // explicit `length` > buf.length silently read/wrote arbitrary linear memory
  // past the buffer (OOB read on writeSync = info leak; OOB write on readSync =
  // the A.2 silent-corruption class). The remaining-capacity bound is computed
  // from the already-clamped offset (offset <= bufLen ⇒ bufLen - offset >= 0).
  if (explicitLength) {
    const capLocal = allocLocal(fctx, `__nodefs_cap_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: bufLenLocal } as Instr);
    fctx.body.push({ op: "local.get", index: offLocal } as Instr);
    fctx.body.push({ op: "i32.sub" } as Instr);
    fctx.body.push({ op: "local.set", index: capLocal } as Instr);
    emitClampI32(fctx, lenLocal, capLocal);
  }

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

  const vecLocal = allocLocal(fctx, `__nodefs_vec_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: vecTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: vecLocal } as Instr);
  // element length = vec.length (field 0)
  const lenLocal = allocLocal(fctx, `__nodefs_buflen_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: vecLocal } as Instr);
  fctx.body.push({
    op: "struct.get",
    typeIdx: vecTypeIdx,
    fieldIdx: 0,
  } as Instr);
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
  // backing i8 array = vec.data (field 1)
  const arrLocal = allocLocal(fctx, `__nodefs_arr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: vecLocal } as Instr);
  fctx.body.push({
    op: "struct.get",
    typeIdx: vecTypeIdx,
    fieldIdx: 1,
  } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal } as Instr);

  return { arrLocal, arrTypeIdx, lenLocal };
}

/** Emit `fd` (arg0) truncated to i32 into a fresh local; returns the local. */
function emitNodeFsFd(ctx: CodegenContext, fctx: FunctionContext, fdExpr: ts.Expression): number {
  const fdLocal = allocLocal(fctx, `__nodefs_fd_${fctx.locals.length}`, {
    kind: "i32",
  });
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
  sinkIdx: number,
  direct: boolean,
): InnerResult {
  const fdLocal = emitNodeFsFd(ctx, fctx, expr.arguments[0]!);

  // Zero-copy fast path: linear-backed Uint8Array reads straight into ptr+off.
  const linBuf = getLinearU8Buffer(ctx, fctx, expr.arguments[1]!);
  if (linBuf) {
    const { offLocal, lenLocal } = emitNodeFsOffsetLength(ctx, fctx, expr, linBuf.lenLocalIdx);
    // dst = ptr + off
    const dstLocal = allocLocal(fctx, `__nodefs_rdst_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: linBuf.ptrLocalIdx } as Instr);
    fctx.body.push({ op: "local.get", index: offLocal } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
    fctx.body.push({ op: "local.set", index: dstLocal } as Instr);
    emitFdReadRuntime(fctx, fdLocal, dstLocal, lenLocal, sinkIdx, direct);
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

  // nread = read(fd, WASI_STDIN_BUF_START, length)  [shim call or direct fd_read]
  const scratchPtrLocal = allocLocal(fctx, `__nodefs_rscratch_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: WASI_STDIN_BUF_START } as Instr);
  fctx.body.push({ op: "local.set", index: scratchPtrLocal } as Instr);
  const nreadLocal = allocLocal(fctx, `__nodefs_nread_${fctx.locals.length}`, {
    kind: "i32",
  });
  emitFdReadRuntime(fctx, fdLocal, scratchPtrLocal, lenLocal, sinkIdx, direct);
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
  sinkIdx: number,
  direct: boolean,
): InnerResult {
  const arg1 = expr.arguments[1]!;
  const arg1Type = ctx.checker.getTypeAtLocation(arg1);

  // #2639 — STRING overload: writeSync(fd, str, position?, encoding?). The fd is
  // a runtime arg (not just 1/2), so encode the string to UTF-8 and write via the
  // runtime-fd string helper, which returns the bytes written. `encoding?` (arg3)
  // defaults to utf8; an explicit non-UTF-8 encoding is a clear compile error
  // rather than a silent mis-encode. `position?` (arg2) is ignored for the fd
  // streaming case, exactly as the buffer overload ignores it for fd 0/1/2.
  if (isStringType(arg1Type)) {
    return emitNodeFsWriteSyncString(ctx, fctx, expr);
  }

  // #2639 — DataView arg: resolve its i32_byte backing + byteOffset/byteLength to
  // a (ptr, len) over the write scratch, then write. DataView is part of
  // __NodeFsArrayBufferView but isn't a GC $Vec the offset/length path
  // recognizes, so handle it explicitly before the generic resolution.
  if (arg1Type.getSymbol?.()?.name === "DataView") {
    return emitNodeFsWriteSyncDataView(ctx, fctx, expr, sinkIdx, direct);
  }

  const fdLocal = emitNodeFsFd(ctx, fctx, expr.arguments[0]!);

  // Zero-copy fast path: linear-backed Uint8Array writes straight from ptr+off.
  const linBuf = getLinearU8Buffer(ctx, fctx, expr.arguments[1]!);
  if (linBuf) {
    const { offLocal, lenLocal } = emitNodeFsOffsetLength(ctx, fctx, expr, linBuf.lenLocalIdx);
    // src = ptr + off
    const srcLocal = allocLocal(fctx, `__nodefs_wsrc_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: linBuf.ptrLocalIdx } as Instr);
    fctx.body.push({ op: "local.get", index: offLocal } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
    fctx.body.push({ op: "local.set", index: srcLocal } as Instr);
    emitFdWriteRuntime(ctx, fctx, fdLocal, srcLocal, lenLocal, sinkIdx, direct);
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

  // nwritten = write(fd, WASI_WRITE_SCRATCH_START, length)  [shim or direct]
  const scratchPtrLocal = allocLocal(fctx, `__nodefs_wscratch_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr);
  fctx.body.push({ op: "local.set", index: scratchPtrLocal } as Instr);
  emitFdWriteRuntime(ctx, fctx, fdLocal, scratchPtrLocal, lenLocal, sinkIdx, direct);
  fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  return { kind: "f64" };
}

/**
 * The `node:fs` `writeSync(fd, str, position?, encoding?)` STRING overload's
 * supported encodings. We materialize the string as UTF-8 bytes (the WasmGC
 * native-string lowering's only byte form), so only the utf8 aliases are
 * faithful; any other listed `BufferEncoding` would silently mis-encode, so we
 * reject it at compile time with a clear pointer.
 */
const WRITESYNC_UTF8_ENCODINGS = new Set(["utf8", "utf-8"]);

/**
 * #2639 — lower the STRING overload `writeSync(fd, str, position?, encoding?)`:
 * encode `str` to UTF-8 and write to the runtime `fd` via the shim, returning the
 * byte count (f64). `encoding?` defaults to utf8; an explicit non-utf8 literal is
 * a compile error. `position?` is ignored for the fd streaming case (matching the
 * buffer overload). Returns `VOID_RESULT` (after pushing a diagnostic) on an
 * unsupported encoding or when the native-string runtime is unavailable.
 */
function emitNodeFsWriteSyncString(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  // Reject an explicit non-utf8 string-literal encoding (arg index 3).
  const encArg = expr.arguments[3];
  if (encArg && ts.isStringLiteralLike(encArg) && !WRITESYNC_UTF8_ENCODINGS.has(encArg.text.toLowerCase())) {
    ctx.errors.push({
      message:
        `node:fs writeSync(fd, str, position?, encoding) only supports the utf8 encoding under ` +
        `--target wasi (got "${encArg.text}"). Encode the string yourself and pass the bytes as a ` +
        `Uint8Array/DataView if you need another encoding.`,
      line: 1,
      column: 1,
      severity: "error",
    });
    return VOID_RESULT;
  }

  // fd (arg0) → i32 local.
  const fdLocal = emitNodeFsFd(ctx, fctx, expr.arguments[0]!);

  // Compile the string arg to a native-string ref, then call the runtime-fd
  // string writer: __wasi_write_any_string_fd(str, fd) -> bytesWritten (i32).
  const compiled = compileExpression(ctx, fctx, expr.arguments[1]!);
  flushLateImportShifts(ctx, fctx);
  const writeStrFdIdx = ensureWasiWriteAnyStringFdHelper(ctx);
  if (compiled && ctx.nativeStrTypeIdx >= 0 && writeStrFdIdx >= 0) {
    if (compiled.kind === "ref_null") {
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
    }
    // Stash the string ref, push (str, fd), call, convert byte count to f64.
    const strLocal = allocLocal(fctx, `__nodefs_wstr_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: ctx.nativeStrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: strLocal } as Instr);
    fctx.body.push({ op: "local.get", index: strLocal } as Instr);
    fctx.body.push({ op: "local.get", index: fdLocal } as Instr);
    fctx.body.push({ op: "call", funcIdx: writeStrFdIdx } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  // Native-string runtime unavailable — drop the compiled string and report 0.
  if (compiled) fctx.body.push({ op: "drop" } as Instr);
  fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  return { kind: "f64" };
}

/**
 * #2639 — lower `writeSync(fd, dataView, …)`: stage the DataView's bytes (its
 * backing i32_byte array windowed by byteOffset/byteLength) into the write
 * scratch, then `writeSync(fd, scratch, viewLen)`. Returns the byte count (f64);
 * on an unresolvable backing it drops the operands and reports 0.
 */
function emitNodeFsWriteSyncDataView(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  sinkIdx: number,
  direct: boolean,
): InnerResult {
  const fdLocal = emitNodeFsFd(ctx, fctx, expr.arguments[0]!);

  // Compile the DataView arg; emitDataViewToWriteScratch consumes the value on
  // the stack, recovers its (backing, base, byteLength), grows memory, and copies
  // the bytes into the scratch — returning the byte-length local.
  const recvType = compileExpression(ctx, fctx, expr.arguments[1]!);
  flushLateImportShifts(ctx, fctx);
  const lenLocal = emitDataViewToWriteScratch(ctx, fctx, recvType, WASI_WRITE_SCRATCH_START);
  if (lenLocal < 0) {
    // Couldn't resolve the DataView backing — drop the operand and report 0.
    if (recvType) fctx.body.push({ op: "drop" } as Instr);
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return { kind: "f64" };
  }

  // nwritten = write(fd, WASI_WRITE_SCRATCH_START, viewLen)  [shim or direct]
  const scratchPtrLocal = allocLocal(fctx, `__nodefs_dvscratch_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr);
  fctx.body.push({ op: "local.set", index: scratchPtrLocal } as Instr);
  emitFdWriteRuntime(ctx, fctx, fdLocal, scratchPtrLocal, lenLocal, sinkIdx, direct);
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
  const jLocal = allocLocal(fctx, `__nodefs_j_${fctx.locals.length}`, {
    kind: "i32",
  });
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
  const jLocal = allocLocal(fctx, `__nodefs_wj_${fctx.locals.length}`, {
    kind: "i32",
  });
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
