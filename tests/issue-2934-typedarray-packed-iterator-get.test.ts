// #2934 slice 1 — TypedArray packed-i8/i16 iterator read emitted a plain
// `array.get` on a PACKED backing array (a Uint8Array/Int8Array etc. source
// vec), which is a hard Wasm validator error ("Array type N has packed type i8.
// Use array.get_s or array.get_u instead") — the standalone `test` invalid-Wasm
// bucket for `TypedArray.prototype.{values,keys,entries}` over a resizable
// buffer.
//
// Fix (array-methods.ts `emitBoxedElem`): read the packed element with the
// established `getOp` idiom (`i8 → array.get_u`, `i16 → array.get_s`, else plain
// `array.get`), mirroring the 7 other sites in the file.
//
// NOTE: this is ONE facet of the broader #2934 TypedArray packed-array surface.
// `.entries()` (a distinct `encodeValType: packed` emit error), `TypedArray.set`
// / `toBase64` (a distinct DCE type-index-remap), and simple `for-of u.values()`
// (an IR-path demotion) are SEPARATE bugs tracked by the same umbrella.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262 = process.env.TEST262_ROOT ?? join(REPO_ROOT, "test262");

// The two test262 files this fix flips from standalone invalid-Wasm → valid.
const FIXED = [
  "test/built-ins/TypedArray/prototype/values/make-in-bounds-after-exhausted.js",
  "test/built-ins/TypedArray/prototype/values/make-out-of-bounds-after-exhausted.js",
];

describe("#2934 — TypedArray packed-array iterator read is valid Wasm (standalone)", () => {
  for (const rel of FIXED) {
    const abs = join(TEST262, rel);
    const present = existsSync(abs);
    it.skipIf(!present)(`compiles ${rel} to valid standalone Wasm`, async () => {
      const src = readFileSync(abs, "utf-8");
      const wrapped = wrapTest(src, parseMeta(src)).source;
      const r = await compile(wrapped, {
        fileName: "test.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      });
      expect(r.success).toBe(true);
      // The packed `array.get` bug made this reject at validation; it must now
      // produce an engine-acceptable module.
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    });
  }
});
