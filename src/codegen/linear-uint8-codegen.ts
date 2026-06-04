// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 Slice B — codegen for linear-backed `Uint8Array` buffers.
 *
 * A buffer proven linear-safe by the #1886 analysis (`ctx.linearUint8`, Slice A)
 * is represented as a `(ptr, len)` pair of i32 locals rather than a WasmGC vec
 * struct. This module owns the per-function buffer registry
 * (`fctx.linearU8Buffers`) and the small emit helpers the four wiring sites call:
 *
 *   - `tryEmitLinearU8New`  — `new Uint8Array(n)` / `new Uint8Array([..])` →
 *     bind `(ptr=__lin_u8_alloc(n), len=n)` instead of `array.new_default`.
 *   - `tryEmitLinearU8ElementGet` — `b[i]` → `i32.load8_u (ptr+i)` widened to f64
 *     (the observable element value type the GC path also returns).
 *   - `tryEmitLinearU8ElementSet` — `b[i] = v` → `i32.store8 (ptr+i), trunc(v)`.
 *   - `tryEmitLinearU8Length` — `b.length` → `len` widened to f64.
 *
 * All entry points are **additive guards**: they return `false`/`null` unless
 * the receiver is a registered linear-safe buffer, so any other `Uint8Array`
 * (escaping, non-WASI, or not yet bound here) falls through to the existing GC
 * path unchanged. Slice B is intraprocedural-only — buffers threaded through
 * function *parameters* keep the GC path until the Slice C signature rewrite.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLinearU8AllocHelper } from "./index.js";
import { compileExpression, VOID_RESULT } from "./shared.js";
import type { InnerResult } from "./shared.js";

/**
 * True when this `Uint8Array` binding is **Slice-B-eligible**: a `new
 * Uint8Array(...)` local whose every use stays inside its function (element
 * load/store, `.length`, `process.std*.{read,write}` I/O) and which is never
 * threaded into a user function. Consults `ctx.linearUint8.localOnlyBindings`
 * (the intraprocedural subset of `safeBindings`) — NOT `safeBindings` itself,
 * which also contains param-threaded buffers that need the Slice-C signature
 * rewrite before their `(ptr,len)` form is valid at a call boundary. Returns
 * false outside WASI or when the analysis didn't run.
 */
export function isLinearSafeBinding(ctx: CodegenContext, node: ts.Node): boolean {
  if (!ctx.linearUint8) return false;
  if (!ts.isIdentifier(node)) return false;
  const sym = ctx.checker.getSymbolAtLocation(node);
  return !!sym && ctx.linearUint8.localOnlyBindings.has(sym);
}

/** Look up the (ptr, len) locals for a linear-backed buffer identifier, if bound. */
function lookupBuffer(fctx: FunctionContext, node: ts.Node): { ptrLocalIdx: number; lenLocalIdx: number } | undefined {
  if (!fctx.linearU8Buffers || !ts.isIdentifier(node)) return undefined;
  return fctx.linearU8Buffers.get(node.text);
}

/**
 * Slice B only knows how to back the **length** and **array-literal** forms of
 * `new Uint8Array(...)` — `new Uint8Array(n)` (allocate `n` zero bytes) and
 * `new Uint8Array([a, b, …])` (allocate + store the literal). The
 * `new Uint8Array(arrayBuffer)` / `new Uint8Array(typedArray)` *view/copy*
 * forms are NOT length forms: their single argument is an object, not a byte
 * count, so treating it as a length would call `__lin_u8_alloc(<object>)` and
 * produce garbage (#1654). Those forms must stay on the GC path, which models
 * the ArrayBuffer-view aliasing correctly. Returns true only for the two forms
 * the linear codegen can faithfully represent.
 */
