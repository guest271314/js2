// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Timsort for WasmGC native arrays — SELF-HOSTED (#3159, array family
 * slice 1 of the porffor model; algorithm bodies live as ordinary TS
 * source in `src/stdlib/array-sort.ts` and compile through the
 * compiler's own pipeline via `src/codegen/stdlib-selfhost.ts`).
 *
 * This file keeps only the Wasm-facing plumbing:
 *   1. `ensureArrayIntrinsics` — tiny typed raw-array accessors
 *      (`__arri_get_<k>` / `__arri_set_<k>` / `__arri_new_<k>` /
 *      `__arri_copy_<k>`) the stdlib source calls by name. Indices are
 *      f64 params truncated internally (`i32.trunc_sat_f64_s`) because
 *      from-ast call args require exact IrType match and stdlib index
 *      arithmetic is f64. This is Precursor B of
 *      `plan/self-hosting-scale-up.md` — reusable by every later
 *      array/string/dataview slice.
 *   2. A ~6-instr thunk preserving the external ABI
 *      `__timsort_<k>(vec) -> ()` — extracts (data, len) from the vec
 *      struct and calls the self-hosted `__sh_timsort_<k>(data, len)`.
 *
 * Behavior notes (vs the deleted hand `Instr[]` bodies, 922 → ~230
 * lines): sorted output is bit-exact — the TS sources mirror the hand
 * algorithm op-for-op (same compare directions, so identical NaN
 * behavior and stability; see the array-sort.ts header). Internal
 * kernel signatures moved index params from i32 to f64 (exact for all
 * array indices) and the run stack from i32 to f64 arrays (values are
 * run bases/lengths — exact); both are unobservable outside the kernel
 * family. Features preserved: natural run detection, descending run
 * reversal, minRun computation, insertion sort for short runs, stable
 * merge, stack-based merge policy. Galloping mode remains omitted.
 */

import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { irVal, type IrType } from "../ir/nodes.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";
import { emitSelfHostedFunc, type SelfHostedFuncDef } from "./stdlib-selfhost.js";
import { timsortKernelDefs, type SortElemKind } from "../stdlib/array-sort.js";

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

/**
 * Materialize the four raw-array intrinsics for one element kind
 * (idempotent — funcMap-guarded). Each is a real defined function, so
 * correctness never depends on any inlining pass; bodies are 3–8 instrs.
 */
function ensureArrayIntrinsics(ctx: CodegenContext, arrTypeIdx: number, k: SortElemKind): void {
  if (ctx.funcMap.get(`__arri_get_${k}`) !== undefined) return;
  const arrRef: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const elem: ValType = { kind: k };
  const f64: ValType = { kind: "f64" };

  // __arri_get_<k>(data, i) -> data[trunc(i)]
  emitFunc(
    ctx,
    `__arri_get_${k}`,
    [arrRef, f64],
    [elem],
    [],
    [L(0), L(1), TRUNC, { op: "array.get", typeIdx: arrTypeIdx }],
  );
  // __arri_set_<k>(data, i, v)
  emitFunc(
    ctx,
    `__arri_set_${k}`,
    [arrRef, f64, elem],
    [],
    [],
    [L(0), L(1), TRUNC, L(2), { op: "array.set", typeIdx: arrTypeIdx }],
  );
  // __arri_new_<k>(n) -> fresh zero-filled array
  emitFunc(
    ctx,
    `__arri_new_${k}`,
    [f64],
    [arrRef],
    [],
    [L(0), TRUNC, { op: "array.new_default", typeIdx: arrTypeIdx }],
  );
  // __arri_copy_<k>(dst, dstOff, src, srcOff, n) — overlap-safe array.copy
  emitFunc(
    ctx,
    `__arri_copy_${k}`,
    [arrRef, f64, arrRef, f64, f64],
    [],
    [],
    [
      L(0),
      L(1),
      TRUNC,
      L(2),
      L(3),
      TRUNC,
      L(4),
      TRUNC,
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    ],
  );
}

/**
 * Callee signature table for one element kind: the four self-hosted
 * kernels + the element and run-stack intrinsics. Shared by every kernel
 * def (from-ast only consults entries a body actually calls).
 */
