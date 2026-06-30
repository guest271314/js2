// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2902 — Native standalone `Test262Error` construction.
//
// The test262 harness injects `class Test262Error extends Error` (and a
// `throw new Test262Error(...)` failure path) into nearly every wrapped test.
// `Test262Error` is listed in KNOWN_CONSTRUCTORS and intercepted in
// new-super.ts, so in standalone/WASI mode `new Test262Error(msg)` lowered to
// an unsatisfiable `env::__new_Test262Error` host import — leaking the module
// out of host-free even though the constructor is only ever reached on the
// (untaken) failure path of a *passing* test. A leak-analysis of the
// merge_group standalone report found ~2,779 tests that import ONLY
// `__new_Test262Error`.
//
// This builds it in-module as the same `$Error_struct` the WASI error
// constructors use (tagged Error, name "Test262Error"), so those tests become
// host-free while `.message` / `.name` / `instanceof Error` keep working.
// JS-host mode is unchanged (keeps the real-Error host import).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const HARNESS_T262 = `
class Test262Error {
  message: string;
  constructor(msg: string = "") { this.message = msg; }
}
`;

describe("#2902 — native standalone Test262Error", () => {
  for (const target of ["standalone", "wasi"] as const) {
    describe(`${target} mode`, () => {
      it("does NOT register env.__new_Test262Error", async () => {
        const src = `${HARNESS_T262}
          export function test(): number {
            if (1 + 1 !== 2) { throw new Test262Error("unreachable"); }
            return 0;
          }
        `;
        const r = await compile(src, { target, skipSemanticDiagnostics: true });
        expect(r.success).toBe(true);
        const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
        expect(envImports).not.toContain("__new_Test262Error");
      });

      it("a passing test that never throws is fully host-free", async () => {
        const src = `${HARNESS_T262}
          export function test(): number {
            let x: number = 41;
            if (x + 1 !== 42) { throw new Test262Error("bad"); }
            return x + 1;
          }
        `;
        const r = await compile(src, { target, skipSemanticDiagnostics: true });
        expect(r.success).toBe(true);
        const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
        expect(envImports).toEqual([]);
        const { instance } = await WebAssembly.instantiate(r.binary, {});
        expect((instance.exports as { test(): number }).test()).toBe(42);
      });

      it("throw/catch yields correct .message, .name and instanceof Error", async () => {
        const src = `${HARNESS_T262}
          export function test(): number {
            try {
              throw new Test262Error("boom");
            } catch (e: any) {
              let score: number = 0;
              if (e.message === "boom") { score = score + 1; }
              if (e.name === "Test262Error") { score = score + 2; }
              if (e instanceof Error) { score = score + 4; }
              return score;
            }
          }
        `;
        const r = await compile(src, { target, skipSemanticDiagnostics: true });
        expect(r.success).toBe(true);
        const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
        expect(envImports).toEqual([]);
        const { instance } = await WebAssembly.instantiate(r.binary, {});
        // 1 (message) + 2 (name) + 4 (instanceof Error) = 7
        expect((instance.exports as { test(): number }).test()).toBe(7);
      });
    });
  }

  describe("JS-host mode unchanged", () => {
    it("still registers env.__new_Test262Error (real Error subclass)", async () => {
      const src = `${HARNESS_T262}
        export function test(): number {
          if (1 + 1 !== 2) { throw new Test262Error("unreachable"); }
          return 0;
        }
      `;
      const r = await compile(src, { skipSemanticDiagnostics: true });
      expect(r.success).toBe(true);
      const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
      expect(envImports).toContain("__new_Test262Error");
    });
  });
});
