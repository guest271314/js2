// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2866 (PR1: slices 1+2 + enumeration exclusion) — Wasm-native Symbol carrier
 * for the `$Object` property key channel, standalone.
 *
 * Before #2866 a Symbol used as an `$Object` key (`o[sym] = v`) leaked the
 * host-only `env::__box_symbol` import (then trapped `illegal cast` at the
 * `(ref $AnyString)` key path) — ~418 standalone-only failures. The fix:
 *   - a native `$Symbol {id, desc}` carrier + a host-free `__box_symbol(i32)`
 *     builder (`ensureSymbolCarrier`);
 *   - the `$Object` key channel (`$PropEntry.key`) widened to `anyref` so it
 *     holds either a native string OR a `$Symbol`, with id-identity equality;
 *   - string-key enumeration (Object.keys/getOwnPropertyNames/for-in/JSON)
 *     EXCLUDES symbol keys (§10.1.11.1).
 *
 * Every case must compile standalone with ZERO host imports and run correctly,
 * and the simple Symbol surface + string-key object ops must stay correct.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2866 native Symbol carrier — Symbol-keyed $Object ops (standalone)", () => {
  it("stores and reads back a symbol-keyed value host-free", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; return o[s]; }`,
      ),
    ).toBe(5);
  });

  it("overwrites an existing symbol key in place", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; o[s] = 9; return o[s]; }`,
      ),
    ).toBe(9);
  });

  it("preserves symbol identity (same symbol reads back the value)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 7; const s2 = s; return o[s2]; }`,
      ),
    ).toBe(7);
  });

  it("keeps distinct symbols as distinct keys", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Symbol(); const b = Symbol(); const o: any = {}; o[a] = 1; o[b] = 2; return (o[a] as number) * 10 + (o[b] as number); }`,
      ),
    ).toBe(12);
  });

  it("string and symbol keys coexist in one object", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o["x"] = 9; o[s] = 5; return (o["x"] as number) * 10 + (o[s] as number); }`,
      ),
    ).toBe(95);
  });

  it("`sym in o` is true after a symbol-keyed set", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; return (s in o) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("`delete o[sym]` removes the symbol key", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; delete o[s]; return (s in o) ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("a well-known symbol works as a key", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; o[Symbol.iterator] = 3; return o[Symbol.iterator]; }`,
      ),
    ).toBe(3);
  });

  it("Object.keys EXCLUDES symbol keys (§10.1.11.1)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o.a = 1; o.b = 2; o[s] = 5; return Object.keys(o).length; }`,
      ),
    ).toBe(2);
  });

  it("Object.getOwnPropertyNames EXCLUDES symbol keys", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o.a = 1; o[s] = 5; return Object.getOwnPropertyNames(o).length; }`,
      ),
    ).toBe(1);
  });

  it("the simple Symbol surface stays host-free and correct", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol("d"); return (typeof s === "symbol" && Symbol() !== Symbol() && Symbol.iterator === Symbol.iterator && s.description === "d") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("string-key object ops are unregressed (insert/grow/keys)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; for (let i = 0; i < 20; i++) { o["k" + i] = i; } let s = 0; for (let i = 0; i < 20; i++) { s += o["k" + i] as number; } return s + Object.keys(o).length; }`,
      ),
    ).toBe(210);
  });
});