function isLengthOrLiteralNewUint8(ctx: CodegenContext, newExpr: ts.NewExpression): boolean {
  const args = newExpr.arguments;
  if (!args || args.length === 0) return true; // `new Uint8Array()` ⇒ length 0
  if (args.length > 1) return false; // (start, length) overloads aren't length-form
  const arg = args[0]!;
  if (ts.isArrayLiteralExpression(arg)) return true; // literal form
  // Single-arg: only the numeric length form is linear-representable. Reject
  // when the argument's static type is an object (ArrayBuffer / ArrayBufferLike
  // / a TypedArray / array-like) — that's a view/copy, not a length.
  const t = ctx.checker.getTypeAtLocation(arg);
  if (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Any)) return true;
  // Anything object-typed (ArrayBuffer, Uint8Array, number[], …) is a view/copy.
  return false;
}

/**
 * Slice B is intraprocedural: a binding qualifies for linear backing here only
 * if it is a `new Uint8Array(...)` *local* (not a parameter — params stay GC
 * until the Slice C signature rewrite). The Slice-A set includes params, so we
 * additionally require the declaration to be a `VariableDeclaration` whose
 * initializer is a length-or-literal `new Uint8Array(...)` (not a buffer view).
 */
function isLocalLinearNewBinding(ctx: CodegenContext, nameNode: ts.Identifier): boolean {
  if (!isLinearSafeBinding(ctx, nameNode)) return false;
  const sym = ctx.checker.getSymbolAtLocation(nameNode);
  const decls = sym?.getDeclarations() ?? [];
  return decls.some(
    (d) =>
      ts.isVariableDeclaration(d) &&
      !!d.initializer &&
      ts.isNewExpression(d.initializer) &&
      ts.isIdentifier(d.initializer.expression) &&
      d.initializer.expression.text === "Uint8Array" &&
      isLengthOrLiteralNewUint8(ctx, d.initializer),
  );
}

/**
 * `new Uint8Array(n)` / `new Uint8Array([a,b,…])` for a linear-safe local being
 * declared as `nameNode`. Allocates `(ptr, len)` i32 locals, calls
 * `__lin_u8_alloc(n)`, and (for the array-literal form) stores the literal
 * bytes. Registers the buffer in `fctx.linearU8Buffers` and leaves NOTHING on
 * the value stack (the binding lives in the two i32 locals). Returns true if it
 * handled the `new`; false to fall through to the GC path.
 *
 * Caller contract: invoked from the variable-declaration lowering for a
 * `const/let x = new Uint8Array(...)` where `isLocalLinearNewBinding(x)` holds.
 */
export function tryEmitLinearU8New(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nameNode: ts.Identifier,
  newExpr: ts.NewExpression,
): boolean {
  if (!isLocalLinearNewBinding(ctx, nameNode)) return false;
  const allocIdx = ensureLinearU8AllocHelper(ctx);
  if (allocIdx < 0) return false;

  const args = newExpr.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
  const ptrLocal = allocLocal(fctx, `__linu8_ptr_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__linu8_len_${fctx.locals.length}`, { kind: "i32" });

  // Array-literal form: `new Uint8Array([a, b, c])` — length = element count,
  // then store each (constant or computed) byte.
  if (args.length === 1 && ts.isArrayLiteralExpression(args[0]!)) {
    const elems = args[0]!.elements;
    fctx.body.push({ op: "i32.const", value: elems.length } as Instr);
    fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
    fctx.body.push({ op: "i32.const", value: elems.length } as Instr);
    fctx.body.push({ op: "call", funcIdx: allocIdx } as Instr);
    fctx.body.push({ op: "local.set", index: ptrLocal } as Instr);
    elems.forEach((el, i) => {
      // address = ptr + i
      fctx.body.push({ op: "local.get", index: ptrLocal } as Instr);
      if (i > 0) {
        fctx.body.push({ op: "i32.const", value: i } as Instr);
        fctx.body.push({ op: "i32.add" } as Instr);
      }
      // value = trunc(elem) — element expr compiled in f64 then truncated to a byte.
      compileExpression(ctx, fctx, el, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "i32.store8", align: 0, offset: 0 } as Instr);
    });
    registerBuffer(fctx, nameNode.text, ptrLocal, lenLocal);
    return true;
  }

  // Length form: `new Uint8Array(n)` (or `new Uint8Array()` ⇒ 0).
  if (args.length >= 1) {
    compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: lenLocal } as Instr);
  // ptr = __lin_u8_alloc(len)
  fctx.body.push({ op: "local.get", index: lenLocal } as Instr);
  fctx.body.push({ op: "call", funcIdx: allocIdx } as Instr);
  fctx.body.push({ op: "local.set", index: ptrLocal } as Instr);
  registerBuffer(fctx, nameNode.text, ptrLocal, lenLocal);
  return true;
}

