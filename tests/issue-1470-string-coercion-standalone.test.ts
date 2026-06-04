// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1470 — `String(...)` coercion of `null` / `undefined` / boolean / no-arg
 * must produce a valid module under `--target standalone` (and WASI).
 *
 * The `String()` builtin call handler and `emitBoolToString` previously pushed
 * `global.get` of a JS-host string-constant global (`addStringConstantGlobal`).
 * Those globals are never registered in native-strings mode, so the index
 * resolved to the -1 sentinel and the module failed validation with
 * `Invalid global index: 4294967295`. The fix routes the literal emissions
 * through `compileStringLiteral`, which materializes a `NativeString` GC
 * struct inline when native-strings is active.
 *
 * These cases instantiate with an EMPTY import object (proving no JS host is
 * needed) and read the resulting strings back via `.length` / `.charCodeAt`.
 */

const SRC = `
  export function strBool(): number { const t = String(true); return t.length * 1000 + t.charCodeAt(0); }
  export function strFalse(): number { const t = String(false); return t.length * 1000 + t.charCodeAt(0); }
  export function strNull(): number { const t = String(null); return t.length * 1000 + t.charCodeAt(0); }
  export function strUndef(): number { const t = String(undefined); return t.length * 1000 + t.charCodeAt(0); }
  export function strEmpty(): number { const t = String(); return t.length; }
  export function strNum(): number { const t = String(42); return t.length * 1000 + t.charCodeAt(0); }
  export function boolToString(): number { const b = true; const t = b.toString(); return t.length * 1000 + t.charCodeAt(0); }
`;

// "true"  → len 4, 't'=116 → 4116
// "false" → len 5, 'f'=102 → 5102
// "null"  → len 4, 'n'=110 → 4110
// "undefined" → len 9, 'u'=117 → 9117
// ""      → len 0
// "42"    → len 2, '4'=52  → 2052
const EXPECTED: Record<string, number> = {
  strBool: 4116,
  strFalse: 5102,
  strNull: 4110,
  strUndef: 9117,
  strEmpty: 0,
  strNum: 2052,
  boolToString: 4116,
};

async function instantiateStandalone(source: string, target: "standalone" | "wasi") {
  const r = await compile(source, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JS-host string-coercion imports must leak.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  for (const re of [/^env::__unbox_string$/, /^env::__extern_toString$/, /^wasm:js-string::/]) {
    expect(
      labels.filter((l) => re.test(l)),
      `leaked ${re}`,
    ).toEqual([]);
  }
  // Empty import object — proves the module is JS-host-free.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#1470 String() coercion of null/undefined/bool/empty — standalone", () => {
  it("produces a valid standalone module for every literal coercion", async () => {
    const ex = await instantiateStandalone(SRC, "standalone");
    for (const [fn, want] of Object.entries(EXPECTED)) {
      expect(ex[fn]!(), `String coercion ${fn}`).toBe(want);
    }
  });

  it("produces a valid WASI module for every literal coercion", async () => {
    const ex = await instantiateStandalone(SRC, "wasi");
    for (const [fn, want] of Object.entries(EXPECTED)) {
      expect(ex[fn]!(), `WASI String coercion ${fn}`).toBe(want);
    }
  });

  it("default (gc / JS-host) mode keeps correct String() coercion", async () => {
    // Regression guard: the JS-host path must keep returning the same values.
    const r = await compile(SRC, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    const ex = instance.exports as Record<string, () => number>;
    for (const [fn, want] of Object.entries(EXPECTED)) {
      expect(ex[fn]!(), `gc-mode String coercion ${fn}`).toBe(want);
    }
  });

  it("explicit nativeStrings:true also coerces null/bool without unbound globals", async () => {
    const r = await compile(SRC, { nativeStrings: true } as Parameters<typeof compile>[1]);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.strBool!()).toBe(EXPECTED.strBool);
    expect(ex.strNull!()).toBe(EXPECTED.strNull);
    expect(ex.boolToString!()).toBe(EXPECTED.boolToString);
  });
});
