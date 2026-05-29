// #1713 — BackendEmitter seam: golden-Instr identity guard.
//
// The refactor moves WasmGC op emission out of `src/ir/lower.ts`'s inline
// switch and behind the `WasmGcEmitter` trait. The zero-delta contract is
// that each emitter method pushes the BYTE-IDENTICAL `Instr` the inline code
// used to push. These tests assert the exact object literal each routed
// primitive emits, so any drift from the audited source line fails loudly
// (this is the "golden-Instr snapshot" the #1713 spec section 7 recommends).
//
// They are pure unit tests of the emitter (no Wasm instantiation), so they
// stay fast and isolate the seam from unrelated IR-pipeline state.

import { describe, expect, it } from "vitest";

import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import type { IrVecLowering } from "../src/ir/backend/handles.js";
import type { Instr } from "../src/ir/types.js";

const emitter = new WasmGcEmitter();

// A representative vec layout. The exact indices are arbitrary — the test
// asserts the emitter threads them through unchanged into the same op shapes
// the inline lower.ts code produced.
const vec: IrVecLowering = {
  vecStructTypeIdx: 7,
  lengthFieldIdx: 0,
  dataFieldIdx: 1,
  arrayTypeIdx: 4,
  elementValType: { kind: "f64" },
};

describe("#1713 WasmGcEmitter — vec group byte-identity", () => {
  it("emitVecLen → struct.get $length (no f64.convert; caller owns that)", () => {
    const out: Instr[] = [];
    emitter.emitVecLen(vec, out);
    expect(out).toEqual([{ op: "struct.get", typeIdx: 7, fieldIdx: 0 }]);
  });

  it("emitVecDataPtr → struct.get $data", () => {
    const out: Instr[] = [];
    emitter.emitVecDataPtr(vec, out);
    expect(out).toEqual([{ op: "struct.get", typeIdx: 7, fieldIdx: 1 }]);
  });

  it("emitElemGet → array.get $arr", () => {
    const out: Instr[] = [];
    emitter.emitElemGet(vec, out);
    expect(out).toEqual([{ op: "array.get", typeIdx: 4 }]);
  });
});

describe("#1713 WasmGcEmitter — pass-through group byte-identity", () => {
  it("emitConst delegates to the shared const lowering (f64.const)", () => {
    const out: Instr[] = [];
    emitter.emitConst(
      {
        kind: "const",
        result: null,
        resultType: { kind: "val", val: { kind: "f64" } },
        value: { kind: "f64", value: 3.5 },
      },
      "f",
      out,
    );
    expect(out).toEqual([{ op: "f64.const", value: 3.5 }]);
  });

  it("emitBinary / emitUnary push the bare op", () => {
    const b: Instr[] = [];
    emitter.emitBinary("f64.add", b);
    expect(b).toEqual([{ op: "f64.add" }]);
    const u: Instr[] = [];
    emitter.emitUnary("i32.eqz", u);
    expect(u).toEqual([{ op: "i32.eqz" }]);
  });

  it("local / global get-set-tee carry the index unchanged", () => {
    const out: Instr[] = [];
    emitter.emitLocalGet(2, out);
    emitter.emitLocalSet(3, out);
    emitter.emitLocalTee(4, out);
    emitter.emitGlobalGet(5, out);
    emitter.emitGlobalSet(6, out);
    expect(out).toEqual([
      { op: "local.get", index: 2 },
      { op: "local.set", index: 3 },
      { op: "local.tee", index: 4 },
      { op: "global.get", index: 5 },
      { op: "global.set", index: 6 },
    ]);
  });

  it("drop / select / return / unreachable are bare ops", () => {
    const out: Instr[] = [];
    emitter.emitDrop(out);
    emitter.emitSelect(out);
    emitter.emitReturn(out);
    emitter.emitUnreachable(out);
    expect(out).toEqual([{ op: "drop" }, { op: "select" }, { op: "return" }, { op: "unreachable" }]);
  });

  it("emitIf nests then/else under a structured if", () => {
    const out: Instr[] = [];
    const then: Instr[] = [{ op: "f64.const", value: 1 }];
    const els: Instr[] = [{ op: "f64.const", value: 2 }];
    emitter.emitIf({ kind: "empty" }, then, els, out);
    expect(out).toEqual([{ op: "if", blockType: { kind: "empty" }, then, else: els }]);
  });

  it("emitBr / emitBrIf carry the depth unchanged", () => {
    const out: Instr[] = [];
    emitter.emitBr(0, out);
    emitter.emitBrIf(1, out);
    expect(out).toEqual([
      { op: "br", depth: 0 },
      { op: "br_if", depth: 1 },
    ]);
  });
});
