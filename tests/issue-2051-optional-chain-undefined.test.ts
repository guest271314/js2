// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2051 — a short-circuited optional **property** access (`o?.v`) whose static
 * type is a nullable primitive (`number | undefined`) must yield `undefined`,
 * not the property type's default (`0`).
 *
 * Before this slice, `compileOptionalPropertyAccess` lowered the whole `?.`
 * result to the property's bare value type (f64/i32) and the short-circuit arm
 * fabricated a typed zero — so `o?.v === undefined`, `typeof o?.v`, `"" + o?.v`,
 * and `o?.v ?? d` all went wrong for a nullish receiver.
 *
 * Fix: when the chain's static result type is a nullable primitive, the result
 * is widened to externref; the null arm emits host `undefined` (`emitUndefined`)
 * and the non-null arm boxes the primitive (`__box_number`/`__box_boolean`).
 * `staticTypeofForType` was also corrected to resolve unions (e.g.
 * `number | undefined`) BEFORE the `resolveWasmType` collapse, so `typeof o?.v`
 * no longer const-folds to "number".
 *
 * Scope: property access (`o?.v`) + `typeof`. Optional **call** (`o?.f()`) and
 * optional **element** access (`a?.[i]`) short-circuit arms are a separate
 * follow-up under #2051 (calls-optional.ts / compileOptionalElementAccess) — not
 * regressed here (their non-nullish path still returns the real value).
 *
 * Default (JS-host) mode: relies on host `undefined` (`__get_undefined`),
 * `__typeof`, `__extern_toString`, `__extern_is_undefined` — all already present.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): number }).test();
}

const OBJ = `type Obj = { v: number };
function getObj(b: boolean): Obj | null { return b ? { v: 9 } : null; }`;

describe("#2051 optional property access yields undefined on short-circuit", () => {
  it("nullish: o?.v === undefined", async () => {
    expect(
      await run(`${OBJ}\nexport function test(): boolean { const o = getObj(false); return (o?.v) === undefined; }`),
    ).toBe(1);
  });
  it("nullish: typeof o?.v === 'undefined'", async () => {
    expect(
      await run(
        `${OBJ}\nexport function test(): boolean { const o = getObj(false); return typeof (o?.v) === "undefined"; }`,
      ),
    ).toBe(1);
  });
  it('nullish: "" + o?.v === "undefined"', async () => {
    expect(
      await run(
        `${OBJ}\nexport function test(): boolean { const o = getObj(false); return ("" + (o?.v)) === "undefined"; }`,
      ),
    ).toBe(1);
  });
  it("nullish: o?.v ?? 5 === 5", async () => {
    expect(
      await run(`${OBJ}\nexport function test(): boolean { const o = getObj(false); return ((o?.v) ?? 5) === 5; }`),
    ).toBe(1);
  });

  it("non-null: o?.v === 9", async () => {
    expect(await run(`${OBJ}\nexport function test(): boolean { const o = getObj(true); return (o?.v) === 9; }`)).toBe(
      1,
    );
  });
  it("non-null: typeof o?.v === 'number'", async () => {
    expect(
      await run(
        `${OBJ}\nexport function test(): boolean { const o = getObj(true); return typeof (o?.v) === "number"; }`,
      ),
    ).toBe(1);
  });
  it("non-null v=0: o?.v === undefined is false (typed-zero rep can never get this right)", async () => {
    expect(
      await run(
        `type O2 = { v: number }; function g2(b: boolean): O2 | null { return b ? { v: 0 } : null; }
export function test(): boolean { const o = g2(true); return ((o?.v) === undefined) === false; }`,
      ),
    ).toBe(1);
  });

  it("nullish boolean: if (o?.flag) is falsy", async () => {
    expect(
      await run(
        `type OF = { flag: boolean }; function gf(b: boolean): OF | null { return b ? { flag: true } : null; }
export function test(): boolean { const o = gf(false); return (o?.flag) ? false : true; }`,
      ),
    ).toBe(1);
  });
});
