// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Representation-neutral runtime helpers used by IR dynamic operations.

import type { Instr, ValType } from "../ir/types.js";
import { ensureAnyFromExternHelper, ensureAnyHelpers, ensureAnyToExternHelper } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

export const IR_DYN_ADD_FN = "__ir_dyn_add";
export const IR_DYN_LT_FN = "__ir_dyn_lt";
export const IR_DYN_LE_FN = "__ir_dyn_le";
export const IR_DYN_GT_FN = "__ir_dyn_gt";
export const IR_DYN_GE_FN = "__ir_dyn_ge";
export const IR_DYN_METHOD_CALL_0_FN = "__ir_dyn_method_call_0";
export const IR_DYN_METHOD_CALL_1_FN = "__ir_dyn_method_call_1";

export type IrDynamicRuntimeNeed = "add" | "lt" | "le" | "gt" | "ge" | "method-call-0" | "method-call-1";

type RelNeed = "lt" | "le" | "gt" | "ge";

function addHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  body: Instr[],
  locals: { name: string; type: ValType }[] = [],
): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, params, results, name);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false } as never);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

function relName(op: RelNeed): string {
  switch (op) {
    case "lt":
      return IR_DYN_LT_FN;
    case "le":
      return IR_DYN_LE_FN;
    case "gt":
      return IR_DYN_GT_FN;
    case "ge":
      return IR_DYN_GE_FN;
  }
}

function anyRelName(op: RelNeed): string {
  return `__any_${op}`;
}

function compareSignBody(op: RelNeed, localIdx: number): Instr[] {
  switch (op) {
    case "lt":
      return [{ op: "local.get", index: localIdx }, { op: "i32.const", value: -1 }, { op: "i32.eq" }];
    case "gt":
      return [{ op: "local.get", index: localIdx }, { op: "i32.const", value: 1 }, { op: "i32.eq" }];
    case "le":
      return [
        { op: "local.get", index: localIdx },
        { op: "i32.const", value: -1 },
        { op: "i32.eq" },
        { op: "local.get", index: localIdx },
        { op: "i32.eqz" },
        { op: "i32.or" },
      ];
    case "ge":
      return [
        { op: "local.get", index: localIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        { op: "local.get", index: localIdx },
        { op: "i32.eqz" },
        { op: "i32.or" },
      ];
  }
}

function numericRelOp(op: RelNeed): "f64.lt" | "f64.le" | "f64.gt" | "f64.ge" {
  return `f64.${op}`;
}

function ensureDynamicAdd(ctx: CodegenContext, carrier: ValType): void {
  if (ctx.fast) {
    ensureAnyHelpers(ctx);
    const anyAdd = ctx.funcMap.get("__any_add");
    if (anyAdd === undefined) throw new Error("dyn-ops: __any_add unavailable for fast dynamic carrier");
    ctx.funcMap.set(IR_DYN_ADD_FN, anyAdd);
    return;
  }

  if (!ctx.standalone && !ctx.wasi) {
    const hostAdd = ensureLateImport(ctx, "__host_add", [carrier, carrier], [carrier]);
    flushLateImportShifts(ctx, null);
    const settled = ctx.funcMap.get("__host_add") ?? hostAdd;
    if (settled === undefined) throw new Error("dyn-ops: __host_add unavailable");
    ctx.funcMap.set(IR_DYN_ADD_FN, settled);
    return;
  }

  ensureAnyHelpers(ctx);
  const honest = ensureAnyFromExternHelper(ctx, { forceHonest: true });
  const toExtern = ensureAnyToExternHelper(ctx);
  const anyAdd = ctx.funcMap.get("__any_add");
  if (honest === undefined || toExtern === undefined || anyAdd === undefined) {
    throw new Error(
      `dyn-ops: standalone dynamic add dependencies unavailable (fromExtern=${honest !== undefined}, toExtern=${toExtern !== undefined}, anyAdd=${anyAdd !== undefined})`,
    );
  }
  addHelper(
    ctx,
    IR_DYN_ADD_FN,
    [carrier, carrier],
    [carrier],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: honest },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: honest },
      { op: "call", funcIdx: anyAdd },
      { op: "call", funcIdx: toExtern },
    ],
  );
}

