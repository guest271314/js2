// #6798 — six probe-backed semantic divergences, one `it` per slice.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../../src/index.js";

// resolve-stage-catch: a switch the mocked `irClosureSignatureFromFunctionTypeNode`
// (called from `resolvePositionType`'s FunctionTypeNode arm) reads to simulate a
// real bug (`TypeError`) or a designed "not expressible" answer (`null`).
const inject = vi.hoisted(() => ({ mode: "off" as "off" | "type-error" | "null" }));

vi.mock("../../src/ir/select.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ir/select.js")>();
  return {
    ...actual,
    irClosureSignatureFromFunctionTypeNode(...args: Parameters<typeof actual.irClosureSignatureFromFunctionTypeNode>) {
      if (inject.mode === "type-error") throw new TypeError("injected #6798 resolve-stage bug");
      if (inject.mode === "null") return null;
      return actual.irClosureSignatureFromFunctionTypeNode(...args);
    },
  };
});

describe("#6798 misc probe-backed semantic divergences", () => {
  it("resolve-stage-catch: an untyped throw in resolvePositionType is a hard error, a designed demote a warning", async () => {
    const src = `
      function apply(fn: () => number): number { return fn() + 1; }
      export function test(): number { return apply(() => 41); }
    `;
    try {
      inject.mode = "type-error";
      const bug = await compile(src, { fileName: "probe.ts" });
      expect(bug.success).toBe(false);
      const hard = bug.errors.filter(
        (e) => e.severity === "error" && /could not resolve types for apply/.test(e.message),
      );
      expect(hard.length).toBe(1);
      expect(hard[0]!.message).toContain("injected #6798 resolve-stage bug");

      inject.mode = "null";
      const demote = await compile(src, { fileName: "probe.ts" });
      expect(demote.success).toBe(true);
      const warned = demote.errors.filter((e) => /could not resolve types for apply/.test(e.message));
      expect(warned.map((e) => e.severity)).toEqual(["warning"]);
    } finally {
      inject.mode = "off";
    }
  });
});
