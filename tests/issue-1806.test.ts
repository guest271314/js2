// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1806 Phase 0 — standalone ToPrimitive refusal.
//
// In `--target standalone` there is no JS host to satisfy the `env::__to_primitive`
// import that the ToPrimitive (§7.1.1) lowering dispatches to for objects whose
// `[Symbol.toPrimitive]` / `valueOf` / `toString` cannot be resolved at compile
// time. Previously this leaked the import (failing at instantiation with an opaque
// "module is not an object or function" linker error) or fell through to the
// JS-host runtime which threw the bare "Cannot convert object to primitive value"
// with no tracking issue — the 2,136-test #1806 failure cluster.
//
// Phase 0 converts every such case into a compile error that cites #1806, making
// the cluster trackable. The Wasm-native ToPrimitive over the $Object struct is
// Phase 1 (#1806).

const HOST_TOPRIM_REFUSED: Array<{ label: string; src: string }> = [
  {
    label: "plain object coerced to number (host ToPrimitive dispatch)",
    src: `function test(): number { const o = { a: 1, b: 2 }; return (o as any) - 0; }`,
  },
  {
    label: "plain object in multiply (numeric hint)",
    src: `function test(): number { const o = { x: 3 }; return (o as any) * 2; }`,
  },
  {
    label: "object in bitwise-and (ToNumeric → ToPrimitive)",
    src: `function test(): number { const o = { p: 1 }; return (o as any) & 3; }`,
  },
];

describe("#1806 Phase 0 — standalone ToPrimitive refusal", () => {
  for (const { label, src } of HOST_TOPRIM_REFUSED) {
    it(`refuses with a #1806 compile error: ${label}`, async () => {
      const r = await compile(src, {
        fileName: "issue-1806.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      });

      // The compile must FAIL (no half-working module with a leaked host import).
      expect(r.success).toBe(false);

      // Every error in the cluster must cite the tracking issue #1806 so the
      // failure is attributable, and must name the ToPrimitive operation.
      const messages = r.errors.map((e) => e.message);
      expect(messages.some((m) => m.includes("#1806"))).toBe(true);
      expect(messages.some((m) => /toPrimitive/i.test(m))).toBe(true);

      // The message must NOT begin with "Cannot " / "Invalid " — those prefixes
      // make the test262 classifier bucket it as a stray runtime_error instead
      // of a trackable compile_error.
      const toPrimMsg = messages.find((m) => m.includes("#1806"))!;
      expect(/^Cannot |^Invalid /.test(toPrimMsg)).toBe(false);

      // No `__to_primitive` host import may leak into the standalone module.
      expect((r.imports ?? []).some((i) => i.name === "__to_primitive")).toBe(false);
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