describe("#2866 slice 3 — Object.getOwnPropertySymbols SELECT side (standalone)", () => {
  it("returns the object's own symbol keys (length)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; const s = Symbol("k"); o[s] = 42; return Object.getOwnPropertySymbols(o).length; }`,
      ),
    ).toBe(1);
  });

  it("returned symbol === the original (identity preserved, host-free)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; const s = Symbol("k"); o[s] = 7; const syms = Object.getOwnPropertySymbols(o); return (syms[0] === s) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("returned symbol re-indexes the same own property", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; const s = Symbol("k"); o[s] = 9; const syms = Object.getOwnPropertySymbols(o); return o[syms[0]] as number; }`,
      ),
    ).toBe(9);
  });

  it("preserves insertion order across multiple symbols", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; const a = Symbol("a"); const b = Symbol("b"); o[a] = 1; o[b] = 2; const syms = Object.getOwnPropertySymbols(o); return (syms.length === 2 && syms[0] === a && syms[1] === b) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("excludes string keys; getOwnPropertySymbols and keys are disjoint", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { x: 1 }; const s = Symbol("s"); o[s] = 9; return Object.getOwnPropertySymbols(o).length * 10 + Object.keys(o).length; }`,
      ),
    ).toBe(11);
  });

  it("returns an empty array for a symbol-free object", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { a: 1, b: 2 }; const s = Symbol("force-carrier"); const o2: any = {}; o2[s] = 1; return Object.getOwnPropertySymbols(o).length; }`,
      ),
    ).toBe(0);
  });

  it("symbol identity holds through an any-typed boundary (===)", async () => {
    expect(
      await runStandalone(
        `function eq(a: any, b: any): boolean { return a === b; } export function test(): number { const o: any = {}; const s = Symbol("k"); o[s] = 1; const syms = Object.getOwnPropertySymbols(o); return eq(syms[0], s) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});

describe("#2866 slice 4 — Symbol.toPrimitive string-hint dispatch (standalone)", () => {
  // Pre-slice-4: `+obj` already dispatched `[Symbol.toPrimitive]("number")`
  // host-free (#2891), but the STRING-hint coercion contexts — a template-literal
  // span `\`${o}\`` and `String(o)` — did NOT dispatch the well-known
  // `Symbol.toPrimitive` method: the template path's `tryStructToString` only
  // checked `toString`, and the `String()` path's `coerceType(ref→externref,
  // "string")` BOXED a numeric `@@toPrimitive` result instead of stringifying it
  // (a boxed-number externref then null-derefs on the next string op). Slice 4
  // wires `[Symbol.toPrimitive]("string")` into both, host-free.

  it("template literal dispatches @@toPrimitive with the 'string' hint", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { [Symbol.toPrimitive](hint: string): string { return hint === "string" ? "S" : "N"; } }; return \`\${o}\` === "S" ? 1 : -1; }`,
      ),
    ).toBe(1);
  });

  it("String(o) dispatches @@toPrimitive with the 'string' hint", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { [Symbol.toPrimitive](hint: string): string { return hint === "string" ? "S" : "N"; } }; return String(o) === "S" ? 1 : -1; }`,
      ),
    ).toBe(1);
  });

  it("a numeric @@toPrimitive('string') result is ToString'd, not boxed (template)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { [Symbol.toPrimitive](hint: string): number { return hint === "string" ? 2 : 1; } }; return \`\${o}\` === "2" ? 1 : -1; }`,
      ),
    ).toBe(1);
  });

  it("a numeric @@toPrimitive('string') result is ToString'd, not boxed (String + .length)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { [Symbol.toPrimitive](hint: string): number { return hint === "string" ? 2 : 1; } }; return String(o).length; }`,
      ),
    ).toBe(1);
  });

  it("the 'number' hint still wins for unary + (no string-path regression)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { [Symbol.toPrimitive](hint: string): number { return hint === "number" ? 42 : 0; } }; return +o; }`,
      ),
    ).toBe(42);
  });

  it("a class [Symbol.toPrimitive] dispatches in string context", async () => {
    expect(
      await runStandalone(
        `class C { [Symbol.toPrimitive](hint: string): string { return hint === "string" ? "CS" : "CN"; } } export function test(): number { const c = new C(); return \`\${c}\` === "CS" ? 1 : -1; }`,
      ),
    ).toBe(1);
  });

  it("toString-only objects are unregressed (no @@toPrimitive)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { toString(): string { return "TS"; } }; return (\`\${o}\` === "TS" && String(o) === "TS") ? 1 : -1; }`,
      ),
    ).toBe(1);
  });

  it("plain objects still stringify to [object Object]", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { a: 1 }; return \`\${o}\` === "[object Object]" ? 1 : -1; }`,
      ),
    ).toBe(1);
  });
});
