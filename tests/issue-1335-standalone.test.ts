// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1335 Phase 1 — pure-Wasm `Number.prototype.toString(radix)` for standalone
 * finite integer formatting.
 *
 * Spec references:
 * - ECMA-262 §21.1.3.6 Number.prototype.toString
 * - ECMA-262 §6.1.6.1.20 Number::toString
 * - ECMA-262 §7.1.5 ToIntegerOrInfinity
 *
 * This slice intentionally does not implement fractional or unsafe-integer
 * shortest formatting; that remains the Ryu/bignum follow-up for #1335.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function formatStandalone(expr: string, target: "wasi" | "standalone" = "wasi"): Promise<string> {
  const src = `export function len(): number { return (${expr}).length; }
export function at(i: number): number { return (${expr}).charCodeAt(i); }`;
  const r = await compile(src, { fileName: "issue-1335.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);

  const mod = await WebAssembly.compile(r.binary);
  const numberToStringImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env" && i.name.startsWith("number_toString"))
    .map((i) => `${i.module}::${i.name}`);
  expect(numberToStringImports, "standalone integer radix formatting must not need JS host toString imports").toEqual(
    [],
  );

  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as { len(): number; at(i: number): number };
  const len = exports.len();
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

describe("#1335 Phase 1 — standalone Number.prototype.toString(radix)", () => {
  it("formats positive integers in binary, octal, hex, and base36", async () => {
    expect(await formatStandalone("(255).toString(2)")).toBe("11111111");
    expect(await formatStandalone("(255).toString(8)")).toBe("377");
    expect(await formatStandalone("(255).toString(16)")).toBe("ff");
    expect(await formatStandalone("(35).toString(36)")).toBe("z");
  });

  it("formats negative integers and zero without a host import", async () => {
    expect(await formatStandalone("(-255).toString(16)")).toBe("-ff");
    expect(await formatStandalone("(-0).toString(16)")).toBe("0");
    expect(await formatStandalone("(0).toString(2)")).toBe("0");
  });

  it("handles special Number::toString values naturally", async () => {
    expect(await formatStandalone("(NaN).toString(16)")).toBe("NaN");
    expect(await formatStandalone("(Infinity).toString(2)")).toBe("Infinity");
    expect(await formatStandalone("(-Infinity).toString(36)")).toBe("-Infinity");
  });

  it("truncates radix per ToIntegerOrInfinity before formatting", async () => {
    expect(await formatStandalone("(255).toString(16.9)")).toBe("ff");
  });

  it("standalone target emits the same native helper as wasi", async () => {
    expect(await formatStandalone("(31).toString(16)", "standalone")).toBe("1f");
  });
});

describe("#1335 — number toString result is consumable by chained string ops", () => {
  // The native number_toString[_radix] helpers return an externref wrapping a
  // $NativeString. Before this fix the call site reported the result type as
  // `externref`, so a consumer that unwrapped it (.charAt, +, etc.) applied a
  // SECOND any.convert_extern to the already-native ref and the module failed
  // Wasm validation ("any.convert_extern expected externref, found native
  // ref"). The call site now unwraps once and reports the native string type.
  async function validatesStandalone(src: string): Promise<void> {
    const r = await compile(src, { fileName: "issue-1335-chain.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  }

  it("(255).toString(16).charAt(0) validates and is consumable", async () => {
    const r = await compile(`export function test(): number { return (255).toString(16).charCodeAt(0); }`, {
      fileName: "issue-1335-chain.ts",
      target: "standalone",
    });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(102); // 'f'
  });

  it("no-arg (42).toString() chained into a string method validates", async () => {
    await validatesStandalone(`export function test(): number { return (42).toString().charCodeAt(0); }`);
  });

  it("number toString result concatenated with a string literal validates", async () => {
    await validatesStandalone(`export function test(): number { return ((255).toString(16) + "!").length; }`);
  });
});
