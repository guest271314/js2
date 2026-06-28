// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2782 — Hybrid IR step 5: no-box NUMBER-local proof gate (audit Row 5).
//
// `lowerVarDecl` (`src/ir/from-ast.ts`) binds a local with the native unboxed
// `f64` representation whenever its value lowers to (or is annotated) `f64`. Per
// the Hybrid Invariant that no-box specialization must be discharged by a proof
// on the TS TYPE, never the lowered Wasm kind: an unboxed `f64` carries no
// runtime tag, so `number` / `boolean` / `symbol` (all collapsing to `f64` /
// `i32`) cannot be told apart by the kind, and a value that is actually `any` /
// `number | string` kept unboxed would be read with the wrong identity at any
// `any` sink. This step adds two HI guards (mirroring #2766 / #2780 / #2781's
// prove-then-specialize shape) that reuse #2781's `classifyPrimitiveProof`:
//
//   - DECLARATION gate (`proveUnboxedNumberLocal`): keep the local unboxed only
//     when its TS type is provably a pure number; otherwise demote to the SAFE
//     boxed legacy lowering. Scoped to the `f64` representation ONLY — `boolean`
//     (the intrinsic `true | false` union) is `unprovable` by design, so gating
//     `i32` locals would demote every boolean local (the trap that parked two
//     prior attempts); the `i32`-number arm is deferred.
//   - ESCAPE-sink gate (`coerceReturnValue`): an unboxed `f64` number returned
//     into an `any` (externref) result is the reachable "number value sinks to
//     an `any` sink" case — the IR has no box primitive, so it demotes to the
//     SAFE boxed legacy lowering (which boxes via `__box_number`). Value-correct.
//
// Both carry the same distinctive demotion reason ("no-box number representation
// is unsound"), so the SAFE test below asserts the gate is the demotion cause.
//
// NOTE on coverage: like #2780's primary widening gate, the DECLARATION gate is
// a forward-looking soundness ratchet — on the current narrow IR claim scope a
// claimable `f64` local always has TS type `number` (a `: any` annotation is
// rejected pre-claim by the selector, and the f64 hint never opaquely coerces a
// non-numeric value), so it does not fire on today's corpus (which is exactly
// why it is correctness-neutral / regression-free). The reachable, firing arm is
// the escape sink. The FAST cases pin that the gate does NOT over-demote.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";

// Distinctive substring shared by both Row-5 demotion throws (see from-ast.ts).
const GATE = "no-box number representation is unsound";

/** The selector claims `fn` for IR compilation (proves it reaches the IR path). */
function isClaimed(source: string, fn: string): boolean {
  const ast = analyzeSource(source, "input.ts");
  const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
  return sel.funcs.has(fn);
}

/**
 * Compile via the IR path; return a callable export + the count of Row-5 gate
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

describe("#2782 — IR no-box NUMBER-local proof gate", () => {
  // ── FAST: provably-number locals stay unboxed, NO Row-5 demotion ────────────
  describe("FAST path — proven-number locals keep the unboxed f64 representation", () => {
    it("annotated `let x: number` stays unboxed, no demotion", async () => {
      const src = `export function f(): number { let x: number = 21; let y: number = 21; return x + y; }`;
      expect(isClaimed(src, "f"), "function IR-claimed").toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(call()).toBe(42);
      expect(gateDemotions, "no Row-5 demotion on a proven-number local").toBe(0);
    });

    it("inferred `let x = 21` stays unboxed, no demotion", async () => {
      const src = `export function f(): number { let x = 21; let y = 21; return x + y; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(call()).toBe(42);
      expect(gateDemotions).toBe(0);
    });

    it("local from a number param + arithmetic stays unboxed", async () => {
      const src = `export function f(a: number, b: number): number { let x = a * b; return x; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(call(6, 7)).toBe(42);
      expect(gateDemotions).toBe(0);
    });

    it("mutated-let number SLOT (for-of accumulator) stays unboxed", async () => {
      // `t` is a reassigned `let` ⇒ bound as a numeric `slot`; the gate runs on
      // the slot path too, and a `number` slot must NOT demote.
      const src = `export function f(): number { let t = 0; for (const x of [1,2,3]) { t += x; } return t; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(call()).toBe(6);
      expect(gateDemotions).toBe(0);
    });
  });

  // ── The boolean(i32) / string trap: these are NOT gated by this slice ────────
  describe("non-f64 locals are untouched (the number/boolean Wasm-kind trap)", () => {
    it("a `boolean` local (i32) is NOT demoted (classifyPrimitiveProof reports boolean unprovable)", async () => {
      // boolean collapses to i32; if the gate keyed on the Wasm kind (or applied
      // classifyPrimitiveProof to i32) it would demote every boolean local. It
      // must stay claimed with NO Row-5 demotion.
      const src = `export function f(): boolean { let b = true; return b; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(call(), "boolean exports as the raw i32 representation (1 == true)").toBe(1);
      expect(gateDemotions, "boolean (i32) local must NOT be Row-5-demoted").toBe(0);
    });

    it("a `string` local is untouched", async () => {
      const src = `export function f(): string { let s = "hi"; return s; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(call()).toBe("hi");
      expect(gateDemotions).toBe(0);
    });
  });

  // ── SAFE: a number value sinking to an `any` result demotes, value-correct ───
  describe("SAFE path — number sinking to an `any` result demotes via the Row-5 gate", () => {
    it("HEADLINE: `let x = 5; return x` into an `any` result demotes (boxed) and is correct", async () => {
      // The local is a proven number (so it stays unboxed through the body), but
      // returning it into the dynamic `any` result is the no-box escape edge:
      // an unboxed f64 has no runtime tag, so codegen demotes to the SAFE boxed
      // legacy lowering (which boxes via __box_number). Still JS-correct.
      const src = `export function f(): any { let x = 5; return x; }`;
      expect(isClaimed(src, "f"), "function IS IR-claimed (the local reaches lowerVarDecl)").toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(gateDemotions, "demoted via the explicit Row-5 no-box escape gate").toBeGreaterThan(0);
      expect(call(), "JS-correct via the SAFE (boxed) legacy lowering").toBe(5);
    });

    it("a numeric expression returned into `any` demotes and is value-correct", async () => {
      const src = `export function f(a: number, b: number): any { return a + b; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, gateDemotions } = await compileFn(src, "f");
      expect(gateDemotions, "demoted via the explicit Row-5 no-box escape gate").toBeGreaterThan(0);
      expect(call(2, 3)).toBe(5);
    });

    it("an `any`-typed local (`5 as any`) is value-correct (handled SAFE)", async () => {
      // `as any` initializers are not IR-claimed (the selector rejects them), so
      // this lowers via pure legacy — but the HI guarantee is the same: the
      // result is JS-correct regardless of mechanism (mirrors #2780's note).
      const src = `export function f(): number { let x = (5 as any); return x * 2; }`;
      const { call } = await compileFn(src, "f");
      expect(call()).toBe(10);
    });
  });
});
