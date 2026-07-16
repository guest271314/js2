// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted number-format emission (#3305 — parse/format family).
 *
 * Wasm-facing plumbing for the TS sources in `src/stdlib/number-format.ts`
 * (the timsort/#3159 split): tiny f64-ABI micro-kernels over the scratch
 * i16 buffer, the self-hosted body compiled through the compiler's own IR
 * pipeline, and a legacy-ABI thunk under the original funcMap name.
 *
 * Micro-kernels (`__nfd_*`, all f64-ABI — from-ast call args require exact
 * IrType match, and stdlib index arithmetic is f64):
 *   - `__nfd_new(cap) -> (ref null $__str_data)` — scratch buffer alloc.
 *   - `__nfd_get(buf, i) -> f64` / `__nfd_set(buf, i, v)` — code-unit access
 *     (trunc internally; get widens via `f64.convert_i32_u`).
 *   - `__nfd_fin(buf, len) -> (ref $AnyString)` — copies `buf[0..len)` into a
 *     tight `$NativeString`, exactly like the retained `__num_fmt_finalize`
 *     (which keeps serving the hand-written Ryu/toFixed/… siblings) but
 *     returning the struct ref so the self-hosted body can type it as
 *     `string`; the legacy thunk adds the `extern.convert_any`.
 *   - `__num_fmt_trap()` — `unreachable`; preserves the hand body's
 *     MAX_SAFE_INTEGER trap parity (#1335 Phase 2 pending).
 *
 * Emitted from `emitNativeNumberFormat` (native/standalone only), inside the
 * same append-only stable-regime window as the hand siblings — all functions
 * mint via `mintDefinedFunc`, so late-import shifts skip them identically.
 */
import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { irVal, type IrType } from "../ir/nodes.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitSelfHostedFunc } from "./stdlib-selfhost.js";
import { numToStringRadixDef } from "../stdlib/number-format.js";

const L = (i: number): Instr => ({ op: "local.get", index: i });
const TRUNC: Instr = { op: "i32.trunc_sat_f64_s" };

function emitFunc(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: LocalDef[],
  body: Instr[],
): number {
  const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/** Materialize the `__nfd_*` buffer micro-kernels (idempotent via funcMap). */
function ensureNumFmtBufKernels(ctx: CodegenContext): void {
  if (ctx.funcMap.get("__nfd_new") !== undefined) return;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const bufRef: ValType = { kind: "ref_null", typeIdx: strDataTypeIdx };
  const f64: ValType = { kind: "f64" };
  const i32: ValType = { kind: "i32" };
  const anyStrRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };

  // __nfd_new(cap) -> fresh zero-filled scratch buffer
  emitFunc(ctx, "__nfd_new", [f64], [bufRef], [], [L(0), TRUNC, { op: "array.new_default", typeIdx: strDataTypeIdx }]);
  // __nfd_get(buf, i) -> f64 code unit
  emitFunc(
    ctx,
    "__nfd_get",
    [bufRef, f64],
    [f64],
    [],
    [L(0), L(1), TRUNC, { op: "array.get_u", typeIdx: strDataTypeIdx }, { op: "f64.convert_i32_u" }],
  );
  // __nfd_set(buf, i, v)
  emitFunc(
    ctx,
    "__nfd_set",
    [bufRef, f64, f64],
    [],
    [],
    [L(0), L(1), TRUNC, L(2), TRUNC, { op: "array.set", typeIdx: strDataTypeIdx }],
  );
  // __num_fmt_trap() — unreachable (hand-parity for the unsafe-integer arm)
  emitFunc(ctx, "__num_fmt_trap", [], [], [], [{ op: "unreachable" }]);

  // __nfd_fin(buf, len) -> (ref $AnyString): copy buf[0..len) into a tight
  // $NativeString — the same copy loop as __num_fmt_finalize, f64-ABI, struct
  // result (the legacy thunk widens to externref).
  const L_BUF = 0;
  const L_LENF = 1;
  const L_LEN = 2;
  const L_OUT = 3;
  const L_I = 4;
  emitFunc(
    ctx,
    "__nfd_fin",
    [bufRef, f64],
    [anyStrRef],
    [
      { name: "len", type: i32 },
      { name: "out", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "i", type: i32 },
    ],
    [
      L(L_LENF),
      TRUNC,
      { op: "local.set", index: L_LEN },
      L(L_LEN),
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: L_OUT },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_I },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              L(L_I),
              L(L_LEN),
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              L(L_OUT),
              { op: "ref.as_non_null" },
              L(L_I),
              L(L_BUF),
              L(L_I),
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "array.set", typeIdx: strDataTypeIdx },
              L(L_I),
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      L(L_LEN),
      { op: "i32.const", value: 0 },
      L(L_OUT),
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: strTypeIdx },
    ],
  );
}

/**
 * Emit the self-hosted `number_toString_radix` — TS body + legacy
 * `(f64, f64) -> externref` thunk under the original funcMap name.
 * Precondition (matches the hand emitter it replaces): native-string types
 * registered (`emitNativeNumberFormat` runs `ensureNativeStringHelpers`
 * first).
 */
export function emitSelfHostedToStringRadix(ctx: CodegenContext): void {
  ensureNumFmtBufKernels(ctx);
  const bufRef: IrType = irVal({ kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx });
  const shIdx = emitSelfHostedFunc(ctx, numToStringRadixDef(bufRef));

  const f64: ValType = { kind: "f64" };
  emitFunc(
    ctx,
    "number_toString_radix",
    [f64, f64],
    [{ kind: "externref" }],
    [],
    [L(0), L(1), { op: "call", funcIdx: shIdx }, { op: "extern.convert_any" }],
  );
}
