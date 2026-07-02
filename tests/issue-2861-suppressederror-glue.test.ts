// (#2861 residual) Standalone native-proto glue for SuppressedError (ES2026
// error aggregation). DisposableStack / AsyncDisposableStack were wired
// separately (#2433, brand slots 41/42); SuppressedError is the remaining
// unwired ctor/prototype value read in this cluster. Before this slice, reading
// `SuppressedError.prototype` as a first-class VALUE under `--target standalone`
// was a hard compile error:
//
//   Codegen error: SuppressedError.prototype built-in static property value read
//   is not supported in --target standalone (#1907 / #1888 S6-b).
//
// SuppressedError is an Error subclass, so it reuses the shared NativeError glue
// (own method `toString`; `constructor`/`name`/`message` data props via the
// meta-fold). Brand slot 43. Standalone-only (the arm is reached only from the
// `ctx.standalone`-gated proto-value-read / meta paths); host mode is unaffected.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function sa(source: string, fn = "test"): Promise<unknown> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2861 residual: SuppressedError.prototype native-proto glue", () => {
  it("SuppressedError.prototype value read no longer refuses (standalone)", async () => {
    expect(await sa(`export function test(): number { const p = SuppressedError.prototype; return p ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("SuppressedError.prototype.toString is a function value (Error-subclass glue)", async () => {
    expect(
      await sa(
        `export function test(): number { return typeof SuppressedError.prototype.toString === "function" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