function ensureDynamicRel(ctx: CodegenContext, carrier: ValType, op: RelNeed): void {
  if (ctx.fast) {
    ensureAnyHelpers(ctx);
    const anyRel = ctx.funcMap.get(anyRelName(op));
    if (anyRel === undefined) throw new Error(`dyn-ops: ${anyRelName(op)} unavailable for fast dynamic carrier`);
    ctx.funcMap.set(relName(op), anyRel);
    return;
  }

  const i32: ValType = { kind: "i32" };
  if (!ctx.standalone && !ctx.wasi) {
    const hostCompare = ensureLateImport(ctx, "__host_compare", [carrier, carrier], [i32]);
    flushLateImportShifts(ctx, null);
    const settled = ctx.funcMap.get("__host_compare") ?? hostCompare;
    if (settled === undefined) throw new Error("dyn-ops: __host_compare unavailable");
    addHelper(
      ctx,
      relName(op),
      [carrier, carrier],
      [i32],
      [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: settled },
        { op: "local.set", index: 2 },
        ...compareSignBody(op, 2),
      ],
      [{ name: "cmp", type: i32 }],
    );
    return;
  }

  ensureAnyHelpers(ctx);
  ensureNativeStringHelpers(ctx);
  const typeofString = ctx.funcMap.get("__typeof_string");
  const unboxNumber = ctx.funcMap.get("__unbox_number");
  const flatten = ctx.nativeStrHelpers.get("__str_flatten");
  const compare = ctx.nativeStrHelpers.get("__str_compare");
  if (
    typeofString === undefined ||
    unboxNumber === undefined ||
    flatten === undefined ||
    compare === undefined ||
    ctx.anyStrTypeIdx < 0
  ) {
    throw new Error("dyn-ops: standalone dynamic relational dependencies unavailable");
  }
  const stringCompare: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flatten },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flatten },
    { op: "call", funcIdx: compare },
    { op: "local.set", index: 2 },
    ...compareSignBody(op, 2),
  ];
  const numericCompare: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: unboxNumber },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: unboxNumber },
    { op: numericRelOp(op) },
  ];
  addHelper(
    ctx,
    relName(op),
    [carrier, carrier],
    [i32],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: typeofString },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: typeofString },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: stringCompare,
        else: numericCompare,
      },
    ],
    [{ name: "cmp", type: i32 }],
  );
}

/**
 * Convert a canonical $AnyValue to the raw externref expected at a native
 * method-call receiver/name boundary. Unlike __any_to_extern, string and
 * object tags are intentionally peeled here; all other tags retain the
 * round-trip-preserving conversion used by ordinary dynamic storage.
 */
function ensureDynamicCallBoundaryExtern(ctx: CodegenContext): number {
  const name = "__ir_dyn_call_boundary_extern";
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const fallback = ensureAnyToExternHelper(ctx);
  if (fallback === undefined || ctx.anyValueTypeIdx < 0) {
    throw new Error("dyn-ops: dynamic call-boundary extern bridge unavailable");
  }
  const anyRefNull: ValType = { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  return addHelper(
    ctx,
    name,
    [anyRefNull],
    [externref],
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      // tag 5: raw string externref payload.
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 5 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 4 },
          { op: "return" },
        ],
      },
      // tag 6: raw GC object reference.
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 6 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 },
          { op: "extern.convert_any" },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: fallback },
    ],
    [{ name: "tag", type: i32 }],
  );
}

