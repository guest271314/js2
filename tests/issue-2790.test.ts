// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2790 — Hybrid IR: the i32 arm of the no-box NUMBER-local proof gate (the
// fast-follow #2782 explicitly DEFERRED, unblocked by #2785).
//
// #2782 added `proveUnboxedNumberLocal` in `lowerVarDecl` (`src/ir/from-ast.ts`)
// but scoped it to the `f64` representation ONLY, deferring the `i32` arm: an
// `i32` local that escapes to an `any` sink was boxed type-blind via
// `__box_number`, which would corrupt an i32-backed boolean. #2785 fixed the
// escape edge — `coerceType(i32 → externref)` now boxes by the TS brand
// (`boolean` → `__box_boolean`, `symbol` → `__box_symbol`, else `__box_number`).
//
// #2790 extends the declaration gate to the `i32` representation. The `i32`
// kind hosts TWO sound, brand-determinable primitives that may be kept unboxed:
//   - a `number` (`arr.length`, a native-`i32` typed number) — boxes
//     `__box_number` on escape;
//   - a `boolean` — boxes `__box_boolean` on escape (the #2785 fix).
// CRITICAL (the trap that deferred this arm): `classifyPrimitiveProof` reports
// the intrinsic `boolean` (`true | false`) as `"unprovable"`, so a naive
// "gate i32 on `classifyPrimitiveProof === 'number'`" would demote EVERY boolean
// local (growing an IR-fallback bucket). The fix keys on the TS *type*: a
// `boolean` is recognised by a SEPARATE `isProvablyBoolean` proof and kept
// unboxed — it must NEVER enter the *number* no-box path (which boxes
// `__box_number`, corrupting it). Only a genuinely-unprovable `i32` local
// (`any` / mixed union — no determinable brand) is demoted to the SAFE legacy
// lowering. Demote-to-safe is correctness-neutral either way.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";

// The no-box NUMBER declaration/escape gate's distinctive demotion reason (shared
// by #2782's f64 declaration gate AND the f64 escape sink). If this fires on a
// boolean, the i32 number arm wrongly swallowed it (the deferred trap).
const NOBOX_GATE = "no-box number representation is unsound";
// The i32/i64 escape sink demotes an unboxed scalar that flows into an `any`
// result to legacy, where #2785's type-aware box picks __box_boolean / __box_number.
const I32_ESCAPE = "needs the box helper";

/** The selector claims `fn` for IR compilation (proves it reaches the IR path). */
function isClaimed(source: string, fn: string): boolean {
  const ast = analyzeSource(source, "input.ts");
  const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
  return sel.funcs.has(fn);
}

/**
 * Compile via the IR path; return a callable export plus the counts of (a) the
 * no-box NUMBER gate demotions and (b) the i32-scalar escape-sink demotions.
 */
