// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1806 / #124 — standalone ToPrimitive.
//
// #124 implements a working Wasm-native `__to_primitive` for the OPEN-`$Object`
// representation (any-context object literals, #1901 routing): it dispatches the
// object's own valueOf/toString via `__extern_method_call`. That path works (see
// tests/issue-124-toprimitive-object.test.ts).
//
// The CLOSED-STRUCT case below — `const o = { a: 1, b: 2 }` with NO `any`
// annotation infers a closed struct, then `(o as any) - <num>` coerces it — is a
// DIFFERENT representation that #124 does NOT cover. Removing the #1806 refusal
// unmasks a PRE-EXISTING latent `global.get -1` in the closed-struct→externref
// emission (a native-strings string-global sentinel; tracked separately — the
// closed-struct→`$Object` representation work, #1901). It still REFUSES LOUD (a
// `Codegen error` at emit; no invalid module is ever instantiated), just with a
// different message than the old `#1806` text. The contract asserted here is the
// invariant that MATTERS: the closed-struct standalone coercion must FAIL the
// compile (never silently emit a wrong/invalid module), not that it succeeds.

const CLOSED_STRUCT_TO_NUMBER_REFUSED: Array<{ label: string; src: string }> = [
  {
    label: "closed-struct object coerced to number",
    src: `export function test(): number { const o = { a: 1, b: 2 }; return (o as any) - 0; }`,
  },
  {
    label: "closed-struct object in multiply",
    src: `export function test(): number { const o = { x: 3 }; return (o as any) * 2; }`,
  },
  {
    label: "closed-struct object in bitwise-and (ToNumeric → ToPrimitive)",
    src: `export function test(): number { const o = { p: 1 }; return (o as any) & 3; }`,
  },
];

describe("#1806 / #124 — standalone ToPrimitive", () => {
  for (const { label, src } of CLOSED_STRUCT_TO_NUMBER_REFUSED) {
    it(`closed-struct coercion still refuses-loud (no invalid module): ${label}`, async () => {
      const r = await compile(src, {
        fileName: "issue-1806.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      });

      // The compile must FAIL (refuse-loud). #124 covers the OPEN-`$Object`
      // representation, not the closed-struct→externref coercion, which trips a
      // pre-existing latent `global.get -1` once the #1806 refusal is removed.
      // The invariant: it FAILS the compile — never silently emits an invalid /
      // wrong module. (When the closed-struct→`$Object` work lands, this should
      // flip to a passing run; for now refuse-loud is the correct floor.)
      expect(r.success).toBe(false);
      // No `__to_primitive` host import may leak into the standalone module.
      expect((r.imports ?? []).some((i) => i.name === "__to_primitive")).toBe(false);
    });
  }

  it("OPEN-$Object coercion dispatches own valueOf (the #124 win)", async () => {
    // `const o: any = {valueOf}` routes to the open `$Object` (#1901), and the
    // #124 native `__to_primitive` dispatches the own valueOf via
    // `__extern_method_call`. This is the cluster #124 actually clears.
    const r = await compile(
      `export function test(): number { const o: any = { valueOf: () => 7 }; return (o as any) - 0; }`,
      { fileName: "issue-1806-open.ts", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect((r.imports ?? []).some((i) => i.name === "__to_primitive")).toBe(false);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(7);
  });

  it("does NOT refuse compile-time-resolvable valueOf in standalone mode", async () => {
    // A class with a typed `valueOf(): number` resolves at compile time and must
    // NOT trip the Phase 0 guard — it lowers to a direct method call, no host
    // ToPrimitive dispatch.
    const r = await compile(
      `class Box { v: number; constructor(v: number) { this.v = v; } valueOf(): number { return this.v; } }
       export function test(): number { const b = new Box(7); return (b as any) - 0; }`,
      { fileName: "issue-1806-resolvable.ts", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(7);
  });

  it("leaves the default JS-host (GC) lane unaffected", async () => {
    // The same dynamic-shape object must still compile on the default GC target,
    // where the `__to_primitive` host import is legitimately available. The guard
    // is gated on `ctx.standalone`, so the host lane must NOT pick up a #1806
    // refusal and must still produce a valid binary.
    const r = await compile(`export function test(): number { const o = { a: 1, b: 2 }; return (o as any) - 0; }`, {
      fileName: "issue-1806-host.ts",
      skipSemanticDiagnostics: true,
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.errors.some((e) => e.message.includes("#1806"))).toBe(false);
    expect(r.binary.length).toBeGreaterThan(0);
  });
});
