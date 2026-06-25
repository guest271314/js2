// #2656 — `++this.prop` / `this.prop--` on an `any`/`externref` fnctor receiver
// must perform the read-modify-write (and hit the SAME struct slot the read
// uses), instead of silently dropping the write.
//
// Root cause: `compileMemberIncDec` (src/codegen/expressions/unary-updates.ts)
// only handled a statically-resolved struct receiver; for an `any`/`externref`
// receiver (a fnctor-instance `this` inside a prototype method — acorn's
// tokenizer shape) it emitted a `f64.const NaN` graceful fallback and SILENTLY
// DROPPED THE WRITE. So `++this.pos` was a no-op and acorn's
// `skipSpace`/`readWord1` `while (this.pos < len) { ++this.pos }` loops never
// advanced → infinite loop (the 7th dogfood blocker; compiled acorn `parse()`
// hung). `this.prop = this.prop + 1` and `this.prop += 1` already worked because
// the compound-assignment path (assignment.ts Path B + #2659 symmetric
// struct.set dispatch) does the read-modify-write; `++`/`--` simply never got
// the same externref arm.
//
// FIX: the externref/any-receiver arm of `compileMemberIncDec` now mirrors the
// `+=` write-back: read via `__extern_get`, unbox→f64, ±1, box, write via the
// SYMMETRIC `emitAlternateStructSetDispatch` (#2659) with `__extern_set` sidecar
// as the terminal fallback. Prefix returns NEW, postfix returns OLD (§13.4).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string, fileName = "probe.mjs"): Promise<any> {
  const result: any = await compile(src, { fileName });
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2656 — ++/-- on an any-typed fnctor member writes the slot (no NaN-drop)", () => {
  // The headline acorn case: a fnctor prototype method whose `while` loop
  // advances a ctor-initialized field via `++this.pos` (acorn skipSpace shape).
  // Pre-fix this looped forever (write dropped → condition never advances).
  it("fnctor prototype-method `++this.pos` loop terminates (acorn skipSpace shape)", async () => {
    const exp = await run(`
      // @ts-nocheck
      var Scanner = function Scanner(input) { this.input = String(input); this.pos = 0; };
      var sp = Scanner.prototype;
      sp.skipSpace = function () {
        while (this.pos < this.input.length) { ++this.pos; }
        return this.pos;
      };
      export function probe(s) { var sc = new Scanner(s); return sc.skipSpace(); }
    `);
    expect(exp.probe("hello")).toBe(5); // would hang pre-fix
  });

  it("prefix `++this.pos` returns the NEW value and persists the write", async () => {
    const exp = await run(`
      // @ts-nocheck
      var P = function P() { this.pos = 0; };
      var pp = P.prototype;
      pp.go = function () {
        var r = ++this.pos;   // r === 1 (new), this.pos === 1
        return r * 10 + this.pos;
      };
      export function probe() { return new P().go(); }
    `);
    expect(exp.probe()).toBe(11);
  });

  it("postfix `this.pos++` returns the OLD value and persists the write", async () => {
    const exp = await run(`
      // @ts-nocheck
      var P = function P() { this.pos = 5; };
      var pp = P.prototype;
      pp.go = function () {
        var r = this.pos++;   // r === 5 (old), this.pos === 6
        return r * 10 + this.pos;
      };
      export function probe() { return new P().go(); }
    `);
    expect(exp.probe()).toBe(56);
  });

  it("prefix `--this.pos` returns the NEW value; postfix `this.pos--` returns OLD", async () => {
    const exp = await run(`
      // @ts-nocheck
      var P = function P() { this.a = 3; this.b = 3; };
      var pp = P.prototype;
      pp.go = function () {
        var pre = --this.a;    // pre === 2, this.a === 2
        var post = this.b--;   // post === 3, this.b === 2
        return pre * 1000 + this.a * 100 + post * 10 + this.b;
      };
      export function probe() { return new P().go(); }
    `);
    // pre=2, this.a=2, post=3, this.b=2 -> 2*1000 + 2*100 + 3*10 + 2 = 2232
    expect(exp.probe()).toBe(2232);
  });

  it("repeated `++this.pos` accumulates (write read back each time)", async () => {
    const exp = await run(`
      // @ts-nocheck
      var P = function P() { this.pos = 0; };
      var pp = P.prototype;
      pp.go = function () { ++this.pos; ++this.pos; ++this.pos; return this.pos; };
      export function probe() { return new P().go(); }
    `);
    expect(exp.probe()).toBe(3);
  });

  // Control: the statically-resolved class-struct fast path must still work
  // (do not disturb the path that already emitted struct.get/struct.set).
  it("class field `++this.pos` (statically-typed receiver) still works", async () => {
    const exp = await run(
      `
      class C { pos: number = 0; bump(): number { ++this.pos; return this.pos; } }
      export function probe(): number { return new C().bump(); }
    `,
      "probe.ts",
    );
    expect(exp.probe()).toBe(1);
  });

  // Note: the __extern_set sidecar fallback for a dynamic (non-struct-shape)
  // property is the SAME terminal arm the `+=` path uses, already covered by
  // tests/issue-2659-member-write-struct-slot.test.ts ("dynamic (sidecar-only)
  // property still works via the __extern_set fallback"). We don't duplicate it
  // here — a bare-object `++o.n` case is sensitive to in-process $Object proto
  // state across tests in one file (memory
  // reference_test262_inprocess_objproto_pollution) and passes only in isolation.
});
