// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1806 Phase 0 — standalone ToPrimitive refusal, superseded by #1900 native
// OrdinaryToPrimitive coverage.
//
// In `--target standalone` there is no JS host to satisfy the `env::__to_primitive`
// import that the ToPrimitive (§7.1.1) lowering dispatches to for objects whose
// `[Symbol.toPrimitive]` / `valueOf` / `toString` cannot be resolved at compile
// time. Previously this leaked the import (failing at instantiation with an opaque
// "module is not an object or function" linker error) or fell through to the
// JS-host runtime which threw the bare "Cannot convert object to primitive value"
// with no tracking issue — the 2,136-test #1806 failure cluster.
//
// Phase 0 converted every such case into a compile error that cited #1806,
// making the cluster trackable. #1900 replaces that broad refusal with native
// standalone ToPrimitive coverage, so this file now guards the old failure
// shapes against regressing back to leaked host imports.

const HOST_TOPRIM_REFUSED: Array<{ label: string; src: string; expected: number | "NaN" }> = [
  {
    label: "plain object coerced to number (host ToPrimitive dispatch)",
    src: `export function test(): number { const o = { a: 1, b: 2 }; return (o as any) - 0; }`,
    expected: "NaN",
  },
  {
    label: "plain object in multiply (numeric hint)",
    src: `export function test(): number { const o = { x: 3 }; return (o as any) * 2; }`,
    expected: "NaN",
  },
  {
    label: "object in bitwise-and (ToNumeric → ToPrimitive)",
    src: `export function test(): number { const o = { p: 1 }; return (o as any) & 3; }`,
    expected: 0,
  },
];

describe("#1806/#1900 — standalone ToPrimitive no longer leaks host imports", () => {
  for (const { label, src, expected } of HOST_TOPRIM_REFUSED) {
    it(`compiles host-free after #1900: ${label}`, async () => {
      const r = await compile(src, {
        fileName: "issue-1806.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      });

      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      expect((r.imports ?? []).some((i) => i.name === "__to_primitive")).toBe(false);
      expect(WebAssembly.validate(r.binary)).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const actual = (instance.exports.test as () => number)();
      if (expected === "NaN") expect(actual).toBeNaN();
      else expect(actual).toBe(expected);
    });
  }

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
