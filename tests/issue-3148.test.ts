// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3148 — standalone/WASI-native `BigInt.asIntN(bits, bigint)` /
// `BigInt.asUintN(bits, bigint)` (§21.2.2.1 / §21.2.2.2).
//
// Before: `BigInt.asIntN`/`asUintN` under `--target standalone` routed through
// the generic member-call path → the dynamic-shape `env::__get_builtin` host
// import, which refuses-loud in standalone (#1472 Phase B) → 20 hard CEs under
// built-ins/BigInt/{asIntN,asUintN}/.
//
// After: the modular wrap is lowered to pure i64 ops over the #1644 i64-brand
// BigInt rep — NO JS host import. The i64 rep holds the low 64 bits of a
// BigInt, which is exactly what asIntN/asUintN of `bits <= 64` observes, so
// those are computed correctly even for source literals wider than 64 bits.
//
// This test guards: (1) the standalone path COMPILES (no `__get_builtin` CE)
// and leaks no `env` host import; (2) the modular-wrap VALUES are correct
// across bit widths, including the `bits == 0` and `bits > 64` boundaries and
// negative inputs; (3) ToIndex(bits) number coercions (truncate-toward-zero,
// NaN⇒0); (4) host (gc) mode still compiles the same source (untouched).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `export function test(): number { return (<expr>) ? 1 : 0; }` under
 * `--target standalone`, instantiate with NO imports (pure Wasm), and run.
 * Returns the i32 result (1 = the bigint predicate held).
 */
async function runStandalone(expr: string): Promise<number> {
  const src = `export function test(): number { return (${expr}) ? 1 : 0; }`;
  const r = await compile(src, { fileName: "t.ts", target: "standalone" });
  expect(r.success, `standalone compile failed for \`${expr}\`: ${r.errors[0]?.message ?? "(no error)"}`).toBe(true);
  // No JS-host import leaked into the standalone binary.
  const env = (r.imports ?? []).filter((i: { module?: string }) => i.module === "env");
  expect(env.length, `\`${expr}\` leaked env imports: ${env.map((i: { name?: string }) => i.name).join(",")}`).toBe(0);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#3148 standalone BigInt.asIntN / asUintN", () => {
  it("does not CE through the __get_builtin refusal", async () => {
    const r = await compile(`export function test(): bigint { return BigInt.asIntN(4, 25n); }`, {
      fileName: "t.ts",
      target: "standalone",
    });
    expect(r.success).toBe(true);
    expect(r.errors.some((e) => e.message.includes("__get_builtin"))).toBe(false);
  });

  // §21.2.2.1 — asIntN sign-extends bit (bits-1).
  describe("asIntN arithmetic", () => {
    const intCases: Array<[string, boolean]> = [
      // bits == 0 ⇒ 0n for any value.
      ["BigInt.asIntN(0, -2n) === 0n", true],
      ["BigInt.asIntN(0, 0n) === 0n", true],
      ["BigInt.asIntN(0, 2n) === 0n", true],
      // bits == 1
      ["BigInt.asIntN(1, -3n) === -1n", true],
      ["BigInt.asIntN(1, -2n) === 0n", true],
      ["BigInt.asIntN(1, 1n) === -1n", true],
      // bits == 2
      ["BigInt.asIntN(2, -3n) === 1n", true],
      ["BigInt.asIntN(2, -2n) === -2n", true],
      ["BigInt.asIntN(2, 2n) === -2n", true],
      ["BigInt.asIntN(2, 3n) === -1n", true],
      // bits == 4 (25 = 0b11001 → low-4 = 1001 → sign bit set → -7)
      ["BigInt.asIntN(4, 25n) === -7n", true],
      // bits == 8
      ["BigInt.asIntN(8, 0xabn) === -0x55n", true],
      ["BigInt.asIntN(8, 0xabcdn) === -0x33n", true],
      // bits == 64 (identity on an i64-representable value)
      ["BigInt.asIntN(64, 0x0123456789abcdefn) === 0x0123456789abcdefn", true],
      // wide (>64-bit) source literal: only the low `bits` bits are observed.
      ["BigInt.asIntN(8, 0xabcdef0123456789abcdef0123n) === 0x23n", true],
      // bits > 64 ⇒ value unchanged (asIntN is exact here).
      ["BigInt.asIntN(200, 5n) === 5n", true],
      ["BigInt.asIntN(200, -5n) === -5n", true],
    ];
    for (const [expr, want] of intCases) {
      it(expr, async () => {
        expect(await runStandalone(expr)).toBe(want ? 1 : 0);
      });
    }
  });

  // §21.2.2.2 — asUintN masks the low `bits` bits (unsigned).
  describe("asUintN arithmetic", () => {
    const uintCases: string[] = [
      "BigInt.asUintN(0, -2n) === 0n",
      "BigInt.asUintN(0, 5n) === 0n",
      "BigInt.asUintN(4, 25n) === 9n",
      "BigInt.asUintN(3, -3n) === 5n",
      "BigInt.asUintN(2, -1n) === 3n",
      "BigInt.asUintN(8, 0xabn) === 0xabn",
      "BigInt.asUintN(8, 0xabcdn) === 0xcdn",
      // wide source literal — low 8 bits.
      "BigInt.asUintN(8, 0xabcdef0123456789abcdef0123n) === 0x23n",
      // bits > 64 with a NON-negative value ⇒ value unchanged (exact).
      "BigInt.asUintN(100, 42n) === 42n",
    ];
    for (const expr of uintCases) {
      it(expr, async () => {
        expect(await runStandalone(expr)).toBe(1);
      });
    }
  });

  // ToIndex(bits): ToNumber → truncate toward zero; NaN ⇒ 0. (bits-toindex.js)
  describe("ToIndex(bits) numeric coercion", () => {
    const bitsCases: string[] = [
      "BigInt.asIntN(-0.9, 1n) === 0n", // truncate toward 0
      "BigInt.asIntN(0.9, 1n) === 0n", // truncate toward 0
      "BigInt.asIntN(NaN, 1n) === 0n", // NaN ⇒ 0
      "BigInt.asIntN(3.9, 10n) === 2n", // truncate toward 0
      "BigInt.asIntN(3, 10n) === 2n",
    ];
    for (const expr of bitsCases) {
      it(expr, async () => {
        expect(await runStandalone(expr)).toBe(1);
      });
    }
  });

  // Host (gc) mode is untouched — the same source still compiles via the
  // existing `__get_builtin` path (produces a real JS BigInt). We only assert
  // it COMPILES; instantiation there needs the JS host imports.
  it("host (gc) mode still compiles BigInt.asIntN", async () => {
    const r = await compile(`export function test(): bigint { return BigInt.asIntN(4, 25n); }`, { fileName: "t.ts" });
    expect(r.success).toBe(true);
  });
});
