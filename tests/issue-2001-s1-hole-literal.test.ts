// (#2001 S1) Sparse-array literal holes store the `$Hole` sentinel.
//
// S1 introduces the `$Hole` anyref sentinel and makes a literal elision
// (`[1, , 3]`) in an `any[]` / untyped (externref-element) vec a genuine hole,
// distinct from an explicit `undefined`, WITHOUT yet changing HOF visit
// semantics. The observable behavior at S1 is therefore unchanged from a
// correctness standpoint — join still renders `"1,,3"`, reads still yield
// `undefined` — but now *because* of the sentinel (the read boundary maps
// `$Hole → undefined` and join maps `$Hole → ""`), which is the foundation the
// S2 HOF visit-skip rides on.
//
// Scope: ONLY `any[]` / untyped externref-element vecs. Typed `number[]` holes
// are unrepresentable in valid TS (`const a: number[] = [1, , 3]` is a TS type
// error — `undefined` not assignable to `number`), so a typed numeric kernel is
// byte-identical (the dense-kernel no-regression guard below). A `[1,,3] as
// number[]` cast does NOT force a typed numeric vec — the literal's
// element-type heuristic still sees the hole + heterogeneity and lowers to an
// externref vec, so it is in scope (treated as `any[]`), not a typed vec.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Host-mode harness (buildImports + setExports — the canonical host runtime
// glue, so a newly-imported helper can never be silently masked).
async function run(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

// Standalone harness (empty imports `{}` — a leaked host import fails
// instantiation; `$Hole` is pure WasmGC so this must pass). Returns a number so
// we never decode native strings — assert via `.length` / `.charCodeAt`.
async function runStandalone(source: string, fn = "run"): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>)[fn]();
}

