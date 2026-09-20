// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** Typed Boolean carrier extraction; this is not general JavaScript ToBoolean. */
export function buildUnboxBooleanBody(boxBoolStructIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: boxBoolStructIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: boxBoolStructIdx },
        { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
        { op: "return" },
      ],
    },
    // not a boxed bool → false (conservative under wasi)
    { op: "i32.const", value: 0 },
  ];
}

export function buildUnboxBooleanLocals(): LocalDef[] {
  return [{ name: "$any_temp", type: { kind: "anyref" } }];
}

export function buildTypeofBooleanBody(boxBoolStructIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: boxBoolStructIdx },
  ];
}
