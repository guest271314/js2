// #3316 — singleton-regime (post-#2106-flip) regressions in the standalone
// dynamic-descriptor accessor path. Bisected to f78be06991 (feat(#2106) flip
// $undefined singleton default ON). Two mechanisms:
//
// 1. Carrier-hoist illegal cast: `var d: any = { … }` (the #3037 CS1a
//    any-object carrier) — the hoisted externref slot was initialized with the
//    NON-null tag-1 $undefined singleton, then retyped to (ref null $Object),
//    and the local-set-coerce stack-balance fixup spliced an unguarded
//    ref.cast_null over the singleton → "illegal cast" at the function's first
//    instruction. Fixed by covering the carrier shape in
//    hoistedVarRetypesToConcreteRef (statements/variables.ts) so the hoist
//    emits ref.null.extern (the RegExp-retype discipline, #2106 S1 PR-2).
//
// 2. gOPD null accessor halves: __getOwnPropertyDescriptor materialized a NULL
//    stored get/set half with bare extern.convert_any — null externref, which
//    under the singleton regime is DISTINCT from undefined, so
//    `desc.get === undefined` answered false for explicit {get: undefined}
//    defines (15.2.3.6-4-439 shape). Fixed by materializing null halves as the
//    $undefined singleton (object-runtime-descriptors.ts, regime-gated).
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
  describe(`#3316 — singleton-regime carrier/gOPD fixes (${target})`, () => {
    it("minimal carrier repro: var d: any = { value: 5 } does not trap", async () => {
      const ret = await run(
        `
export function test(): number {
  var d1: any = { value: 5 };
  return d1.value === 5 ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("carrier with boolean + closure members survives and round-trips", async () => {
      const ret = await run(
        `
export function test(): number {
  var g1: any = function() { return 10; };
  var d1: any = { get: g1, configurable: true };
  return (d1.configurable === true && d1.get === g1) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("dynamic-descriptor accessor define + invoke (15.2.3.6-4-107 shape)", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var backing: any = 0;
  var g1: any = function() { return 10; };
  var s1: any = function(v: any) { backing = v; };
  var d1: any = { get: g1, set: s1, configurable: true };
  Object.defineProperty(o, "foo", d1);
  var g2: any = function() { return 20; };
  var d2: any = { get: g2 };
  Object.defineProperty(o, "foo", d2);
  o.foo = 99;
  return (o.foo === 20 && backing === 99) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("gOPD materializes a null accessor half as undefined", async () => {
      const ret = await run(
        `
export function test(): number {
  var o: any = {};
  o["q"] = 0;
  var g1: any = function() { return 10; };
  var d1: any = { get: g1, configurable: true };
  Object.defineProperty(o, "foo", d1);
  var desc: any = Object.getOwnPropertyDescriptor(o, "foo");
  return (desc.get === g1 && desc.set === undefined) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });
  });
}
