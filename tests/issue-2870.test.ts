// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { extractWasmExceptionMessage } from "./test262-runner.js";

/**
 * #2870 — `extractWasmExceptionMessage` must NEVER throw while formatting a
 * thrown value, even when the payload is a Wasm-GC struct (or any exotic) whose
 * host `String()`/`ToPrimitive` throws `Cannot convert object to primitive
 * value`. Previously that host TypeError escaped the formatter and was recorded
 * as the test's failure, masking ~2,014 heterogeneous standalone failures behind
 * one phantom signature (see #2862).
 */
describe("#2870 — exception formatter never throws on a non-stringifiable payload", () => {
  // A stand-in for a Wasm-GC payload exposed to JS: `String(x)` / ToPrimitive
  // throws because every primitive-conversion path rejects.
  function makeNonStringifiable(): object {
    return {
      toString() {
        throw new TypeError("Cannot convert object to primitive value");
      },
      valueOf() {
        throw new TypeError("Cannot convert object to primitive value");
      },
      [Symbol.toPrimitive]() {
        throw new TypeError("Cannot convert object to primitive value");
      },
    };
  }

  it("does not throw when err is a non-stringifiable non-Error value", () => {
    const bad = makeNonStringifiable();
    let msg = "";
    expect(() => {
      msg = extractWasmExceptionMessage(bad, null);
    }).not.toThrow();
    expect(msg).toContain("uncaught Wasm");
  });

  it("control: a plain Error still yields its message", () => {
    expect(extractWasmExceptionMessage(new TypeError("boom"), null)).toBe("boom");
  });

  it("control: a stringifiable non-Error value is formatted normally", () => {
    expect(extractWasmExceptionMessage("plain string", null)).toBe("plain string");
  });

  it("sanity: the host String() on this payload really does throw", () => {
    const bad = makeNonStringifiable();
    expect(() => String(bad)).toThrow(/Cannot convert object to primitive/);
  });
});
