// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 — standalone `new RegExp(...)` with a **compile-time-constant** pattern.
 *
 * The standalone native RegExp engine compiles a pattern to bytecode at COMPILE
 * time, so `new RegExp(<dynamicPattern>)` (a genuinely runtime string) must
 * refuse / route to the dynamic path. But the constructor's static-pattern
 * recovery used a helper (`staticStringValue`) that only accepted a bare string
 * literal — so patterns that ARE compile-time-constant and CAN be lowered to the
 * native engine were rejected and lowered to a placeholder that **runtime-trapped**:
 *
 *   - `new RegExp("a" + "b")`        — string-literal concatenation,
 *   - `const p = "ab"; new RegExp(p)` — `const`-bound literal,
 *   - `new RegExp(/ab/g)` / `new RegExp(/ab/, "i")` — §22.2.3.1 copy-constructor.
 *
 * This slice folds those constants (`staticConstStringValue`) and handles the
 * regex-literal copy form (`staticRegExpLiteralCopy`), routing them to the
 * existing native `compileStandaloneRegExpPattern`. Zero new host imports, zero
 * substrate dependency, behaviour-preserving for every existing static form. A
 * genuinely-dynamic pattern (function param, `let`, reassigned binding) is NOT
 * folded and keeps the prior dynamic behaviour.
 *
 * Spec: ECMA-262 §22.2.3.1 RegExp(pattern, flags) — when pattern is a RegExp,
 * inherit `[[OriginalFlags]]` if flags is `undefined`, else use flags.
 *
 * Still open under #2161 (NOT this slice): `RegExp.prototype` reflection
 * (#2175-gated builtin-prototype-object substrate) and dynamic/`any`-typed
 * regex receivers + truly-runtime constructor patterns (need a runtime regex
 * compiler / runtime-externref receiver generalisation — future architect spec).
 */
async function runStandalone(src: string): Promise<{ leaks: string[]; main: () => unknown }> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => !l.startsWith("wasm:js-string::"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { leaks, main: instance.exports.main as () => unknown };
}

describe("#2161 const-foldable new RegExp() patterns (standalone)", () => {
  it("string-literal concatenation pattern compiles natively", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp("a" + "b", "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("const-bound literal pattern compiles natively", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const p = "ab"; const re = new RegExp(p, "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("const-bound + concat (chained fold) pattern compiles natively", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const a = "a"; const re = new RegExp(a + "b", "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("regex-literal copy-constructor inherits the literal's flags", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp(/ab/g); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("regex-literal copy-constructor overrides flags when provided (§22.2.3.1)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp(/AB/, "gi"); return "abAB".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("const-folded ctor binding flows to a downstream re.test", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp("a" + "b"); return re.test("xabx") ? 7 : 3; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(7);
  });

  it("control: static string-literal pattern still works (no regression)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { const re = new RegExp("ab", "g"); return "abab".match(re)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("regex literal (no ctor) still works (no regression)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { return "abab".match(/ab/g)!.length; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("genuinely-dynamic param pattern is NOT mis-folded as a constant", async () => {
    // A function-param pattern is NOT a compile-time constant: the const-fold
    // must NOT accept it (which would silently run the native engine on an
    // empty/garbage pattern and return the wrong count). Its behaviour stays
    // exactly as before this slice — the documented dynamic-constructor path,
    // which compiles but runtime-traps (it needs a runtime regex compiler,
    // tracked under #2161 as a future architect-spec item). The invariant this
    // slice must preserve: it must NOT silently return the correct native count
    // of 2, because that would prove a dynamic pattern was mis-folded.
    const r = await compile(
      `function mk(p: string): RegExp { return new RegExp(p, "g"); } export function main(): number { return "abab".match(mk("ab"))!.length; }`,
      { target: "standalone" },
    );
    if (!r.success) return; // refusal is an acceptable outcome
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    let result: unknown = "TRAP";
    try {
      result = (instance.exports.main as () => unknown)();
    } catch {
      result = "TRAP"; // dynamic pattern traps at runtime — not mis-folded
    }
    expect(result).not.toBe(2);
  });
});
