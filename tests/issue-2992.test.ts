// #2992 (slice 1) — top-level `delete` statements must reach `__module_init`.
//
// Root cause (measured 2026-07-10 on main 569e29b761): the module-level
// statement collector in `src/codegen/declarations.ts` recognises New/Call
// expressions, Prefix/Postfix unary (++/--), and assignment
// BinaryExpressions — but `delete o.k` is a `ts.DeleteExpression`, its OWN
// node kind (NOT a PrefixUnaryExpression). It matched no case and the whole
// statement was silently dropped from `__module_init`: the property survived,
// every later read observed the stale value, and `"k" in o` stayed true.
// `delete` INSIDE a function always worked — only the top-level collection
// dropped it. This was the mechanism behind the issue's headline
// "delete-tombstone read survival" repro (the tombstone machinery itself in
// `object-runtime.ts` is fine). Affected ALL lanes (gc / standalone / wasi)
// identically.
//
// Also fixed here: `void <expr>` in top-level statement position is now
// unwrapped like parentheses, so `void (delete o.k)` deletes too.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, target: "gc" | "standalone"): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    target,
    skipSemanticDiagnostics: true,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as any).test?.();
}

for (const target of ["gc", "standalone"] as const) {
  describe(`#2992 — top-level delete reaches __module_init (${target})`, () => {
    it("read after top-level delete observes the deletion", async () => {
      const ret = await run(
        `
const o: any = {};
o['k'] = 1;
delete o['k'];
export function test(): number { return o['k'] === undefined ? 1 : 0; }
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("'in' operator after top-level delete is false", async () => {
      const ret = await run(
        `
const o: any = {};
o['k'] = 1;
delete o['k'];
export function test(): number { return ('k' in o) ? 0 : 1; }
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("top-level define→delete→redefine→delete cycle (verifyProperty shape)", async () => {
      const ret = await run(
        `
const o: any = {};
o['k'] = 1;
delete o['k'];
o['k'] = 2;
delete o['k'];
export function test(): number { return (o['k'] === undefined && !('k' in o)) ? 1 : 0; }
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("parenthesized top-level delete still executes", async () => {
      const ret = await run(
        `
const o: any = {};
o['k'] = 1;
(delete o['k']);
export function test(): number { return o['k'] === undefined ? 1 : 0; }
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("void-wrapped top-level delete still executes", async () => {
      const ret = await run(
        `
const o: any = {};
o['k'] = 1;
void (delete o['k']);
export function test(): number { return o['k'] === undefined ? 1 : 0; }
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("delete inside a function keeps working (no regression)", async () => {
      const ret = await run(
        `
const o: any = {};
export function test(): number {
  o['k'] = 1;
  delete o['k'];
  return o['k'] === undefined ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });
  });
}
