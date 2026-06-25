// #2659 — in-Wasm member WRITE on an `any`/`externref` fnctor receiver must
// land on the SAME storage the member READ uses.
//
// Root cause: the member-READ fast path resolves an `any`/`externref` receiver
// that is actually a typed WasmGC struct via `struct.get <slot>`
// (`findAlternateStructsForField` in property-access.ts). The member-WRITE path
// historically emitted only `__extern_set`, which `_safeSet` routes to a JS-side
// SIDECAR — it cannot write the struct slot. So reads saw the slot, writes
// updated the sidecar, and a `this.pos += 1` loop never advanced
// (compiled-acorn `readWord1` looped forever; the 6th dogfood blocker).
//
// FIX: the externref/any member-WRITE paths (plain `=` and compound `+=`) now
// emit a SYMMETRIC `struct.set` dispatch (`emitAlternateStructSetDispatch`) that
// writes the slot when the receiver owns the field, mirroring the read; the
// `__extern_set` fallback still covers genuine host externrefs, accessors, and
// dynamic sidecar-only properties.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2659 — member write hits the struct slot the read uses", () => {
  // acorn-faithful: a fnctor whose prototype method mutates a ctor-initialized
  // numeric field in a `while` loop and reads it back (mirrors readWord1).
  it("fnctor prototype-method `this.pos += 1` loop terminates (read/write agree)", async () => {
    const exp = await run(`
      // @ts-nocheck
      var P = function P(input) { this.input = String(input); this.pos = 0; };
      var pp = P.prototype;
      pp.scan = function () {
        // The while-condition read of this.pos takes the struct.get fast path;
        // the this.pos += 1 write must land on the SAME slot, else this loops
        // forever (the #2659 bug).
        while (this.pos < this.input.length) { this.pos += 1; }
        return this.pos;
      };
      export function probe(s) { var p = new P(s); return p.scan(); }
    `);
    // "hello" has length 5 → terminates with pos === 5 (would hang pre-fix).
    expect(exp.probe("hello")).toBe(5);
  });

  it("plain `this.x = v` write is visible to the struct.get-fast-path read", async () => {
    const exp = await run(`
      // @ts-nocheck
      var P = function P() { this.pos = 0; this.n = 0; };
      var pp = P.prototype;
      pp.advance = function () {
        // Plain (non-compound) write, then a fast-path read of the same field.
        this.pos = 7;
        // Loop reads this.pos via the struct.get fast path; n counts iterations.
        while (this.pos > this.n) { this.n = this.n + 1; }
        return this.n;
      };
      export function probe() { var p = new P(); return p.advance(); }
    `);
    expect(exp.probe()).toBe(7);
  });

  it("own-property write on a boxed primitive wrapper compiles + round-trips via the sidecar", async () => {
    // Regression guard (#2659 merge_group): the symmetric struct.set write
    // dispatch must NOT pick an IMMUTABLE field slot. The boxed-primitive
    // wrappers WrapperString / WrapperNumber / WrapperBoolean expose a `value`
    // field declared `mutable: false`; routing `(new String("x")).value = ...`
    // to a `struct.set` on that slot is a hard Wasm validation error
    // ("struct.set field must be mutable") that flipped Object.create
    // 15.2.3.5-4-167/168/169 from pass→compile_error. The write must fall
    // through to the __extern_set sidecar, which the `.value` read also uses.
    const exp = await run(`
      // @ts-nocheck
      export function probe() {
        var str = new String("abc");
        str.value = "StrValue";
        var booleanObj = new Boolean(false);
        booleanObj.value = "BooleanValue";
        var numObj = new Number(123);
        numObj.value = "NumValue";
        return String(str.value) + "|" + String(booleanObj.value) + "|" + String(numObj.value);
      }
    `);
    expect(exp.probe()).toBe("StrValue|BooleanValue|NumValue");
  });

  it("dynamic (sidecar-only) property still works via the __extern_set fallback", async () => {
    // A property NOT in any struct shape must still round-trip through the
    // sidecar — the struct.set dispatch must defer to __extern_set for it.
    const exp = await run(`
      // @ts-nocheck
      export function probe() {
        var o = {};
        o.dyn = 1;
        o.dyn += 4;
        return o.dyn;
      }
    `);
    expect(exp.probe()).toBe(5);
  });
});
