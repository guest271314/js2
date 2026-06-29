// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2820 (carved from #2811 / parent #2669) — Bug C: a block-scoped `let`/`const`
 * captured by a *hoisted FunctionDeclaration* read null.
 *
 * Root cause (duplicate-local desync):
 *   - `hoistLetConstWithTdz` (walkStmtForLetConst) recurses into the block and
 *     pre-allocates the block-`let` at the *function* level (slot 0).
 *   - `hoistFunctionDeclarations` lifts the nested `function f` and records its
 *     capture against that pre-hoisted slot 0 (this path has no #1177 name-scan
 *     fallback, unlike the arrow path).
 *   - `saveBlockScopedShadows` then deletes slot 0 on block entry and the `let`
 *     re-allocates a FRESH slot (slot 2) → the capture stays pinned to the
 *     never-written slot 0 → the closure reads null.
 *
 * Fix (producer side, `compileVariableStatement`): when the block-let's OWN
 * pre-hoisted slot was shadow-removed (decl-keyed record from the pre-pass,
 * recorded only for names with no outer/param/var shadow), reuse it instead of
 * re-allocating — value-slot == capture-slot. No capture-resolution change, so
 * the reverted localMap-first attempt (100+ async-TDZ regressions) cannot recur.
 *
 * Out of scope (carved to a follow-up): the CLASS-METHOD context of the same
 * cluster. Class methods capture outer locals via promoted globals
 * (`__captured_*`), and for a block-nested class the body is compiled before the
 * block-let initializes, so `promoteAccessorCapturesToGlobals` never fires — a
 * distinct class-collection-ordering bug, not the duplicate-local desync.
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

describe("#2820 Bug C — block-scoped let captured by a hoisted FunctionDeclaration", () => {
  it("plain block: `{ let s; function f(){return s;} f(); }` reads the let, not null", async () => {
    expect(
      await run(
        `export function test(): number {
           { let s = 7; function f(): number { return s; } return f(); }
         }`,
      ),
    ).toBe(7);
  });

  it("string-valued block-let is captured (was null)", async () => {
    expect(
      await run(
        `export function test(): number {
           { let s = "outer"; function f(): string { return s; } return f() === "outer" ? 1 : 0; }
         }`,
      ),
    ).toBe(1);
  });

  it("try-block let captured by hoisted fn decl (the test262 cluster shape)", async () => {
    // wrapTest wraps every test body in `try { ... }`, so the cluster's
    // `let length = "outer"` lands inside a try block → block-scoped.
    expect(
      await run(
        `export function test(): number {
           try { let s = 5; function f(): number { return s; } return f(); }
           catch { return -1; }
         }`,
      ),
    ).toBe(5);
  });

  it("capture observes a post-construction mutation to the block-let", async () => {
    // The fix re-aligns BOTH read and write to the same slot, so a later
    // assignment to the block-let is visible through the captured read.
    expect(
      await run(
        `export function test(): number {
           { let s = 1; function f(): number { return s; } s = 9; return f(); }
         }`,
      ),
    ).toBe(9);
  });

  it("captured `let length` (js-string builtin name) in a block — A+C together", async () => {
    // Bug A (#2811) lets a builtin-named outer var be captured at all; Bug C
    // makes the block-scoped instance read the right slot.
    expect(
      await run(
        `export function test(): number {
           { let length = "outer";
             function f(): string { return length; }
             let arr: any = [7, 8, 9];
             let z: any = arr.length;
             return f() === "outer" && z === 3 ? 1 : 0; }
         }`,
      ),
    ).toBe(1);
  });

  it("const block-binding captured by hoisted fn decl", async () => {
    expect(
      await run(
        `export function test(): number {
           { const k = 42; function f(): number { return k; } return f(); }
         }`,
      ),
    ).toBe(42);
  });

  it("two hoisted fn decls in the block share the captured block-let", async () => {
    expect(
      await run(
        `export function test(): number {
           { let s = 3;
             function f(): number { return s; }
             function g(): number { return s + 1; }
             return f() === 3 && g() === 4 ? 1 : 0; }
         }`,
      ),
    ).toBe(1);
  });
});

describe("#2820 regression controls — must stay correct", () => {
  it("arrow capturing a block-let (already worked via the #1177 name-scan)", async () => {
    expect(
      await run(
        `export function test(): number {
           { let s = 11; const f = (): number => s; return f(); }
         }`,
      ),
    ).toBe(11);
  });

  it("function expression capturing a block-let", async () => {
    expect(
      await run(
        `export function test(): number {
           { let s = 12; const f = function (): number { return s; }; return f(); }
         }`,
      ),
    ).toBe(12);
  });

  it("function-scope let captured by hoisted fn decl (no block — unchanged path)", async () => {
    expect(
      await run(
        `export function test(): number {
           let s = 13; function f(): number { return s; } return f();
         }`,
      ),
    ).toBe(13);
  });

  it("block-var captured by hoisted fn decl (var is not block-scoped)", async () => {
    expect(
      await run(
        `export function test(): number {
           { var s = 14; function f(): number { return s; } return f(); }
         }`,
      ),
    ).toBe(14);
  });

  it("genuine shadow: a block-let shadowing a function-scope let keeps distinct slots", async () => {
    // The fix must NOT collapse a genuine shadow into one slot. The pre-pass
    // SKIPS the inner decl (the outer name already occupies localMap), so it is
    // never recorded for reuse → the inner re-allocates a fresh slot.
    expect(
      await run(
        `export function test(): number {
           let s = 100;
           { let s = 200; if (s !== 200) return -1; }
           return s; // outer must be untouched
         }`,
      ),
    ).toBe(100);
  });

  it("genuine shadow: a block-let shadowing a parameter keeps the param intact", async () => {
    expect(
      await run(
        `export function test(): number { return outer(100); }
         function outer(p: number): number {
           { let p = 200; if (p !== 200) return -1; }
           return p; // param must be untouched
         }`,
      ),
    ).toBe(100);
  });

  it("#1607 TDZ self-reference in a block still throws (flag reuse keeps zero-init)", async () => {
    // `{ const x = x + 1; }` reads x in its own initializer → TDZ ReferenceError.
    // Reusing the pre-hoisted (zero-init) flag slot must preserve the throw.
    expect(
      await run(
        `export function test(): number {
           let threw = 0;
           try { { const x: number = (x as number) + 1; if (x) {} } } catch { threw = 1; }
           return threw;
         }`,
      ),
    ).toBe(1);
  });

  it("nested same-name blocks: inner shadow does not clobber the outer block-let", async () => {
    expect(
      await run(
        `export function test(): number {
           { let s = 1;
             { let s = 2; if (s !== 2) return -1; }
             return s; }
         }`,
      ),
    ).toBe(1);
  });
});
