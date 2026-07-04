// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2856 C2) On-demand `__vec_elem_set_<vecTypeIdx>` helper — the IR's
// element-store dual of the legacy inline `compileElementAssignment` vec
// path (src/codegen/expressions/assignment.ts). One defined function per
// vec struct type, materialized lazily via the IR resolver's `resolveFunc`
// interception (same append-only discipline as `ensureFmod`, #2945 — a
// DEFINED function appended at mint time, never an import, so no existing
// funcIdx shifts).
//
// Semantics — EXACT legacy parity (JS `arr[i] = v` on a growable vec):
//   1. Null receiver → throw TypeError (`ref.null.extern` payload on the
//      shared `__exn` tag) — the legacy null-guard shape (#441).
//   2. idx >= capacity → grow the backing array to
//      `max(idx + 1, oldCap * 2, 4)`, copy the old contents, and point the
//      vec's `data` field at the new array (legacy grow sequence,
//      assignment.ts:4094-4178).
//   3. `data[idx] = val`.
//   4. idx + 1 > vec.length → vec.length = idx + 1 (JS length update on
//      OOB writes).
//
// The helper is pure WasmGC — no host import — so it works identically in
// JS-host and standalone modes (the dual-mode rule).
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { ensureExnTag } from "./registry/imports.js";

/** Reserved name prefix; the suffix is the vec STRUCT typeIdx. */
export const VEC_ELEM_SET_PREFIX = "__vec_elem_set_";

/**
 * Ensure the element-store helper for the vec struct at `vecTypeIdx` exists
 * and return its funcIdx. Idempotent (funcMap-cached by name).
 *
 * Signature: `((ref null $vec_<t>) vec, i32 idx, <elem> val) -> ()`.
 *
 * Returns `null` (no helper) when `vecTypeIdx` doesn't name a recognisable
 * `{ length: i32, data: (ref $arr) }` vec struct — the caller treats that
 * as a clean IR demotion.
 */
export function ensureVecElemSet(ctx: CodegenContext, vecTypeIdx: number): number | null {
  const name = `${VEC_ELEM_SET_PREFIX}${vecTypeIdx}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct" || vecDef.fields.length !== 2) return null;
  if (vecDef.fields[0]?.name !== "length" || vecDef.fields[1]?.name !== "data") return null;
  const dataField = vecDef.fields[1]!.type;
  if (dataField.kind !== "ref" && dataField.kind !== "ref_null") return null;
  const arrTypeIdx = (dataField as { typeIdx: number }).typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  // Packed i8/i16 elements have no value-position encoding for the `val`
  // param (#2159) — those vecs back TypedArrays, which the IR element-store
  // arm refuses at from-ast time anyway. Refuse here too, defensively.
  const elem = arrDef.element;
  if (elem.kind === "i8" || elem.kind === "i16") return null;

  const tagIdx = ensureExnTag(ctx);
  const vecParam: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const sigIdx = addFuncType(ctx, [vecParam, { kind: "i32" }, elem], [], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);

  // Params: 0=vec, 1=idx, 2=val. Locals: 3=data, 4=newCap, 5=newData, 6=oldCap.
  const VEC = 0;
  const IDX = 1;
  const VAL = 2;
  const DATA = 3;
  const NCAP = 4;
  const NDATA = 5;
  const OCAP = 6;

  const body: Instr[] = [
    // ── Null guard (#441 parity): if (vec == null) throw TypeError ─────────
    { op: "local.get", index: VEC },
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
      else: [],
    } as Instr,
    // ── data = vec.data ─────────────────────────────────────────────────────
    { op: "local.get", index: VEC },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: DATA },
    // ── Grow when idx >= capacity (legacy sequence) ─────────────────────────
    { op: "local.get", index: IDX },
    { op: "local.get", index: DATA },
    { op: "array.len" } as Instr,
    { op: "i32.ge_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // oldCap = array.len(data)
        { op: "local.get", index: DATA } as Instr,
        { op: "array.len" } as Instr,
        { op: "local.set", index: OCAP } as Instr,
        // newCap = idx + 1
        { op: "local.get", index: IDX } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: NCAP } as Instr,
        // if (oldCap * 2 > newCap) newCap = oldCap * 2
        { op: "local.get", index: OCAP } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.shl" } as Instr,
        { op: "local.get", index: NCAP } as Instr,
        { op: "i32.gt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: OCAP } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.shl" } as Instr,
            { op: "local.set", index: NCAP } as Instr,
          ],
        } as Instr,
        // if (4 > newCap) newCap = 4
        { op: "i32.const", value: 4 } as Instr,
        { op: "local.get", index: NCAP } as Instr,
        { op: "i32.gt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 4 } as Instr, { op: "local.set", index: NCAP } as Instr],
        } as Instr,
        // newData = array.new_default(newCap)
        { op: "local.get", index: NCAP } as Instr,
        { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
        { op: "local.set", index: NDATA } as Instr,
        // array.copy newData[0..oldCap] = data[0..oldCap]
        { op: "local.get", index: NDATA } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: DATA } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: OCAP } as Instr,
        { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
        // vec.data = newData
        { op: "local.get", index: VEC } as Instr,
        { op: "local.get", index: NDATA } as Instr,
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        // data = newData
        { op: "local.get", index: NDATA } as Instr,
        { op: "local.set", index: DATA } as Instr,
      ],
    } as Instr,
    // ── data[idx] = val ─────────────────────────────────────────────────────
    { op: "local.get", index: DATA },
    { op: "local.get", index: IDX },
    { op: "local.get", index: VAL },
    { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    // ── if (idx + 1 > vec.length) vec.length = idx + 1 ─────────────────────
    { op: "local.get", index: IDX },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: VEC },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
    { op: "i32.gt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: VEC } as Instr,
        { op: "local.get", index: IDX } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
      ],
    } as Instr,
  ];

  const fn: WasmFunction = {
    name,
    typeIdx: sigIdx,
    locals: [
      { name: "$data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "$ncap", type: { kind: "i32" } },
      { name: "$ndata", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "$ocap", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}
