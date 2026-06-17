// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2160 — `String(arr)` / `Number(arr)` array→primitive coercion in standalone.
 *
 * In native-strings (standalone / WASI) mode there is no JS-host
 * `__extern_toString`/`__unbox_number` to run ToPrimitive on a WasmGC array
 * struct, so the generic `coerceType` ref→string / ref→number path null-derefed
 * (`String([1,2,3])`) or yielded NaN (`Number([5])` → NaN instead of 5).
 *
 * The fix (calls.ts String()/Number() handlers) routes an array argument
 * through its native `Array.prototype.toString` (§23.1.3.36 → join(",")) via
 * the existing `compileArrayJoinNative` lowering — additive, before the
 * coerceType fall-through, and NOT touching the shared coercion engine (#1917).
 * For Number() the resulting native string is run through `__str_to_number`
 * (ToNumber(ToString(arr)) per §7.1.4 → §7.1.1.1).
 *
 * Boolean-element arrays are intentionally NOT covered (the join path packs
 * them i8 and synthetic-dispatch element-type resolution diverges) — they fall
 * through to existing behavior with no regression; out of this slice's scope.
 *
 * All standalone/WASI cases instantiate with an EMPTY import object, proving no
 * JS host is needed.
 */

// Build one module with one export per case (keeps compile cost down).
type Case = { name: string; src: string; want: number };

const CASES: ReadonlyArray<Case> = [
  // String(numeric array) — "1,2,3" length 5
  { name: "strNumArr", src: `const s = String([1,2,3]); return s.length;`, want: 5 },
  // String([5]) → "5", first char '5' = 53
  { name: "strSingle", src: `const s = String([5]); return s.length * 100 + s.charCodeAt(0);`, want: 153 },
  // String(string array) — "a,b" length 3, chars a(97) ,(44) b(98)
  {
    name: "strStrArr",
    src: `const s = String(["a","b"]); return s.length * 1000000 + s.charCodeAt(0) * 1000 + s.charCodeAt(2);`,
    want: 3 * 1000000 + 97 * 1000 + 98,
  },
  // String(empty typed array) — "" length 0
  { name: "strEmpty", src: `const a: number[] = []; const s = String(a); return s.length;`, want: 0 },
  // Number([5]) → ToNumber("5") = 5
  { name: "numSingle", src: `return Number([5]);`, want: 5 },
  // Number(["7"]) → ToNumber("7") = 7
  { name: "numStr", src: `return Number(["7"]);`, want: 7 },
  // Number([3.5]) → 3.5 → *10 = 35
  { name: "numFloat", src: `return Number([3.5]) * 10;`, want: 35 },
  // Number(empty typed array) → ToNumber("") = 0
  { name: "numEmpty", src: `const a: number[] = []; return Number(a);`, want: 0 },
  // Number([1,2]) → ToNumber("1,2") = NaN
  { name: "numNaN", src: `return Number.isNaN(Number([1,2])) ? 1 : 0;`, want: 1 },
  // Regression: scalar String/Number still correct
  { name: "regStrNum", src: `return String(42).length;`, want: 2 },
  { name: "regStrNull", src: `return String(null).length;`, want: 4 },
  { name: "regNumStr", src: `return Number("3.5") * 10;`, want: 35 },
  // Regression: direct arr.toString() unaffected
  { name: "regArrToString", src: `return [1,2,3].toString().length;`, want: 5 },
];

const MODULE_SRC = CASES.map((c) => `export function ${c.name}(): number { ${c.src} }`).join("\n");

function expectAll(ex: Record<string, () => number>, label: string): void {
  for (const c of CASES) {
    expect(ex[c.name]!(), `${label} ${c.name}`).toBe(c.want);
  }
}

describe("#2160 String()/Number() array→primitive coercion — standalone", () => {
  it("coerces arrays via native toString (standalone, no host imports)", async () => {
    const r = await compile(MODULE_SRC, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No JS-host coercion imports must leak.
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    for (const re of [/^env::__extern_toString$/, /^env::__unbox_number$/, /^wasm:js-string::/]) {
      expect(
        labels.filter((l) => re.test(l)),
        `leaked ${re}`,
      ).toEqual([]);
    }
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expectAll(instance.exports as Record<string, () => number>, "standalone");
  });

  it("coerces arrays via native toString (WASI, no host imports)", async () => {
    const r = await compile(MODULE_SRC, { target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expectAll(instance.exports as Record<string, () => number>, "WASI");
  });
});
