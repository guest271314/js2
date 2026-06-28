// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2811 (parent #2669) — destructuring closure-capture residual.
 *
 * Two pre-existing codegen bugs, both on the path of the test262
 * `ary-ptrn-rest-obj-prop-id` dstr cluster (`[...{ …, length: z }]` guarded by an
 * outer `let length = "outer"`):
 *
 *   A. A module/outer variable named like a wasm:js-string builtin
 *      (`concat`/`length`/`equals`/`substring`/`charCodeAt`) was never globalized
 *      / captured. `addStringImports` registers those names into `ctx.funcMap`
 *      (mirrored in `ctx.jsStringImports`, #1072); the capture/global gates
 *      `funcMap.has(name)` then skipped a *user* variable of the same name, so it
 *      stayed a `__module_init` local / was dropped from the capture set → reads
 *      from another function returned null. Fix: skip only a genuine user
 *      function — `funcMap.get(name) !== jsStringImports.get(name)`.
 *
 *   B. A capturing function with a destructuring param read the WRONG param slot
 *      when it captured a TDZ-flagged (let / read) variable. The lifted param
 *      layout is [valueCaps(N), tdzFlagBoxes(K), userParams]; the destructure /
 *      default-init / arguments offset used `captures.length` (N) only, ignoring
 *      the K prepended TDZ-flag boxes → the destructuring read a TDZ i32-flag cell
 *      as the array argument → invalid Wasm (`any.convert_extern` on a non-extern
 *      ref). `var` write-only captures (K=0) were unaffected. Fix: offset by
 *      `captures.length + tdzFlaggedCaptures.length`.
 *
 * Bug C (block-scoped let captured by a hoisted FUNCTION DECLARATION → null) is
 * carved to architect and NOT covered here; it gates the function-declaration /
 * class-method contexts of the same cluster.
 */

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool) as unknown as {
    importObject?: WebAssembly.Imports;
    setExports?: (e: WebAssembly.Exports) => void;
  } & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    (imports.importObject ?? imports) as WebAssembly.Imports,
  );
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return (instance.exports as { test: () => number }).test();
}

describe("#2811 A — captured/globalized variable named like a js-string builtin", () => {
  // Each builtin name, declared at module scope and read from a nested function.
  // Pre-fix: the gate `funcMap.has(name)` skipped it → the read returned null.
  for (const name of ["length", "concat", "equals", "substring", "charCodeAt"]) {
    it(`module-level \`let ${name}\` is captured by a nested function`, async () => {
      expect(
        await run(
          `let ${name} = 42;
           function g(): number { return ${name} as number; }
           export function test(): number { return g(); }`,
        ),
      ).toBe(42);
    });
  }

  it("a `{ length: z }` binding KEY does not shadow an outer captured `length`", async () => {
    // The crux of the test262 `ary-ptrn-rest-obj-prop-id` cluster: the property
    // KEY `length` in the destructuring pattern binds z, while the outer captured
    // `length` variable (read inside the same function) must still resolve to its
    // own value — not collapse to the js-string builtin / null.
    expect(
      await run(
        `let length = 7;
         let out = 0;
         function f([...{ 0: a, length: z }]: number[]): void { out = (length as number) * 100 + (z as number); }
         f([7, 8, 9]);
         export function test(): number { return out; }`,
      ),
    ).toBe(703); // outer length stays 7, z = rest-array length = 3
  });
});

describe("#2811 B — capturing function with a destructuring param + TDZ-flagged capture", () => {
  it("array-pattern param capturing a `let` (read) compiles to valid Wasm", async () => {
    // Pre-fix: invalid Wasm (`any.convert_extern` on a non-externref) — the
    // destructuring read a prepended TDZ-flag i32 cell as the array argument.
    expect(
      await run(
        `let c = 5;
         let out = 0;
         function f([a]: number[]): void { out = a * 10 + c; }
         f([7]);
         export function test(): number { return out; }`,
      ),
    ).toBe(75);
  });

  it("rest-into-object param capturing a `let` reads the array `.length` and indices", async () => {
    expect(
      await run(
        `let len = 0;
         let v = 0;
         let z = 0;
         function f([...{ 0: a, 2: c, length: n }]: number[]): void { v = a; z = c; n; len = n; }
         f([7, 8, 9]);
         export function test(): number { return v * 100 + z * 10 + len; }`,
      ),
    ).toBe(793); // v=7, z(index2)=9, len=3
  });

  it("var write-capture (no TDZ flag) still works — offset unchanged when K=0", async () => {
    expect(
      await run(
        `export function test(): number { var c = 0; function f([a]: number[]): void { c = c + a; } f([4]); f([6]); return c; }`,
      ),
    ).toBe(10);
  });
});
