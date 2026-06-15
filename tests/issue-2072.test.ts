// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2072 / #2080 — value-rep P0: type-aware AnyValue boxing recovery in the
 * standalone (no-JS-host) string-coercion and truthiness helpers.
 *
 * On the standalone / nativeStrings path an `any`-typed primitive is held as
 * an externref wrapping a boxed-primitive struct (`__box_number(f64)` →
 * `$__box_number_struct`, `__box_boolean(i32)` → `$__box_boolean_struct`) or,
 * for strings, a native `$AnyString` — NOT a `$AnyValue` box. (We deliberately
 * keep this externref ABI: the test262 comparator depends on it, and changing
 * it cost ~794 baseline passes in #1888.)
 *
 * Two native helpers were blind to these shapes:
 *   - `$__any_to_string` (native-strings.ts) recognized `$AnyString` and
 *     `$AnyValue` only, so `String(v)` for `v: any = 42 / true` returned
 *     "[object Object]" instead of "42" / "true" (#2072).
 *   - `__is_truthy` (index.ts addUnionImportsAsNativeFuncs) recognized the
 *     number / boolean / bigint boxes but NOT `$AnyString`, so an empty-string
 *     `any` fell through to the "any non-null ref → truthy" default and was
 *     wrongly truthy (#2080).
 *
 * These tests instantiate with an EMPTY import object (proving no JS host) and
 * read native-string results back via `.length` / `.charCodeAt`.
 *
 * NOTE: `String(v)` for `v: any = null / undefined` is intentionally NOT fixed
 * here — on the current standalone path both lower to a bare `ref.null extern`,
 * losing the null-vs-undefined distinction at the value level. Restoring that
 * distinction is the undefined-representation work owned by #2142 (spec) and
 * #2051 / #2106 (impl), out of scope for this P0.
 */

async function standaloneExports(source: string, target: "standalone" | "wasi" = "standalone") {
  const r = await compile(source, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // In standalone mode no JS-host string-coercion import may leak. (WASI
  // declares the union-import set even when it lowers them natively, so the
  // import-presence check only holds for the pure-standalone target.)
  if (target === "standalone") {
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    for (const re of [/^env::__extern_toString$/, /^wasm:js-string::/]) {
      expect(
        labels.filter((l) => re.test(l)),
        `leaked ${re}`,
      ).toEqual([]);
    }
  }
  // Empty import object — proves the module never *calls* a JS host.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...a: unknown[]) => number>;
}

describe("#2072 — String(any-boxed primitive) in standalone", () => {
  // String form encoded as len*1000 + charCodeAt(0) (matches #1470 test style).
  const SRC = `
    export function strNumAny(): number { const v: any = 42; const t = String(v); return t.length * 1000 + t.charCodeAt(0); }
    export function strFloatAny(): number { const v: any = 3.5; const t = String(v); return t.length * 1000 + t.charCodeAt(0); }
    export function strTrueAny(): number { const v: any = true; const t = String(v); return t.length * 1000 + t.charCodeAt(0); }
    export function strFalseAny(): number { const v: any = false; const t = String(v); return t.length * 1000 + t.charCodeAt(0); }
    export function strStrAny(): number { const v: any = "hi"; const t = String(v); return t.length * 1000 + t.charCodeAt(0); }
    export function strPop(): number { const a: any[] = [1, 2, 3]; const t = String(a.pop()); return t.length * 1000 + t.charCodeAt(0); }
  `;
  // "42"  → len 2, '4'=52  → 2052
  // "3.5" → len 3, '3'=51  → 3051
  // "true"→ len 4, 't'=116 → 4116
  // "false"→len 5, 'f'=102 → 5102
  // "hi"  → len 2, 'h'=104 → 2104
  // "3"   → len 1, '3'=51  → 1051
  const EXPECTED: Record<string, number> = {
    strNumAny: 2052,
    strFloatAny: 3051,
    strTrueAny: 4116,
    strFalseAny: 5102,
    strStrAny: 2104,
    strPop: 1051,
  };

  it("standalone: matches Node", async () => {
    const ex = await standaloneExports(SRC, "standalone");
    for (const [name, want] of Object.entries(EXPECTED)) {
      expect(ex[name]!(), name).toBe(want);
    }
  });

  it("wasi: compiles (shares the native helpers)", async () => {
    const r = await compile(SRC, { target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});

describe("#2080 — ToBoolean(any-boxed value) in standalone", () => {
  // Each export returns the truthiness of an `any`-held value as an i32 (1/0),
  // avoiding the native-string `===`/ref.eq harness artifact.
  const SRC = `
    export function emptyStr(): boolean { const v: any = ""; return v ? true : false; }
    export function nonEmptyStr(): boolean { const v: any = "x"; return v ? true : false; }
    export function zeroStr(): boolean { const v: any = "0"; return v ? true : false; }
    export function zeroNum(): boolean { const v: any = 0; return v ? true : false; }
    export function negZero(): boolean { const v: any = -0; return v ? true : false; }
    export function nan(): boolean { const v: any = NaN; return v ? true : false; }
    export function posNum(): boolean { const v: any = 42; return v ? true : false; }
    export function falseBool(): boolean { const v: any = false; return v ? true : false; }
    export function trueBool(): boolean { const v: any = true; return v ? true : false; }
  `;
  const EXPECTED: Record<string, number> = {
    emptyStr: 0,
    nonEmptyStr: 1,
    zeroStr: 1, // non-empty string is truthy even when it's "0"
    zeroNum: 0,
    negZero: 0,
    nan: 0,
    posNum: 1,
    falseBool: 0,
    trueBool: 1,
  };

  it("standalone: truthiness table matches §7.1.2", async () => {
    const ex = await standaloneExports(SRC, "standalone");
    for (const [name, want] of Object.entries(EXPECTED)) {
      expect(ex[name]!(), name).toBe(want);
    }
  });

  it("wasi: compiles (shares the native __is_truthy helper)", async () => {
    const r = await compile(SRC, { target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