describe("#2001 S1 — sparse-array literal holes ($Hole sentinel, any[] only)", () => {
  describe("host — element read maps $Hole → undefined", () => {
    it("typeof of a hole index is undefined (sentinel never leaks)", async () => {
      expect(await run(`export function run(): string { const a: any[] = [1, , 3]; return typeof a[1]; }`)).toBe(
        "undefined",
      );
    });

    it("strict-eq sees undefined, NOT the sentinel struct", async () => {
      // a[1] === undefined exercises the read-boundary invariant directly — if
      // the $Hole sentinel leaked, this would be false (a struct ≠ undefined).
      // The host harness returns a boolean export as i32 1/0.
      expect(
        await run(`export function run(): boolean { const a: any[] = [1, , 3]; return a[1] === undefined; }`),
      ).toBe(1);
    });

    it("present indices read their real values", async () => {
      expect(await run(`export function run(): number { const a: any[] = [1, , 3]; return a[0] as number; }`)).toBe(1);
      expect(await run(`export function run(): number { const a: any[] = [1, , 3]; return a[2] as number; }`)).toBe(3);
    });

    it("String(a[hole]) is 'undefined' (read yields undefined, not '')", async () => {
      // The hole reads back as JS undefined; String(undefined) === "undefined".
      // (Only Array.prototype.join/toString render a hole as "".)
      expect(await run(`export function run(): string { const a: any[] = [1, , 3]; return String(a[1]); }`)).toBe(
        "undefined",
      );
    });
  });

  describe("host — join renders holes as ''", () => {
    it('[1,,3].join(",") === "1,,3"', async () => {
      expect(await run(`export function run(): string { const a: any[] = [1, , 3]; return a.join(","); }`)).toBe(
        "1,,3",
      );
    });

    it("a literal hole joins the same as an explicit undefined", async () => {
      expect(
        await run(`export function run(): string { const a: any[] = [1, undefined, 3]; return a.join(","); }`),
      ).toBe("1,,3");
    });

    it("leading + multiple holes", async () => {
      expect(await run(`export function run(): string { const a: any[] = [, , 3]; return a.join(","); }`)).toBe(",,3");
    });

    it("holes interleaved with strings / booleans (mixed any[])", async () => {
      expect(
        await run(`export function run(): string { const a: any[] = [1, , "z", , true]; return a.join("-"); }`),
      ).toBe("1--z--true");
    });

    it("toString (default ',' separator) renders holes as ''", async () => {
      expect(await run(`export function run(): string { const a: any[] = [1, , 3]; return a.toString(); }`)).toBe(
        "1,,3",
      );
    });
  });

  describe("host — length and non-hole shapes are unaffected", () => {
    it("holes count toward length", async () => {
      expect(await run(`export function run(): number { const a: any[] = [1, , 3]; return a.length; }`)).toBe(3);
      expect(await run(`export function run(): number { const a: any[] = [, , 3]; return a.length; }`)).toBe(3);
    });

    it("a hole-free any[] joins unchanged", async () => {
      expect(await run(`export function run(): string { const a: any[] = ["x", "y"]; return a.join(","); }`)).toBe(
        "x,y",
      );
    });

    it("a trailing comma is NOT a hole", async () => {
      expect(await run(`export function run(): string { const a: any[] = [1, 2,]; return a.join(","); }`)).toBe("1,2");
    });
  });

  describe("typed no-regression guard (the dense numeric kernel is untouched)", () => {
    it("a dense number[] forEach kernel still sums correctly", async () => {
      // number[] elements are f64 — they never see a $Hole struct, a ref.test,
      // or the read guard. This kernel is byte-identical to pre-S1.
      expect(
        await run(
          `export function run(): number { const a = [1, 2, 3, 4]; let s = 0; a.forEach((x) => { s += x; }); return s; }`,
        ),
      ).toBe(10);
    });

    it("a dense number[] join is unchanged", async () => {
      expect(await run(`export function run(): string { const a = [1, 2, 3]; return a.join(","); }`)).toBe("1,2,3");
    });

    it("the compiled binary is deterministic (reproducible bytes)", async () => {
      const src = `export function run(): number { const a = [1, 2, 3, 4]; let s = 0; a.forEach((x) => { s += x; }); return s; }`;
      const a = (await compile(src)).binary;
      const b = (await compile(src)).binary;
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });

    it("a dense numeric kernel in a hole-bearing module still compiles + runs (gate is element-typed, not module-wide)", async () => {
      // Same numeric kernel, but the module ALSO has an any[] hole literal.
      // `usesArrayHoles` is now set module-wide, yet the f64-element `sum` vec
      // must not gain any hole machinery (gated on externref element type).
      const src =
        `export function sum(): number { const a = [1, 2, 3, 4]; let s = 0; a.forEach((x) => { s += x; }); return s; }\n` +
        `export function holeJoin(): string { const b: any[] = [1, , 3]; return b.join(","); }`;
      expect(await run(src, "sum")).toBe(10);
      expect(await run(src, "holeJoin")).toBe("1,,3");
    });
  });

  describe("read-boundary invariant — a hole never leaks the sentinel to a value reader", () => {
    // S1 does NOT yet skip holes in HOFs (that is S2) — forEach/map/etc still
    // VISIT the hole — but the visited value MUST be `undefined`, never the
    // `$Hole` sentinel struct. These lock in the no-regression contract: before
    // S1 a hole was stored as `undefined`, so every reader saw `undefined`;
    // after S1 it is stored as `$Hole`, so every value reader must map it back.

    it("for-of yields undefined at a hole", async () => {
      expect(
        await run(
          `export function run(): string { const a: any[] = [1, , 3]; let r = ""; for (const x of a) { r += typeof x + ","; } return r; }`,
        ),
      ).toBe("number,undefined,number,");
    });

    it("array destructuring binds undefined at a hole", async () => {
      expect(
        await run(`export function run(): string { const a: any[] = [1, , 3]; const [p, q, r] = a; return typeof q; }`),
      ).toBe("undefined");
    });

    it("forEach callback receives undefined (visited, not the sentinel)", async () => {
      expect(
        await run(
          `export function run(): string { const a: any[] = [1, , 3]; let r = ""; a.forEach((x) => { r += typeof x; }); return r; }`,
        ),
      ).toBe("numberundefinednumber");
    });

    it("map produces undefined at a hole's index in S1", async () => {
      expect(
        await run(
          `export function run(): string { const a: any[] = [1, , 3]; return a.map((x) => typeof x).join(","); }`,
        ),
      ).toBe("number,undefined,number");
    });

    it("filter callback sees undefined", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1, , 3]; return a.filter((x) => x === undefined).length; }`,
        ),
      ).toBe(1);
    });

    it("some/every observe undefined at a hole", async () => {
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1, , 3]; return a.some((x) => x === undefined); }`,
        ),
      ).toBe(1);
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1, , 3]; return a.every((x) => x !== undefined); }`,
        ),
      ).toBe(0);
    });

    it("find returns the undefined element for a matching hole", async () => {
      expect(
        await run(
          `export function run(): string { const a: any[] = [1, , 3]; return typeof a.find((x) => x === undefined); }`,
        ),
      ).toBe("undefined");
    });

    it("indexOf/includes treat a hole as undefined (Get semantics)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1, , 3]; return a.indexOf(undefined); }`),
      ).toBe(1);
      expect(
        await run(`export function run(): boolean { const a: any[] = [1, , 3]; return a.includes(undefined); }`),
      ).toBe(1);
    });

    it("reduce folds the hole as undefined", async () => {
      expect(
        await run(
          `export function run(): string { const a: any[] = [1, , 3]; return a.reduce((acc, x) => acc + "," + typeof x, "s"); }`,
        ),
      ).toBe("s,number,undefined,number");
    });

    it("at() of a hole is undefined", async () => {
      expect(await run(`export function run(): string { const a: any[] = [1, , 3]; return typeof a.at(1); }`)).toBe(
        "undefined",
      );
    });

    it("pop of a trailing hole is undefined", async () => {
      expect(await run(`export function run(): string { const a: any[] = [1, ,]; return typeof a.pop(); }`)).toBe(
        "undefined",
      );
    });

    it("slice copies the hole (still '' on join)", async () => {
      expect(
        await run(`export function run(): string { const a: any[] = [1, , 3]; return a.slice(0).join(","); }`),
      ).toBe("1,,3");
    });
  });

  describe("standalone (pure Wasm, no host import — $Hole is engine-native)", () => {
    it('[1,,3].join(",") is valid Wasm and renders "1,,3"', async () => {
      // length 4: '1' ',' ',' '3'
      expect(
        await runStandalone(`export function run(): number { const a: any[] = [1, , 3]; return a.join(",").length; }`),
      ).toBe(4);
      // char 0 = '1' (49), char 1 = ',' (44), char 2 = ',' (44, the hole → ""),
      // char 3 = '3' (51).
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1, , 3]; return a.join(",").charCodeAt(0); }`,
        ),
      ).toBe(49);
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1, , 3]; return a.join(",").charCodeAt(1); }`,
        ),
      ).toBe(44);
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1, , 3]; return a.join(",").charCodeAt(2); }`,
        ),
      ).toBe(44);
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1, , 3]; return a.join(",").charCodeAt(3); }`,
        ),
      ).toBe(51);
    });

    it("hole length is preserved standalone", async () => {
      expect(await runStandalone(`export function run(): number { const a: any[] = [1, , 3]; return a.length; }`)).toBe(
        3,
      );
    });

    it("a hole-free any[] join is valid Wasm standalone (no leaked import)", async () => {
      expect(
        await runStandalone(`export function run(): number { const a: any[] = [1, 2, 3]; return a.join(",").length; }`),
      ).toBe(5);
    });
  });
});
