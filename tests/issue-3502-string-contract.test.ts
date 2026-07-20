// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import {
  bindLinearStringRuntime,
  LINEAR_STRING_ASCII_PROOF_REQUIRED,
} from "../src/ir/analysis/linear-string-runtime.js";
import { planLinearMemory } from "../src/ir/analysis/linear-memory-plan.js";
import {
  proveTypedStringAppend,
  proveTypedStringMethod,
  type TypedValueEvidence,
} from "../src/ir/analysis/string-evidence.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { irVal, type IrType } from "../src/ir/nodes.js";
import { IR_STRING_RUNTIME, utf16CharAt, utf16CharCodeAt } from "../src/ir/string-runtime.js";

const STRING: IrType = { kind: "string" };
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const sourcePath = "website/public/benchmarks/competitive/programs/string-hash.js";

const stringEvidence = (
  carrierType: IrType,
  stringEncoding: "ascii" | "utf8-guaranteed" | "wtf16",
  semanticSource: "checker" | "producer",
): TypedValueEvidence => ({ semanticType: "string", carrierType, stringEncoding, semanticSource });
const numberEvidence: TypedValueEvidence = {
  semanticType: "number",
  carrierType: F64,
  semanticSource: "checker",
};

describe("#3502 backend-neutral string contract", () => {
  it("records the exact initial unsupported boundary without rewriting the landing source", async () => {
    const source = readFileSync(sourcePath, "utf8");
    await compile(source, { fileName: sourcePath, target: "linear" });
    const report = getLastLinearIrReport();

    expect(report?.compiled).toEqual([]);
    expect(report?.irModule.functions).toEqual([]);
    expect(report?.rejected).toEqual([
      {
        func: "run",
        reason: "build",
        detail: 'ir/from-ast: compound assign to non-f64 slot "text" (i32) not in slice 6 (run)',
      },
    ]);
  });

  it("uses semantic checker/producer evidence instead of the linear carrier", () => {
    const asciiSlot = stringEvidence(I32, "ascii", "checker");
    const asciiProducer = stringEvidence(I32, "ascii", "producer");
    const unicodeProducer = stringEvidence(I32, "utf8-guaranteed", "producer");

    expect(proveTypedStringAppend(asciiSlot, asciiProducer)).toEqual({
      intrinsic: "concat",
      resultType: STRING,
      resultEncoding: "ascii",
    });
    expect(proveTypedStringAppend(asciiSlot, unicodeProducer)?.resultEncoding).toBe("utf8-guaranteed");
    expect(proveTypedStringAppend(asciiSlot, numberEvidence)).toBeNull();
    expect(proveTypedStringAppend(numberEvidence, asciiProducer)).toBeNull();

    expect(proveTypedStringMethod(asciiSlot, "charAt", [])).toMatchObject({
      intrinsic: "char-at",
      omittedIndex: true,
      resultType: STRING,
      receiverEncoding: "ascii",
      resultEncoding: "ascii",
    });
    expect(proveTypedStringMethod(asciiSlot, "charAt", [I32])).toMatchObject({
      intrinsic: "char-at",
      omittedIndex: false,
      indexInputType: I32,
    });
    expect(proveTypedStringMethod(unicodeProducer, "charAt", [F64])?.resultEncoding).toBe("wtf16");
    expect(proveTypedStringMethod(asciiSlot, "charCodeAt", [F64])).toMatchObject({
      intrinsic: "char-code-at",
      resultType: F64,
    });
    expect(proveTypedStringMethod(numberEvidence, "charAt", [F64])).toBeNull();
    expect(proveTypedStringMethod(asciiSlot, "slice", [F64])).toBeNull();
    expect(proveTypedStringMethod(asciiSlot, "charAt", [STRING])).toBeNull();
    expect(proveTypedStringMethod(asciiSlot, "charAt", [F64, F64])).toBeNull();
  });

  it("makes UTF-16 indexing, defaults, and bounds match Node", () => {
    const values = ["", "Az", "é世", "😀", "A😀B", "\ud800", "\udc00", "\ud800A\udc00"];
    const positions: Array<number | undefined> = [
      undefined,
      Number.NaN,
      -Infinity,
      -1,
      -0,
      0,
      0.9,
      1,
      1.9,
      2,
      Infinity,
    ];

    for (const value of values) {
      for (const position of positions) {
        const expectedChar = position === undefined ? value.charAt() : value.charAt(position);
        const expectedCode = position === undefined ? value.charCodeAt() : value.charCodeAt(position);
        expect(utf16CharAt(value, position), `${JSON.stringify(value)}.charAt(${String(position)})`).toBe(expectedChar);
        expect(
          Object.is(utf16CharCodeAt(value, position), expectedCode),
          `${JSON.stringify(value)}.charCodeAt(${String(position)})`,
        ).toBe(true);
      }
    }

    expect(IR_STRING_RUNTIME["char-at"].index).toEqual({
      conversion: "ToIntegerOrInfinity",
      unit: "utf16-code-unit",
      omitted: 0,
      outOfBounds: "empty-string",
    });
    expect(IR_STRING_RUNTIME["char-code-at"].index?.outOfBounds).toBe("nan");
  });

  it("binds only proven ASCII work to the established LinearMemoryPlan layout", () => {
    const registry = new AllocSiteRegistry();
    const builder = new IrFunctionBuilder("strings", [F64], true, registry);
    builder.openBlock();
    const left = builder.emitStringConst("A");
    const right = builder.emitStringConst("B");
    builder.emitStringConcat(left, right);
    builder.emitStringConst("é");
    const zero = builder.emitConst({ kind: "f64", value: 0 }, F64);
    builder.terminate({ kind: "return", values: [zero] });
    const plan = planLinearMemory({ functions: [builder.finish()] }, registry);
    const concat = plan.allocations.find(
      (allocation) => allocation.allocationKind === "string" && allocation.dataSegmentId === undefined,
    );
    const nonAscii = plan.allocations.find((allocation) => allocation.encoding === "utf8-guaranteed");
    expect(concat).toBeDefined();
    expect(concat?.encoding).toBe("ascii");
    expect(nonAscii).toBeDefined();

    const concatBinding = bindLinearStringRuntime(plan, { intrinsic: "concat", alloc: concat!.id });
    expect(concatBinding.operation).toEqual({
      family: "string",
      operation: "concat",
      elementStorage: "i8",
      encoding: "ascii",
    });
    expect(bindLinearStringRuntime(plan, { intrinsic: "length", inputEncoding: "ascii" }).operation).toEqual({
      family: "string",
      operation: "length",
      elementStorage: "i8",
      encoding: "ascii",
    });
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "char-at", inputEncoding: "ascii" })).toThrow(
      /requires an allocation site/,
    );
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "constant", alloc: nonAscii!.id })).toThrow(
      `${LINEAR_STRING_ASCII_PROOF_REQUIRED} for constant result (got utf8-guaranteed)`,
    );
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "char-code-at", inputEncoding: "wtf16" })).toThrow(
      `${LINEAR_STRING_ASCII_PROOF_REQUIRED} for char-code-at input (got wtf16)`,
    );
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "length" })).toThrow(
      `${LINEAR_STRING_ASCII_PROOF_REQUIRED} for length input (got unproven)`,
    );
    expect(JSON.stringify(concatBinding)).not.toMatch(/funcIdx|typeIdx|RawC|renderer|#include|__str_/);
  });
});