async function compileFn(
  source: string,
  fn: string,
): Promise<{
  call: (...a: unknown[]) => unknown;
  noboxDemotions: number;
  i32EscapeDemotions: number;
}> {
  const r = await compile(source, { experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const msgs = (r.irPostClaimErrors ?? []).map((e) => e.message);
  const noboxDemotions = msgs.filter((m) => m.includes(NOBOX_GATE)).length;
  const i32EscapeDemotions = msgs.filter((m) => m.includes(I32_ESCAPE)).length;
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return {
    call: (...a: unknown[]) => (f as (...x: unknown[]) => unknown)(...a),
    noboxDemotions,
    i32EscapeDemotions,
  };
}

describe("#2790 — IR no-box NUMBER-local proof gate, i32 arm", () => {
  // ── The i32-boolean trap: a boolean (i32) must NOT be caught by the NUMBER gate
  describe("i32 boolean — recognised as boolean, NOT demoted by the number gate", () => {
    it("a `boolean` local stays unboxed (i32), NO no-box-number demotion", async () => {
      // boolean collapses to i32; the number proof reports it `unprovable`, so a
      // naive i32-number gate would demote it. The separate `isProvablyBoolean`
      // proof keeps it unboxed instead. Exports the raw i32 (1 == true).
      const src = `export function f(): boolean { let b = true; return b; }`;
      expect(isClaimed(src, "f"), "function IR-claimed").toBe(true);
      const { call, noboxDemotions } = await compileFn(src, "f");
      expect(call(), "boolean exports as the raw i32 representation (1 == true)").toBe(1);
      expect(noboxDemotions, "boolean (i32) must NOT be caught by the no-box NUMBER gate").toBe(0);
    });

    it("a `let b = x > y` comparison boolean local is not demoted and is correct", async () => {
      const src = `export function f(x: number, y: number): boolean { let b = x > y; return b; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, noboxDemotions } = await compileFn(src, "f");
      expect(call(3, 1)).toBe(1);
      expect(call(1, 3)).toBe(0);
      expect(noboxDemotions, "comparison boolean (i32) must NOT be no-box-number-demoted").toBe(0);
    });
  });

  // ── HEADLINE: an i32 boolean escaping into `any` boxes via __box_boolean ──────
  describe("i32 boolean escaping to `any` — boxes via __box_boolean (#2785), value-correct", () => {
    it("HEADLINE: `let b = true; return b` into an `any` result boxes as a BOOLEAN", async () => {
      // The boolean is kept unboxed through the body (NOT no-box-number-demoted),
      // and returning it into the dynamic `any` result hits the i32 escape sink,
      // which demotes to legacy where #2785 boxes via __box_boolean — NOT
      // __box_number. So the host sees a real `true` (typeof boolean), not 1.
      const src = `export function f(): any { let b = true; return b; }`;
      expect(isClaimed(src, "f"), "function IS IR-claimed (the local reaches lowerVarDecl)").toBe(true);
      const { call, noboxDemotions, i32EscapeDemotions } = await compileFn(src, "f");
      expect(noboxDemotions, "boolean must NOT be demoted by the no-box NUMBER gate").toBe(0);
      expect(i32EscapeDemotions, "demoted at the i32 escape sink (→ legacy → #2785 type-aware box)").toBeGreaterThan(0);
      const ret = call();
      expect(ret, "boxed as a real boolean via __box_boolean, NOT __box_number(1)").toBe(true);
      expect(typeof ret, "host identity is boolean, not number").toBe("boolean");
    });

    it("a `false` boolean escaping to `any` boxes as boolean `false`", async () => {
      const src = `export function f(): any { let b = false; return b; }`;
      const { call } = await compileFn(src, "f");
      const ret = call();
      expect(ret).toBe(false);
      expect(typeof ret).toBe("boolean");
    });
  });

  // ── i32 / f64 NUMBER escaping into `any` — boxes via __box_number, value-correct
  describe("number escaping to `any` — boxes via __box_number, value-correct", () => {
    it("an `arr.length` (i32 number) escaping to `any` boxes as a NUMBER, correct value", async () => {
      const src = `export function f(): any { let n = [10, 20, 30].length; return n; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call } = await compileFn(src, "f");
      const ret = call();
      expect(ret, "length 3, boxed as a number (NOT corrupted by __box_boolean)").toBe(3);
      expect(typeof ret).toBe("number");
    });

    it("a plain `let x = 5` (f64 number) escaping to `any` boxes as a number (f64 arm unchanged)", async () => {
      const src = `export function f(): any { let x = 5; return x; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, noboxDemotions } = await compileFn(src, "f");
      expect(noboxDemotions, "f64 number escape still demotes via the #2782 no-box gate").toBeGreaterThan(0);
      const ret = call();
      expect(ret).toBe(5);
      expect(typeof ret).toBe("number");
    });
  });

  // ── Keyed on the TS type: number and boolean coexist without cross-corruption ─
  describe("the gate keys on the TS type — number and boolean coexist correctly", () => {
    it("sibling exports escaping a boolean vs a number local box by their own brand", async () => {
      // Two functions in one module: one escapes a boolean (i32) local, the other
      // escapes a number (i32) local — each through a SINGLE-brand `any` return.
      // If the i32 arm keyed on the Wasm kind, the boolean would come back as 1
      // (number). Keyed on the TS type, each is boxed by its own brand
      // (__box_boolean vs __box_number) — they don't cross-corrupt.
      const src = `
        export function getBool(): any { let b = true; return b; }
        export function getNum(): any { let n = [1,2,3,4,5,6,7].length; return n; }
      `;
      expect(isClaimed(src, "getBool")).toBe(true);
      expect(isClaimed(src, "getNum")).toBe(true);
      const boolRet = (await compileFn(src, "getBool")).call();
      expect(boolRet, "boolean local → real boolean").toBe(true);
      expect(typeof boolRet).toBe("boolean");
      const numRet = (await compileFn(src, "getNum")).call();
      expect(numRet, "number local → real number 7").toBe(7);
      expect(typeof numRet).toBe("number");
    });
  });

  // ── FAST: provably-number f64 locals stay unboxed (the #2782 f64 arm intact) ──
  describe("f64 number locals stay unboxed (the #2782 arm is unchanged)", () => {
    it("`let x: number` + arithmetic stays unboxed, no demotion, correct", async () => {
      const src = `export function f(): number { let x: number = 21; let y: number = 21; return x + y; }`;
      expect(isClaimed(src, "f")).toBe(true);
      const { call, noboxDemotions, i32EscapeDemotions } = await compileFn(src, "f");
      expect(call()).toBe(42);
      expect(noboxDemotions).toBe(0);
      expect(i32EscapeDemotions).toBe(0);
    });
  });
});
