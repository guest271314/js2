// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Exact standalone dispatch for a transferred String.prototype.charAt closure.
 *
 * The native closure ABI is `(self, thisValue, position) -> externref`, while
 * `__apply_closure`'s generic method bridge installs the receiver only in
 * `__current_this` and fills every user parameter from the argument vector.
 * Keep the exception local to charAt: the builtin metadata id distinguishes its
 * closure even though WasmGC canonicalizes structurally equivalent meta types.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/**
 * Non-$Object arm for `__extern_method_call`. Closed/fnctor structs are outside
 * the existing object/vec/closure carrier ladder, but late `__extern_get` arms
 * can recover their stored or prototype charAt value. Restrict the new route to
 * the interned literal name; user functions stored there still flow through the
 * unchanged generic apply bridge.
 */
export function buildTransferredCharAtMethodArm(
  ctx: CodegenContext,
  externGetIdx: number,
  applyClosureIdx: number,
): Instr[] {
  if (ctx.nativeStrTypeIdx < 0) return [];
  return [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.nativeStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx },
        ...nativeStringLiteralInstrs(ctx, "charAt"),
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: externGetIdx },
            ...(ctx.funcMap.has("__nullish_to_null")
              ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
              : []),
            { op: "local.get", index: 0 },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: applyClosureIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

export function buildTransferredCharAtApplyArm(ctx: CodegenContext, argOf: (index: number) => Instr[]): Instr[] {
  const metaEntry = Array.from(ctx.builtinFnMetaTypeByKey?.entries() ?? []).find(([key]) =>
    key.endsWith(":method:charAt"),
  );
  if (!metaEntry) return [];

  const [key, metaTypeIdx] = metaEntry;
  const closureInfo = ctx.closureInfoByTypeIdx.get(metaTypeIdx);
  const brand = key.split(":")[1];
  const funcIdx = brand === undefined ? undefined : ctx.funcMap.get(`__proto_method_${brand}_charAt`);
  const funcType = closureInfo === undefined ? undefined : ctx.mod.types[closureInfo.funcTypeIdx];
  if (
    closureInfo === undefined ||
    funcIdx === undefined ||
    funcType?.kind !== "func" ||
    closureInfo.paramTypes.length !== 2 ||
    closureInfo.paramTypes[0]?.kind !== "externref" ||
    closureInfo.paramTypes[1]?.kind !== "externref" ||
    closureInfo.returnType?.kind !== "externref"
  ) {
    return [];
  }

  const selfType = funcType.params[0];
  if (!selfType || (selfType.kind !== "ref" && selfType.kind !== "ref_null")) return [];

  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: metaTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Equivalent metadata structs share one Wasm runtime type. Field 3 is
        // the stable exact-identity discriminator minted with the closure.
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: metaTypeIdx },
        { op: "struct.get", typeIdx: metaTypeIdx, fieldIdx: 3 },
        { op: "i32.const", value: metaTypeIdx },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // self
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: selfType.typeIdx },
            // explicit native-prototype receiver
            { op: "local.get", index: 1 },
            // position (missing -> the ordinary undefined sentinel)
            ...argOf(0),
            { op: "call", funcIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}
