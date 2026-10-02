// #6798 — six probe-backed semantic divergences, one `it` per slice.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../../src/index.js";
import { assertEquivalent } from "./helpers.js";

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

  it("typeof-class: a class value read through any / unknown / a parameter is 'function'", async () => {
    await assertEquivalent(
      `
      class K { static s(): number { return 1; } }
      class Sub extends K {}
      function g(v: any): string { return typeof v; }
      export function test(): string {
        const x: any = class {};
        const u: unknown = K;
        const arr: any[] = [K, Sub, new K()];
        return [
          typeof (class {}), typeof x, g(x), g(K), g(Sub), typeof u, g(arr[0]), g(arr[1]), g(arr[2]),
          String(typeof x === "function"), String(typeof x === "object"), String(typeof arr[0] === "function"),
        ].join(",");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof-tdz: typeof of a let/const in its TDZ throws a ReferenceError, also through a folded comparison", async () => {
    await assertEquivalent(
      `
      function probe(f: () => string): string {
        try { return "ok:" + f(); } catch (e) { return e instanceof ReferenceError ? "RE" : "other"; }
      }
      export function test(): string {
        const a = probe(() => { const t = typeof y; let y = 1; return t + y; });
        const b = probe(() => { const r = typeof z === "number"; const z = 1; return String(r) + z; });
        const c = probe(() => { let w = 1; return typeof w; });
        const d = probe(() => { const f = () => typeof q; const r1 = probe(f); let q = "s"; return r1 + "/" + f(); });
        const e = probe(() => { let out = ""; for (let i = 0; i < 2; i++) { let v = i; out += typeof v; } return out; });
        return [a, b, c, d, e].join("|");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