function kernelCalleeTypes(
  k: SortElemKind,
  dataRef: IrType,
  stackRef: IrType,
): Map<string, { params: readonly IrType[]; returnType: IrType | null }> {
  const NUM: IrType = irVal({ kind: "f64" });
  const elem: IrType = irVal({ kind: k });
  const sigs = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>([
    [`__arri_get_${k}`, { params: [dataRef, NUM], returnType: elem }],
    [`__arri_set_${k}`, { params: [dataRef, NUM, elem], returnType: null }],
    [`__arri_new_${k}`, { params: [NUM], returnType: dataRef }],
    [`__arri_copy_${k}`, { params: [dataRef, NUM, dataRef, NUM, NUM], returnType: null }],
    [`__sh_isort_${k}`, { params: [dataRef, NUM, NUM], returnType: null }],
    [`__sh_merge_${k}`, { params: [dataRef, dataRef, NUM, NUM, NUM], returnType: null }],
    [`__sh_merge_run_${k}`, { params: [dataRef, dataRef, stackRef, stackRef, NUM, NUM], returnType: NUM }],
  ]);
  if (k !== "f64") {
    // Run-stack intrinsics operate on the canonical f64 array type.
    sigs.set("__arri_get_f64", { params: [stackRef, NUM], returnType: NUM });
    sigs.set("__arri_set_f64", { params: [stackRef, NUM, NUM], returnType: null });
    sigs.set("__arri_new_f64", { params: [NUM], returnType: stackRef });
    sigs.set("__arri_copy_f64", { params: [stackRef, NUM, stackRef, NUM, NUM], returnType: null });
  }
  return sigs;
}

// ---------------------------------------------------------------------------
// Public API: ensure Timsort helpers are emitted, return funcIdx of __timsort
// ---------------------------------------------------------------------------
export function ensureTimsortHelper(
  ctx: CodegenContext,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemKind: "i32" | "f64",
): number {
  const name = `__timsort_${elemKind}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // Run stack (start positions + lengths) lives in canonical f64 arrays
  // (hand version: i32 arrays — values are run bases/lengths, exact in f64).
  const f64ArrTypeIdx = getOrRegisterArrayType(ctx, "f64");
  if (elemKind === "f64" && arrTypeIdx !== f64ArrTypeIdx) {
    // The intrinsic names embed only the elem kind, so the f64 element
    // array MUST be the canonical f64 array type (it always is — vecs
    // register through the same registry). Loud guard beats a miscompile.
    throw new Error(`timsort: non-canonical f64 array typeIdx ${arrTypeIdx} (canonical ${f64ArrTypeIdx})`);
  }
  ensureArrayIntrinsics(ctx, f64ArrTypeIdx, "f64");
  if (elemKind === "i32") ensureArrayIntrinsics(ctx, arrTypeIdx, "i32");

  const dataRef: IrType = irVal({ kind: "ref_null", typeIdx: arrTypeIdx });
  const stackRef: IrType = irVal({ kind: "ref_null", typeIdx: f64ArrTypeIdx });
  const NUM: IrType = irVal({ kind: "f64" });
  const calleeTypes = kernelCalleeTypes(elemKind, dataRef, stackRef);
  const paramType = (p: "data" | "stack" | "num"): IrType => (p === "data" ? dataRef : p === "stack" ? stackRef : NUM);

  // Compile the four kernels leaf-first through our own pipeline.
  let shTimsortIdx = -1;
  for (const kernel of timsortKernelDefs(elemKind)) {
    const def: SelfHostedFuncDef = {
      name: kernel.name,
      source: kernel.source,
      paramTypes: kernel.params.map(paramType),
      returnType: kernel.ret === "num" ? NUM : null,
      calleeTypes,
    };
    shTimsortIdx = emitSelfHostedFunc(ctx, def);
  }

  // External-ABI thunk: __timsort_<k>(vec) — extract (data, len) and call
  // the self-hosted driver. Kept hand-written (vec struct access is not in
  // the stdlib dialect; 6 instrs).
  const vecRef: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const dataL = 1; // local 0 is the vec param; local 1 holds the extracted data array
  const dataLocal: LocalDef = { name: "__ts_data", type: { kind: "ref_null", typeIdx: arrTypeIdx } };
  return emitFunc(
    ctx,
    name,
    [vecRef],
    [],
    [dataLocal],
    [
      // data = vec.data
      L(0),
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: dataL },
      // arg0: data
      { op: "local.get", index: dataL },
      // arg1: effLen = min(vec.length, array.len(data)) — (#3201) clamp the sort
      // length to the physical backing so a sparse array (logical `.length`
      // beyond the backing) does not trap on the out-of-bounds element access in
      // the kernel. Beyond-backing indices are holes that sort to the end
      // (§23.1.3.30); dense arrays keep the logical length (backing ≥ length).
      L(0),
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.get", index: dataL },
      { op: "array.len" },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [L(0), { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }],
        else: [{ op: "local.get", index: dataL }, { op: "array.len" }],
      },
      { op: "f64.convert_i32_s" },
      { op: "call", funcIdx: shTimsortIdx },
    ],
  );
}
