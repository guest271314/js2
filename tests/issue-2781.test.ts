// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2781 — Hybrid IR step 3: Binary `+` string-or-number proof-gate (audit Row 7).
//
// `lowerBinary` (`src/ir/from-ast.ts`) lowers both operands with an f64 hint and
// then picks the unboxed numeric add vs. `emitStringConcat` from the LOWERED
// Wasm kind. Per the Hybrid Invariant a `T`-directed specialization must be
// discharged by a proof on the TS TYPE, never the Wasm kind: `+` is
// string-concat-OR-numeric-add chosen at runtime (ToPrimitive + "if either is a
// string → concatenate, else add"), and `number` / `boolean` / `symbol` all
// collapse to the same Wasm scalar kind. This step adds an operand-type proof to
// the `+` path (mirroring #2766 / #2780's prove-then-specialize shape):
//   - FAST: both operands provably `number` (→ unboxed numeric add) or both
//     provably `string` (→ `emitStringConcat`) → keep the fast IR path.
//   - SAFE: any operand `any` / union / a MIXED number+string pair → demote to
//     the legacy dynamic `+` (`emitAnyAdd`, ToPrimitive + concat-or-add).
//     Value-correct either way.
//
// The proof reads the TS `TypeFlags`, never the Wasm kind — the headline case
// below compiles ONE `function f(x: any) { return x + x; }` and calls it with a
// number AND a string: both are correct only because the gate demoted to the
// runtime-dispatching SAFE `+`. Keying on the (identical) Wasm kind could not
// distinguish them.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";

// Distinctive substring of the Row-7 gate's demotion throw (see `lowerBinary`).
const GATE = "demote to the SAFE dynamic '+'";

/** The selector claims `fn` for IR compilation (proves it reaches the IR path). */
function isClaimed(source: string, fn: string): boolean {
  const ast = analyzeSource(source, "input.ts");
  const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
  return sel.funcs.has(fn);
}

/**
 * Compile via the IR path; return a callable export + the count of Row-7 gate
 * demotions recorded on `irPostClaimErrors`.
 */
async function compileFn(
  source: string,
  fn: string,
): Promise<{ call: (...a: unknown[]) => unknown; gateDemotions: number }> {
  const r = await compile(source, { experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const gateDemotions = (r.irPostClaimErrors ?? []).filter((e) => e.message.includes(GATE)).length;
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return { call: (...a: unknown[]) => (f as (...x: unknown[]) => unknown)(...a), gateDemotions };
}

describe("#2781 — IR Binary `+` string-or-number proof-gate", () => {
  // ── FAST: proof holds → fast IR path kept, NO Row-7 demotion ────────────────
  describe("FAST path — proven operand types keep the fast IR `+`", () => {
    it("proven number + number (params) → unboxed numeric add, no demotion", async () => {
      const src = `export function add(a: number, b: number): number { return a + b; }`;
      expect(isClaimed(src, "add"), "function IR-claimed").toBe(true);
      const { call, gateDemotions } = await compileFn(src, "add");
      expect(call(2, 3)).toBe(5);
      expect(gateDemotions, "no Row-7 demotion on the FAST numeric path").toBe(0);
    });

    it("proven number + number (literals) → numeric add, no demotion", async () => {
      const src = `export function add(): number { return 2 + 3; }`;
      expect(isClaimed(src, "add")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "add");
      expect(call()).toBe(5);
      expect(gateDemotions).toBe(0);
    });

    it("proven string + string (params) → emitStringConcat, no demotion", async () => {
      const src = `export function cat(a: string, b: string): string { return a + b; }`;
      expect(isClaimed(src, "cat"), "function IR-claimed").toBe(true);
      const { call, gateDemotions } = await compileFn(src, "cat");
      expect(call("foo", "bar")).toBe("foobar");
      expect(gateDemotions, "no Row-7 demotion on the FAST concat path").toBe(0);
    });

    it("proven string + string (literals) → concat, no demotion", async () => {
      const src = `export function cat(): string { return "foo" + "bar"; }`;
      expect(isClaimed(src, "cat")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "cat");
      expect(call()).toBe("foobar");
      expect(gateDemotions).toBe(0);
    });
  });

  // ── SAFE: proof fails → demote to legacy dynamic `+`, still value-correct ───
  describe("SAFE path — unprovable operands demote via the Row-7 gate, value-correct", () => {
    it("HEADLINE: `f(x: any) { return x + x }` is correct for BOTH a number and a string", async () => {
      // ONE compiled function, called with two runtime types. The `any` operand
      // is IR-claimed (so `x + x` reaches `lowerBinary`), the gate demotes it to
      // the runtime-dispatching SAFE `+`, and BOTH results are correct — which is
      // only possible because the proof keys on the TS type, not the (identical)
      // Wasm kind both runtime values would share.
      const src = `export function f(x: any): any { return x + x; }`;
      expect(isClaimed(src, "f"), "any-operand function IS IR-claimed").toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(gateDemotions, "demoted via the explicit Row-7 gate").toBeGreaterThan(0);
      expect(call(4), "numeric add when the runtime value is a number").toBe(8);
      expect(call("ab"), "string concat when the runtime value is a string").toBe("abab");
    });

    it("mixed string + number demotes via the Row-7 gate and concatenates", async () => {
      const src = `export function f(s: string, n: number): string { return s + n; }`;
      expect(isClaimed(src, "f"), "function IR-claimed (reaches lowerBinary)").toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(gateDemotions, "demoted via the explicit Row-7 gate").toBeGreaterThan(0);
      expect(call("v", 5), "SAFE legacy `+` does ToPrimitive + concat").toBe("v5");
    });

    it("mixed string literal + number literal demotes and concatenates", async () => {
      const src = `export function f(): string { return "x" + 5; }`;
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(gateDemotions).toBeGreaterThan(0);
      expect(call()).toBe("x5");
    });
  });

  // ── Non-claimed union `+` is untouched by this slice ────────────────────────
  describe("non-claimed union `+` is unaffected by the Row-7 gate", () => {
    it("a `string | number` union param is NOT IR-claimed → pure legacy path", async () => {
      // A union param is rejected by the selector, so `g` never reaches the IR
      // `+` gate at all — this slice does not change union-typed `+`. The numeric
      // arm is value-correct on legacy today; the string arm is a SEPARATE,
      // pre-existing legacy union-coercion gap (legacy returns NaN for `"z"+"z"`
      // even with experimentalIR OFF) that the broader hybrid program owns, NOT
      // this Row-7 IR slice. Asserted only to pin that the gate left it alone.
      const src = `function g(x: string | number): any { return x + x; }
        export function fn(): any { return g(3); }`;
      expect(isClaimed(src, "g"), "union param ⇒ not IR-claimed").toBe(false);
      const { call: fn, gateDemotions } = await compileFn(src, "fn");
      expect(gateDemotions, "no Row-7 demotion — g never reaches the IR `+` gate").toBe(0);
      expect(fn()).toBe(6);
    });
  });
});
