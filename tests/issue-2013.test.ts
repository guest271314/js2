// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2013 — `JSON.parse(text, reviver)` §25.5.1.
 *
 * The host-import `JSON.parse` arm in `calls.ts` previously compiled only
 * `arguments[0]` (the text) and the `env::JSON_parse` import was `(s) =>
 * JSON.parse(s)`, dropping the reviver entirely — so the callback's
 * transforms and side effects were lost.
 *
 * The fix forwards the reviver (arg 2) to a 2-param `JSON_parse` import which
 * applies §25.5.1.1 InternalizeJSONProperty: each own property (array indices
 * in order, then object keys in source order) is recursed, the reviver is
 * called with `(key, value)` on its holder, and the return value substitutes
 * (or, when `undefined`, deletes) the property. The reviver may be a JS
 * function or a WasmGC closure (bridged via `__call_fn_2`).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

async function run(src: string): Promise<unknown> {
  const r = await compileToWasm(src);
  return (r as { test: () => unknown }).test();
}

describe("#2013 JSON.parse reviver", () => {
  it("reviver transforms numeric leaves (the headline repro)", async () => {
    expect(
      await run(
        `export function test(): string { const r: any = JSON.parse('{"a":1,"b":2}', (k: string, v: any) => (typeof v === "number" ? v * 10 : v)); return JSON.stringify(r); }`,
      ),
    ).toBe('{"a":10,"b":20}');
  });

  it("returning undefined deletes the property (§25.5.1.1 step 2.c.iii)", async () => {
    expect(
      await run(
        `export function test(): string { const r: any = JSON.parse('{"a":1,"b":2}', (k: string, v: any) => (k === "b" ? undefined : v)); return JSON.stringify(r); }`,
      ),
    ).toBe('{"a":1}');
  });

  it("recurses into nested objects and array indices in order", async () => {
    expect(
      await run(
        `export function test(): string { const r: any = JSON.parse('{"x":[1,2],"y":3}', (k: string, v: any) => (typeof v === "number" ? v + 1 : v)); return JSON.stringify(r); }`,
      ),
    ).toBe('{"x":[2,3],"y":4}');
  });

  it("the root value is visited under the empty-string key", async () => {
    expect(
      await run(
        `export function test(): number { let rootKey = "X"; JSON.parse('5', (k: string, v: any) => { if (typeof v === "number") rootKey = k; return v; }); return rootKey === "" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("no-reviver call is unchanged (object property access)", async () => {
    expect(await run(`export function test(): number { const o: any = JSON.parse('{"a":7}'); return o.a; }`)).toBe(7);
  });

  it("no-reviver call is unchanged (round-trip)", async () => {
    expect(
      await run(`export function test(): string { const r: any = JSON.parse('{"a":1}'); return JSON.stringify(r); }`),
    ).toBe('{"a":1}');
  });

  it("reviver runs leaves before their parent (bottom-up)", async () => {
    // The reviver sees children before the containing object: at the time the
    // parent key is visited, its children already carry the transformed values.
    expect(
      await run(
        `export function test(): string { const r: any = JSON.parse('{"o":{"n":2}}', (k: string, v: any) => (typeof v === "number" ? v * 5 : v)); return JSON.stringify(r); }`,
      ),
    ).toBe('{"o":{"n":10}}');
  });
});
