// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3177 slice 1 — standalone TypedArray integer-indexed MOP arms + ctor identity.
//
// Three mechanisms:
//  1. `$__ta_ctor` per-kind SINGLETON globals — every mention of the same ctor
//     name is the SAME struct ref (was: struct.new per site → ref.eq identity
//     broken at the root), plus the `<TA>.prototype.constructor` static arm.
//  2. `$__ta_dyn_view` §10.4.5 MOP arms (src/codegen/ta-dyn-mop.ts) prepended
//     at finalize into the standalone dynamic-object natives: canonical-
//     numeric-key interception (§7.1.21 round-trip + "-0"), IsValidIntegerIndex
//     element semantics for get/set/has/delete, named intrinsic props
//     (length/byteLength/byteOffset/BYTES_PER_ELEMENT/buffer/constructor),
//     and OwnPropertyKeys index enumeration.
//  3. Inline dyn-view OOB element read returns the `undefined` SINGLETON (was
//     ref.null.extern → compared as null).
//
// The dynamic-ctor shape (`const TA: any = Uint8Array; new TA(...)`) is the
// shape every `testWithTypedArrayConstructors` harness closure produces — the
// arms target exactly that corpus (built-ins/TypedArrayConstructors/internals).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const src = `export function test(): number {
  const TA: any = Uint8Array;
  const s: any = new TA([42, 43]);
  ${body}
}`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#3177 — ctor identity (singleton $__ta_ctor)", () => {
  it("two mentions of the same ctor are ref-equal: Uint8Array === Uint8Array", async () => {
    expect(await run(`const a: any = Uint8Array; const b: any = Uint8Array; return a === b ? 1 : 0;`)).toBe(1);
  });

  it("distinct ctors stay distinct: Uint8Array !== Int8Array", async () => {
    expect(await run(`const a: any = Uint8Array; const b: any = Int8Array; return a !== b ? 1 : 0;`)).toBe(1);
  });

  it("static arm: Uint16Array.prototype.constructor === Uint16Array", async () => {
    expect(await run(`return Uint16Array.prototype.constructor === Uint16Array ? 1 : 0;`)).toBe(1);
  });

  it("cross-check stays false: Uint16Array.prototype.constructor !== Uint8Array", async () => {
    expect(await run(`return (Uint16Array.prototype.constructor as any) === (Uint8Array as any) ? 0 : 1;`)).toBe(1);
  });

  it("runtime arm: instance.constructor === TA through the dyn-view [[Get]]", async () => {
    expect(await run(`return s.constructor === TA ? 1 : 0;`)).toBe(1);
  });
});

describe("#3177 — dyn-view integer-indexed MOP arms (§10.4.5)", () => {
  it("[[Get]] canonical string key reads the element: Reflect.get(s, '0') === 42", async () => {
    expect(await run(`const v: any = Reflect.get(s, "0"); return v === 42 ? 1 : 0;`)).toBe(1);
  });

  it("[[Get]] canonical-but-not-integer key is undefined, never ordinary lookup: s['1.1']", async () => {
    expect(await run(`const v: any = s["1.1"]; return v === undefined ? 1 : 0;`)).toBe(1);
  });

  it("[[HasProperty]]: '0' → true, '5' (OOB) → false, '-0' → false, 'foo' → false, 'length' → true", async () => {
    expect(
      await run(
        `return (Reflect.has(s, "0") && !Reflect.has(s, "5") && !Reflect.has(s, "-0") && !Reflect.has(s, "foo") && Reflect.has(s, "length")) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("[[Set]] canonical key writes through; Reflect.set reports true", async () => {
    expect(await run(`const ok = Reflect.set(s, "0", 9); const v: any = s[0]; return (ok && v === 9) ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("[[Set]] OOB is a silent no-op and the read stays undefined", async () => {
    expect(await run(`s[5] = 7; const v: any = s[5]; return v === undefined ? 1 : 0;`)).toBe(1);
  });

  it("[[Delete]]: valid index → false; OOB index → true", async () => {
    expect(
      await run(`const a: any = delete s[0]; const b: any = delete s[9]; return (a === false && b === true) ? 1 : 0;`),
    ).toBe(1);
  });

  it("OwnPropertyKeys: Object.keys(s) enumerates ascending index strings", async () => {
    expect(
      await run(`const k = Object.keys(s); return (k.length === 2 && k[0] === "0" && k[1] === "1") ? 1 : 0;`),
    ).toBe(1);
  });

  it("named props through the dynamic reader: length/byteLength/byteOffset/BYTES_PER_ELEMENT", async () => {
    expect(
      await run(
        `const a: any = Reflect.get(s, "length"); const b: any = Reflect.get(s, "byteLength"); const c: any = Reflect.get(s, "byteOffset"); const d: any = Reflect.get(s, "BYTES_PER_ELEMENT"); return (a === 2 && b === 2 && c === 0 && d === 1) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it(".buffer returns the SAME backing buffer (identity) for a buffer-backed view", async () => {
    expect(
      await run(
        `const buf: any = new ArrayBuffer(4); const t: any = new TA(buf); const b: any = t.buffer; return b === buf ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("detach ($DETACHBUFFER model: __detached__=true) → element reads undefined, has false", async () => {
    expect(
      await run(
        `const b: any = s.buffer; (b as any).__detached__ = true; const v: any = s[0]; return (v === undefined && !Reflect.has(s, "0")) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("inline OOB element read is the undefined SINGLETON, not null", async () => {
    expect(await run(`const v: any = s[7]; return (v === undefined && !(v === null)) ? 1 : 0;`)).toBe(1);
  });
});

describe("#3177 — non-view receivers keep their behavior (arms fall through)", () => {
  it("plain any-typed array element/length are unchanged", async () => {
    // NOTE: `Object.keys(<any-typed plain array>)` returns [] on main (the
    // #3183 vec-awareness landed only in `__object_keys_forin`, not
    // `__object_keys`) — pre-existing, out of scope here; this guard asserts
    // the dyn-view arm did not CHANGE non-view behavior, so it checks only
    // what worked before.
    const src = `export function test(): number {
  const a: any = [10, 20, 30];
  const v: any = a[1];
  const l: any = a.length;
  return (v === 20 && l === 3) ? 1 : 0;
}`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("plain object get/has/delete are unchanged", async () => {
    const src = `export function test(): number {
  const o: any = { x: 1 };
  const h = Reflect.has(o, "x");
  const g: any = Reflect.get(o, "x");
  const d: any = delete o.x;
  return (h && g === 1 && d === true && !Reflect.has(o, "x")) ? 1 : 0;
}`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("byte-inert: a module with no TA construct compiles identically-valid and works", async () => {
    const src = `export function test(): number { const o: any = { a: 1, b: 2 }; return Object.keys(o).length === 2 ? 1 : 0; }`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });
});