function registerBuffer(fctx: FunctionContext, name: string, ptrLocalIdx: number, lenLocalIdx: number): void {
  if (!fctx.linearU8Buffers) fctx.linearU8Buffers = new Map();
  fctx.linearU8Buffers.set(name, { ptrLocalIdx, lenLocalIdx });
}

/**
 * `b[i]` read for a linear-backed buffer → `i32.load8_u (ptr + trunc(i))`,
 * widened to f64 to match the observable element value type the GC path
 * returns. Returns the result ValType, or `null` if `b` is not linear-backed.
 */
export function tryEmitLinearU8ElementGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  const buf = lookupBuffer(fctx, expr.expression);
  if (!buf) return null;
  // address = ptr + trunc(index)
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 } as Instr);
  fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
  return { kind: "f64" };
}

/**
 * `b[i] = v` for a linear-backed buffer → `i32.store8 (ptr + trunc(i)),
 * trunc(v) & 0xff`, leaving **nothing** on the stack and returning
 * `VOID_RESULT`. Returns `null` if `b` is not a linear-backed buffer (caller
 * falls through to GC).
 *
 * The assignment compiles as a statement (the common case — e.g. the
 * native-messaging frame builder writes `buf[i] = (buf[i] + 1) & 255`). Unlike
 * the GC `array.set` path, this does NOT push the assigned value as the
 * expression result: `x = buf[i] = v` value-of-assignment is not yet supported
 * for linear-backed buffers (out of scope for the I/O-buffer workloads this
 * targets — the analysis only admits buffers that never appear as a bare
 * identifier). See the `return VOID_RESULT` note below for why pushing the value
 * broke void-function completion.
 *
 * Evaluation order matches JS + the GC path: index expression first, then the
 * value expression, then the store.
 */
export function tryEmitLinearU8ElementSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  valueExpr: ts.Expression,
): InnerResult {
  const buf = lookupBuffer(fctx, target.expression);
  if (!buf) return null;
  // Allocate the result/addr temps up-front so their slot indices are fixed
  // before the nested index/value sub-expressions compile (those allocate their
  // own temps as they go). Each sub-expression is fully evaluated into a temp
  // before the next is compiled, so no stash ever interleaves with another
  // expression's temp usage on the value stack (#1886).
  const addrLocal = allocLocal(fctx, `__linu8_addr_${fctx.locals.length}`, { kind: "i32" });
  const valLocal = allocLocal(fctx, `__linu8_val_${fctx.locals.length}`, { kind: "f64" });

  // addr = ptr + trunc(index)  (index evaluated first, per JS + the GC path)
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "local.set", index: addrLocal } as Instr);
  // val = v (kept as f64 for the assignment-expression result)
  compileExpression(ctx, fctx, valueExpr, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: valLocal } as Instr);
  // mem[addr] = (u8) trunc(val) — low byte kept by i32.store8.
  fctx.body.push({ op: "local.get", index: addrLocal } as Instr);
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "i32.store8", align: 0, offset: 0 } as Instr);
  // Leave NOTHING on the stack and return VOID_RESULT: `buf[i] = v` compiles as
  // a statement (the common case, e.g. the native-messaging frame builder). The
  // assigned value lives in `valLocal` if a value-context caller ever needs it,
  // but pushing it here as the expression result and letting the statement
  // wrapper drop it created a `local.get;drop` pair that the peephole removed —
  // which then left the function/module completion-value tracker owing an
  // unpaired `ref.null extern` at the end of a void function (invalid wasm,
  // #1886). Returning VOID_RESULT keeps the body balanced. (`x = buf[i] = v`
  // value-of-assignment is not yet supported for linear-backed buffers — out of
  // scope for the I/O-buffer workloads this targets; tracked for a follow-up.)
  return VOID_RESULT;
}

