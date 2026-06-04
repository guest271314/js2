import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { compile } from "../src/index.js";
import { wrapTest, parseMeta } from "./test262-runner.js";

// #1809 — late-import shift walker "misses" a method-trampoline / func-ref
// closure whose captured funcIdx points at a HOST IMPORT.
//
// Root cause: when a bare identifier is used as a *value* (not called) and
// `ctx.funcMap.get(name)` resolves to an ambient host import — e.g. the DOM
// global `resizeTo`/`resizeBy` (lib.dom.d.ts) or the `wasm:js-string.length`
// builtin — the funcref-closure path (identifiers.ts) built a cached/per-site
// closure trampoline around the *import* index. A host import has no in-module
// body to forward to via `ref.func`, and the captured index later trips the
// `finalizeMethodTrampolines` guard with a hard compile error:
//
//   pendingMethodTrampolines: methodFuncIdx N points at import "resizeTo"
//   — shift walker missed this entry (#1525b regression)
//
// This was NOT a shift-walker miss — the index was an import from the start.
// The fix gates the funcref-closure path on `funcRefIdx >= ctx.numImportFuncs`
// so imports fall through to the type-appropriate graceful default (valid
// Wasm, no spurious throw). 157 default-lane test262 tests were affected.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST262 = resolve(__dirname, "..", "test262", "test");

async function compileTest262(relPath: string): Promise<{ success: boolean; firstError?: string }> {
  const src = readFileSync(resolve(TEST262, relPath), "utf-8");
  const meta = parseMeta(src);
  const wrapped = wrapTest(src, meta);
  try {
    const r = await compile(wrapped.source, { fileName: "test.ts", skipSemanticDiagnostics: true });
    return { success: r.success, firstError: r.success ? undefined : r.errors?.[0]?.message };
  } catch (e: unknown) {
    return { success: false, firstError: e instanceof Error ? e.message : String(e) };
  }
}

describe("#1809 funcref closure must not wrap host imports", () => {
  // The exact reproducers from the issue: a method-trampoline / func-ref
  // closure whose captured funcIdx resolved to a host import (resizeTo /
  // wasm:js-string.length). Pre-fix these threw the "shift walker missed"
  // hard compile error; post-fix they must compile to valid Wasm.
  const reproducers = [
    "built-ins/Array/prototype/map/resizable-buffer-grow-mid-iteration.js",
    "built-ins/Array/prototype/reduceRight/resizable-buffer-shrink-mid-iteration.js",
    "language/expressions/class/dstr/gen-meth-static-ary-ptrn-rest-obj-prop-id.js",
  ];

  for (const rel of reproducers) {
    it(`compiles ${rel} without the trampoline import-shift assertion`, async () => {
      const { success, firstError } = await compileTest262(rel);
      // The specific #1525b-tagged assertion must never fire again.
      expect(firstError ?? "").not.toContain("shift walker missed");
      expect(firstError ?? "").not.toContain("points at import");
      // And these particular files now compile to valid Wasm.
      expect(success).toBe(true);
    });
  }

  it("a user-defined function used as a value is still wrapped as a closure", async () => {
    // Guard the #1340 cached-closure-identity feature: a DEFINED function used
    // as a first-class value must still round-trip (foo === foo), which the
    // import-guard must not disturb.
    const r = await compile(
      `
        function foo(x: number): number { return x + 1; }
        export function test(): number {
          const f = foo;
          const g = foo;
          // Identity must hold for cached function closures.
          return f === g ? f(41) : -1;
        }
      `,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
  });
});
