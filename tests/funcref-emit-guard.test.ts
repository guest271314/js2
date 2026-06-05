// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Serializer-time function-reference guard (late-import index-shift safety net).
 *
 * The recurring late-registration index-shift class
 * (#1809/#1839/#1602/#1886/@@toPrimitive/`__str_flatten`) produces a `call`
 * `funcIdx` that is either out of range (a failed `funcMap.get` baked as `-1`) or
 * stale-low (captured before a deferred shift). Both used to surface only as an
 * opaque `u32 out of range: -1` at the raw encoder, or as a silently
 * valid-but-wrong index that wasmtime later rejected with
 * "expected externref, found i32" on a random test262 shard.
 *
 * `validateFuncRefs` (env-gated `JS2WASM_VALIDATE_FUNCREFS`) turns that whole
 * class into a named, pinpointed codegen error at emit time. These tests pin:
 *   1. a valid module emits unchanged whether or not the flag is set (no-op);
 *   2. with the flag set, an out-of-range / negative funcIdx throws a named error.
 */
import { afterEach, describe, expect, it } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, WasmFunction, WasmModule } from "../src/ir/types.js";

/** Minimal valid WasmModule with one exported `() -> i32` function returning 0. */
function minimalModule(bodyOverride?: Instr[]): WasmModule {
  const fn: WasmFunction = {
    name: "main",
    typeIdx: 0,
    locals: [],
    body: bodyOverride ?? [{ op: "i32.const", value: 0 } as Instr],
    exported: true,
  };
  return {
    types: [{ kind: "func", name: "type0", params: [], results: [{ kind: "i32" }] }],
    imports: [],
    functions: [fn],
    exports: [{ name: "main", desc: { kind: "func", index: 0 } }],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set(),
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [],
    memories: [],
    dataSegments: [],
  } as unknown as WasmModule;
}

describe("serializer funcref guard", () => {
  afterEach(() => {
    process.env.JS2WASM_VALIDATE_FUNCREFS = "";
  });

  it("is a no-op on a valid module (flag off)", () => {
    process.env.JS2WASM_VALIDATE_FUNCREFS = "";
    expect(() => emitBinary(minimalModule())).not.toThrow();
  });

  it("is a no-op on a valid module (flag on) — a self-call to func 0 is in range", () => {
    process.env.JS2WASM_VALIDATE_FUNCREFS = "1";
    // body: call 0 (recurses into the only defined function) then i32.const 0.
    // funcIdx 0 is in range [0, 1), so the guard must accept it.
    const mod = minimalModule([
      { op: "call", funcIdx: 0 } as Instr,
      { op: "drop" } as Instr,
      { op: "i32.const", value: 0 } as Instr,
    ]);
    expect(() => emitBinary(mod)).not.toThrow();
  });

  it("throws a NAMED error on a -1 funcIdx (failed funcMap lookup) when flag on", () => {
    process.env.JS2WASM_VALIDATE_FUNCREFS = "1";
    const mod = minimalModule([{ op: "call", funcIdx: -1 } as Instr, { op: "i32.const", value: 0 } as Instr]);
    expect(() => emitBinary(mod)).toThrow(/function reference out of range.*funcIdx -1/s);
  });

  it("throws a NAMED error on an out-of-range funcIdx (stale-high) when flag on", () => {
    process.env.JS2WASM_VALIDATE_FUNCREFS = "1";
    // Only func 0 exists (max = 1); call 5 is past the end — the stale-index case.
    const mod = minimalModule([{ op: "call", funcIdx: 5 } as Instr, { op: "i32.const", value: 0 } as Instr]);
    expect(() => emitBinary(mod)).toThrow(/function reference out of range/);
  });

  it("the -1 case is silently emitted (opaque) when the flag is OFF — proves the guard is opt-in", () => {
    process.env.JS2WASM_VALIDATE_FUNCREFS = "";
    // Without the guard, a -1 funcIdx reaches the raw encoder and throws the
    // opaque RangeError there (NOT our named message). We only assert the named
    // guard message is absent — i.e. default behaviour is unchanged.
    const mod = minimalModule([{ op: "call", funcIdx: -1 } as Instr, { op: "i32.const", value: 0 } as Instr]);
    let msg = "";
    try {
      emitBinary(mod);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).not.toMatch(/function reference out of range/);
  });
});
