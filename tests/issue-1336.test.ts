/**
 * Issue #1336 — Object.assign for WasmGC struct sources with accessors / Symbol keys.
 *
 * Per §20.1.2.1 CopyDataProperties, Object.assign must INVOKE getters on the
 * source object (not return descriptors) and must enumerate own enumerable
 * keys including Symbol keys. The host-side `_wrapForHost` proxy used to back
 * WasmGC structs missed both: getter invocation for accessor properties and
 * Symbol keys defined via `_wasmStructAccessors`.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

describe("#1336 Object.assign accessor + symbol-key fidelity", () => {
  it("Object.assign copies Symbol-keyed accessor", async () => {
    const src = `
export function test(): number {
  const src: any = {};
  const k: any = Symbol("k");
  Object.defineProperty(src, k, {
    enumerable: true,
    get() {
      return 99;
    },
  });
  const target: any = Object.assign({}, src);
  return target[k] === 99 ? 1 : 0;
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(1);
  });

  it("Object.assign with plain data property (no regression)", async () => {
    const src = `
export function test(): number {
  const src: any = { a: 1, b: 2, c: 3 };
  const target: any = Object.assign({}, src);
  return (target.a as number) + (target.b as number) + (target.c as number);
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(6);
  });
});

// A computed Symbol-keyed object LITERAL (`{ [k]: v }`) previously dropped symbol
// identity: the #2126 runtime-computed-key write path compiled the key without
// an `externref` expected-type hint, so the symbol's i32 id was boxed as a
// NUMBER (`__box_number`) instead of a real JS Symbol (`__box_symbol`). The
// property landed under string key "<id>", so `o[k]`, getOwnPropertySymbols,
// Object.assign and spread all missed it. (`defineProperty`-form symbol keys,
// covered above, already worked.)
describe("#1336 Symbol-keyed object LITERAL fidelity", () => {
  it("reads back a symbol-keyed literal property", async () => {
    const r = await compileToWasm(
      `export function test(): number { const k = Symbol("k"); const s: any = { [k]: 7 }; return s[k] as number; }`,
    );
    expect((r as any).test()).toBe(7);
  });

  it("registers the literal key as a real Symbol, not a string", async () => {
    const r1 = await compileToWasm(
      `export function test(): number { const k = Symbol("k"); const s: any = { [k]: 7 }; return Object.getOwnPropertySymbols(s).length; }`,
    );
    expect((r1 as any).test()).toBe(1);
    const r2 = await compileToWasm(
      `export function test(): number { const k = Symbol("k"); const s: any = { [k]: 7 }; return Object.getOwnPropertyNames(s).length; }`,
    );
    expect((r2 as any).test()).toBe(0);
  });

  it("Object.assign copies a symbol-keyed literal property", async () => {
    const r = await compileToWasm(
      `export function test(): number { const k = Symbol("k"); const s: any = { [k]: 7 }; const t: any = {}; Object.assign(t, s); return t[k] as number; }`,
    );
    expect((r as any).test()).toBe(7);
  });

  it("object spread copies a symbol-keyed literal property", async () => {
    const r = await compileToWasm(
      `export function test(): number { const k = Symbol("k"); const s: any = { [k]: 7 }; const t: any = { ...s }; return t[k] as number; }`,
    );
    expect((r as any).test()).toBe(7);
  });

  it("mixed literal: string field and symbol key both survive", async () => {
    const r = await compileToWasm(
      `export function test(): number { const k = Symbol("k"); const s: any = { a: 1, [k]: 7 }; return (s.a as number) + Object.getOwnPropertySymbols(s).length; }`,
    );
    expect((r as any).test()).toBe(2);
  });

  it("CONTROL: numeric runtime computed key unchanged", async () => {
    const r = await compileToWasm(
      `export function test(): number { const s: any = { [1 + 1]: 7 }; return s[2] as number; }`,
    );
    expect((r as any).test()).toBe(7);
  });
});