/** `b.length` for a linear-backed buffer → `len` widened to f64. */
export function tryEmitLinearU8Length(fctx: FunctionContext, expr: ts.PropertyAccessExpression): ValType | null {
  if (expr.name.text !== "length") return null;
  const buf = lookupBuffer(fctx, expr.expression);
  if (!buf) return null;
  fctx.body.push({ op: "local.get", index: buf.lenLocalIdx } as Instr);
  fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
  return { kind: "f64" };
}

/** Accessor used by the WASI I/O intrinsics to get a buffer's (ptr, len) locals. */
export function getLinearU8Buffer(
  fctx: FunctionContext,
  node: ts.Node,
): { ptrLocalIdx: number; lenLocalIdx: number } | undefined {
  return lookupBuffer(fctx, node);
}

/**
 * Zero-copy `process.stdin.read(buf, off?)` for a linear-backed buffer.
 * `fd_read` targets `ptr + off` directly (no GC↔linear element-copy loop) and
 * returns the byte count (f64). Returns `null` if `buf` is not linear-backed.
 *
 * Layout reuse: the iovec lives at memory[0..7] and nwritten/nread at
 * memory[8..11] — the same scratch slots the existing `__wasi_write_*` helpers
 * and the GC stdin-read path use.
 */
export function tryEmitLinearU8StdinRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  fdReadIdx: number,
): ValType | null {
  const buf = lookupBuffer(fctx, expr.arguments[0]!);
  if (!buf) return null;

  // off = arg1 (trunc) or 0
  const offLocal = allocLocal(fctx, `__linu8_rdoff_${fctx.locals.length}`, { kind: "i32" });
  if (expr.arguments.length >= 2) {
    compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: offLocal } as Instr);

  // iovec.buf = ptr + off   (memory[0])
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  fctx.body.push({ op: "local.get", index: offLocal } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // iovec.buf_len = len - off   (memory[4])
  fctx.body.push({ op: "i32.const", value: 4 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.lenLocalIdx } as Instr);
  fctx.body.push({ op: "local.get", index: offLocal } as Instr);
  fctx.body.push({ op: "i32.sub" } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // fd_read(fd=0, iovs=0, iovs_len=1, nread=8) — bytes land directly in linear
  // memory at ptr+off (zero copy).
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "call", funcIdx: fdReadIdx } as Instr);
  fctx.body.push({ op: "drop" } as Instr);
  // return nread (memory[8]) as f64
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "i32.load", align: 2, offset: 0 } as Instr);
  fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  return { kind: "f64" };
}

/**
 * Zero-copy `process.stdout/stderr.write(buf)` for a linear-backed buffer.
 * `fd_write` reads straight from `ptr` for `len` bytes — no GC→linear staging
 * copy. Returns `true` if handled (and leaves the i32 `1` write-result on the
 * stack, matching the GC write path), `null` if `buf` is not linear-backed.
 */
export function tryEmitLinearU8StdWrite(
  fctx: FunctionContext,
  bufArg: ts.Expression,
  fdWriteIdx: number,
  useStderr: boolean,
): boolean {
  const buf = lookupBuffer(fctx, bufArg);
  if (!buf) return false;
  const fd = useStderr ? 2 : 1;
  // iovec.buf = ptr (memory[0])
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // iovec.buf_len = len (memory[4])
  fctx.body.push({ op: "i32.const", value: 4 } as Instr);
  fctx.body.push({ op: "local.get", index: buf.lenLocalIdx } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  // fd_write(fd, iovs=0, iovs_len=1, nwritten=8) — reads directly from ptr.
  fctx.body.push({ op: "i32.const", value: fd } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "call", funcIdx: fdWriteIdx } as Instr);
  fctx.body.push({ op: "drop" } as Instr);
  return true;
}
