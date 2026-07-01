// (#2861 residual) Standalone native-proto glue for the Explicit Resource
// Management stacks (DisposableStack / AsyncDisposableStack) and the ES2026
// SuppressedError. Before this slice, reading `<Builtin>.prototype` (or a
// `<Builtin>.prototype.<member>`) as a first-class VALUE under
// `--target standalone` was a hard compile error:
//
//   Codegen error: DisposableStack.prototype built-in static property value read
//   is not supported in --target standalone (#1907 / #1888 S6-b).
//
// Wiring the brand + member-CSV glue flips that CE into a working `$NativeProto`
// value object (member bodies still degrade to a catchable TypeError — the
// value-read object never needs them). Host mode is unaffected: these arms are
// only reached from the `ctx.standalone`-gated proto-value-read / meta paths.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// Standalone harness — empty imports (a leaked host import fails instantiation).
// Test functions return native `number` (i32/f64) so JS reads a real value, not
// a boxed externref.
async function sa(source: string, fn = "test"): Promise<unknown> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2861 residual: DisposableStack/AsyncDisposableStack/SuppressedError proto glue", () => {
  it("DisposableStack.prototype value read no longer refuses (standalone)", async () => {
    expect(await sa(`export function test(): number { const p = DisposableStack.prototype; return p ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("DisposableStack.prototype.dispose is a function value (standalone)", async () => {
    expect(
      await sa(
        `export function test(): number { return typeof DisposableStack.prototype.dispose === "function" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("DisposableStack proto method arities meta-fold to spec (.length)", async () => {
    // dispose/move → 0, use/defer → 1, adopt → 2.
    expect(await sa(`export function test(): number { return DisposableStack.prototype.dispose.length; }`)).toBe(0);
    expect(await sa(`export function test(): number { return DisposableStack.prototype.use.length; }`)).toBe(1);
    expect(await sa(`export function test(): number { return DisposableStack.prototype.adopt.length; }`)).toBe(2);
    expect(await sa(`export function test(): number { return DisposableStack.prototype.defer.length; }`)).toBe(1);
    expect(await sa(`export function test(): number { return DisposableStack.prototype.move.length; }`)).toBe(0);
  });

  it("DisposableStack proto method .name meta-folds to the member name", async () => {
    expect(
      await sa(`export function test(): number { return DisposableStack.prototype.adopt.name === "adopt" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("`disposed` accessor getter arity meta-folds to 0", async () => {
    expect(
      await sa(`export function test(): number { return (DisposableStack.prototype as any).disposed.length; }`),
    ).toBe(0);
  });

  it("AsyncDisposableStack.prototype value + disposeAsync (standalone)", async () => {
    expect(
      await sa(`export function test(): number { const p = AsyncDisposableStack.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
    expect(
      await sa(`export function test(): number { return AsyncDisposableStack.prototype.disposeAsync.length; }`),
    ).toBe(0);
    expect(await sa(`export function test(): number { return AsyncDisposableStack.prototype.use.length; }`)).toBe(1);
  });

  it("SuppressedError.prototype value + toString (Error-subclass glue, standalone)", async () => {
    expect(await sa(`export function test(): number { const p = SuppressedError.prototype; return p ? 1 : 0; }`)).toBe(
      1,
    );
    expect(
      await sa(
        `export function test(): number { return typeof SuppressedError.prototype.toString === "function" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