function ensureDynamicMethodCall(ctx: CodegenContext, carrier: ValType, arity: 0 | 1): void {
  const externref: ValType = { kind: "externref" };
  const standalone = ctx.standalone === true || ctx.wasi === true;
  const arrayNewName = standalone ? "__objvec_new" : "__js_array_new";
  const arrayPushName = standalone ? "__objvec_push" : "__js_array_push";

  if (standalone) {
    ensureObjectRuntime(ctx);
  } else {
    ensureLateImport(ctx, arrayNewName, [], [externref]);
    ensureLateImport(ctx, arrayPushName, [externref, externref], []);
    ensureLateImport(ctx, "__extern_method_call", [externref, externref, externref], [externref]);
    if (ctx.fast) ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
    flushLateImportShifts(ctx, null);
  }

  const arrayNew = ctx.funcMap.get(arrayNewName);
  const arrayPush = ctx.funcMap.get(arrayPushName);
  const methodCall = ctx.funcMap.get("__extern_method_call");
  if (arrayNew === undefined || arrayPush === undefined || methodCall === undefined) {
    throw new Error("dyn-ops: dynamic method-call runtime unavailable");
  }

  let fromExtern: number | undefined;
  let receiverToExtern: number | undefined;
  let keyToExtern: number | undefined;
  let argumentToExtern: number | undefined;
  let resultFromExtern: number | undefined;
  if (standalone) {
    const rawExtern = ensureDynamicCallBoundaryExtern(ctx);
    receiverToExtern = rawExtern;
    keyToExtern = rawExtern;
    if (ctx.fast) {
      argumentToExtern = ensureAnyToExternHelper(ctx);
      resultFromExtern = ensureAnyFromExternHelper(ctx, { forceHonest: true });
      if (argumentToExtern === undefined || resultFromExtern === undefined) {
        throw new Error("dyn-ops: fast standalone method-call carrier bridge unavailable");
      }
    } else {
      fromExtern = ensureAnyFromExternHelper(ctx, { forceHonest: true });
      if (fromExtern === undefined) {
        throw new Error("dyn-ops: standalone method-call classifier unavailable");
      }
    }
  } else if (ctx.fast) {
    throw new Error("dyn-ops: fast host dynamic method calls are not enabled");
  }

  const argsLocal = 2 + arity;
  const body: Instr[] = [
    { op: "call", funcIdx: arrayNew },
    { op: "local.set", index: argsLocal },
  ];
  if (arity === 1) {
    body.push(
      { op: "local.get", index: argsLocal },
      { op: "local.get", index: 2 },
      ...(argumentToExtern === undefined ? [] : ([{ op: "call", funcIdx: argumentToExtern }] satisfies Instr[])),
      { op: "call", funcIdx: arrayPush },
    );
  }
  body.push(
    { op: "local.get", index: 0 },
    ...(fromExtern === undefined ? [] : ([{ op: "call", funcIdx: fromExtern }] satisfies Instr[])),
    ...(receiverToExtern === undefined ? [] : ([{ op: "call", funcIdx: receiverToExtern }] satisfies Instr[])),
    { op: "local.get", index: 1 },
    ...(fromExtern === undefined ? [] : ([{ op: "call", funcIdx: fromExtern }] satisfies Instr[])),
    ...(keyToExtern === undefined ? [] : ([{ op: "call", funcIdx: keyToExtern }] satisfies Instr[])),
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: methodCall },
    ...(resultFromExtern === undefined ? [] : ([{ op: "call", funcIdx: resultFromExtern }] satisfies Instr[])),
  );

  addHelper(
    ctx,
    arity === 0 ? IR_DYN_METHOD_CALL_0_FN : IR_DYN_METHOD_CALL_1_FN,
    Array.from({ length: 2 + arity }, () => carrier),
    [carrier],
    body,
    [{ name: "args", type: externref }],
  );
}

export function ensureIrDynamicRuntime(ctx: CodegenContext, needs: ReadonlySet<IrDynamicRuntimeNeed>): void {
  if (needs.size === 0) return;
  if (ctx.fast) ensureAnyHelpers(ctx);
  const carrier: ValType = ctx.fast ? { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx } : { kind: "externref" };

  if (needs.has("add")) ensureDynamicAdd(ctx, carrier);
  for (const op of ["lt", "le", "gt", "ge"] as const) {
    if (needs.has(op)) ensureDynamicRel(ctx, carrier, op);
  }
  if (needs.has("method-call-0")) ensureDynamicMethodCall(ctx, carrier, 0);
  if (needs.has("method-call-1")) ensureDynamicMethodCall(ctx, carrier, 1);
}
