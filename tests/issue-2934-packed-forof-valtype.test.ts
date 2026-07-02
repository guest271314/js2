// #2934 slice 1b — for-of over a packed (i8/i16) typed array leaked the PACKED
// storage type into value positions, a hard standalone compile error
// ("encodeValType: packed storage type is not valid in a value position"):
//
//   1. `compileForOfArray` / `compileForOfArrayEntries` (statements/loops.ts)
//      allocated the loop variable local with the raw `arrDef.element` (i8/i16)
//      and read it with a plain `array.get` (invalid on a packed array). Every
//      `for (const v of u)` / `of u.values()` / `of u.entries()` over a
//      Uint8Array/Int8Array/Int16Array/… was a standalone CE.
//   2. The stack-balance pass's type simulation pushed the raw packed element
//      type for `array.get_s/_u` reads; the struct.new arg-coercion repair then
//      materialized that packed type into a `$sn_tmp` temp local.
//   3. The vec→tuple coercion paths (type-coercion.ts) used plain `array.get`
//      + a packed `if` blockType when the source vec was packed
//      (`it.next().value` destructuring).
//
// Fix: bind/read via the canonical `unpackedElemType` / `elemGetOp` helpers
// (now in shared.ts) — the loop var is the widened i32, the read op is
// view-name-signedness-driven (`Int*` → get_s, `Uint*` → get_u, #2648), and the
// simulator models the widened i32 that is actually on the stack.
//
// Flips language/statements/for-of/{u,}int{8,16}array{,-mutate}.js +
// uint8clampedarray{,-mutate}.js standalone CE → pass (10 files).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262 = process.env.TEST262_ROOT ?? join(REPO_ROOT, "test262");

// The test262 family this fix flips from standalone emit-error → pass.
const FIXED = [
  "test/language/statements/for-of/uint8array.js",
  "test/language/statements/for-of/int8array.js",
  "test/language/statements/for-of/uint16array.js",
  "test/language/statements/for-of/int16array.js",
  "test/language/statements/for-of/uint8clampedarray.js",
  "test/language/statements/for-of/uint8array-mutate.js",
];

async function compileStandalone(source: string) {
  return compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
}

describe("#2934 1b — packed typed-array for-of is valid standalone Wasm", () => {
  for (const rel of FIXED) {
    const abs = join(TEST262, rel);
    const present = existsSync(abs);
    it.skipIf(!present)(`compiles ${rel} to valid standalone Wasm`, async () => {
      const src = readFileSync(abs, "utf-8");
      const wrapped = wrapTest(src, parseMeta(src)).source;
      const r = await compileStandalone(wrapped);
      expect(r.success).toBe(true);
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    });
  }

  // Signedness is view-name-driven, not storage-driven (#2648): Int8Array must
  // sign-extend (get_s), Uint8Array zero-extend (get_u), and Uint16Array
  // zero-extend even though i16 storage's legacy heuristic is get_s.
  const SEMANTIC: Array<{ name: string; src: string; expected: number }> = [
    {
      name: "Uint8Array zero-extends (200 stays 200)",
      src: "const u = new Uint8Array(1); u[0] = 200; let s = 0; for (const v of u) s += v; s;",
      expected: 200,
    },
    {
      name: "Int8Array sign-extends (-56 not 200)",
      src: "const u = new Int8Array(1); u[0] = 200 as never; let s = 0; for (const v of u) s += v; s;",
      expected: -56,
    },
    {
      name: "Uint16Array zero-extends (40000 stays 40000)",
      src: "const u = new Uint16Array(1); u[0] = 40000; let s = 0; for (const v of u) s += v; s;",
      expected: 40000,
    },
    {
      name: "Int16Array sign-extends (-30000)",
      src: "const u = new Int16Array(1); u[0] = -30000; let s = 0; for (const v of u) s += v; s;",
      expected: -30000,
    },
    {
      name: ".entries() over Uint8Array binds [i, v]",
      src: "const u = new Uint8Array(3); u[0] = 10; u[1] = 20; u[2] = 30; let s = 0; for (const [i, v] of u.entries()) s += i + v; s;",
      expected: 63,
    },
    {
      name: ".values() over Int8Array",
      src: "const u = new Int8Array(2); u[0] = -128; let s = 0; for (const v of u.values()) s += v; s;",
      expected: -128,
    },
  ];

  for (const { name, src, expected } of SEMANTIC) {
    it(name, async () => {
      const wrapped = `export function test(): number { ${src.replace(/; s;$/, "; return s;")} }`;
      const r = await compileStandalone(wrapped);
      expect(r.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const test = instance.exports.test as () => number;
      expect(test()).toBe(expected);
    });
  }
});
