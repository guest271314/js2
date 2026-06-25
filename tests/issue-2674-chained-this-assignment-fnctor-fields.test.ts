// #2674 — a function-constructor (fnctor) whose body uses CHAINED `this`
// assignments (`this.a = this.b = this.c = expr`) must register a struct field
// for EVERY chained target, not just the outermost LHS.
//
// Root cause: `compileNewFunctionDeclaration`'s `collectThisAssignments`
// (new-super.ts) matched only a statement-level `this.<field> = <value>` and
// treated the RHS as an opaque value — so for `this.start = this.end = this.pos`
// it recorded `start` but dropped `end` (the inner `this.end = this.pos` was the
// "value"). acorn's Parser ctor leans on chained assignments heavily
// (`this.start = this.end = this.pos`, `this.startLoc = this.endLoc = …`,
// `this.lastTokStart = this.lastTokEnd = …`, `this.yieldPos = this.awaitPos =
// this.awaitIdentPos = 0`), so `$__fnctor_Parser` ended up MISSING end/endLoc/
// lastTokEnd/lastTokStartLoc/awaitPos/awaitIdentPos. The parser then READ those
// absent fields (`base.end`, `this.lastTokEnd`) → fell through to the
// `__extern_get` sidecar → `undefined` → expression-parse loops never terminated
// (a contributor to the acorn 9th dogfood wall).
//
// Fix: `collectAssignmentChain` walks the full `=` chain, recording every
// `this.<field>` LHS. This is a GENERAL fnctor/ctor correctness fix (any chained
// this-assignment), not acorn-specific.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<{ exp: any; wat: string }> {
  const r: any = await compile(src, { fileName: "probe.ts" });
  expect(r.success).toBe(true);
  const io: any = r.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports);
  return { exp: wrapExports(instance.exports, { signatures: r.exportSignatures }), wat: r.wat as string };
}

describe("#2674 — chained `this` assignment fnctor field collection", () => {
  it("`this.a = this.b = this.c = 5` registers ALL three fields and reads them back", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P() { this.a = this.b = this.c = 5; this.x = this.y = 0; };
      var pp = P.prototype;
      pp.sum = function () { return this.a + this.b + this.c + this.x + this.y; };
      export function probe() { var p = new P(); return p.sum(); }
    `);
    // a+b+c+x+y = 5+5+5+0+0 = 15 (pre-fix dropped b/c/y → wrong sum / undefined reads)
    expect(exp.probe()).toBe(15);
  });

  it("the chained inner targets are real struct fields (not sidecar-only)", async () => {
    const { wat } = await run(`
      // @ts-nocheck
      var P = function P() { this.start = this.end = 7; };
      var pp = P.prototype;
      pp.readEnd = function () { return this.end; };
      export function probe() { var p = new P(); return p.readEnd(); }
    `);
    // Both `start` and `end` must appear as fields on the $__fnctor_P struct.
    expect(/\$__fnctor_P\b/.test(wat)).toBe(true);
    expect(/field \$start\b/.test(wat)).toBe(true);
    expect(/field \$end\b/.test(wat)).toBe(true);
  });

  it("the inner chained target reads back the assigned value (not undefined)", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P() { this.start = this.end = 7; };
      var pp = P.prototype;
      pp.readEnd = function () { return this.end; };
      export function probe() { var p = new P(); return p.readEnd(); }
    `);
    expect(exp.probe()).toBe(7);
  });

  it("acorn-faithful 3-deep chain + null/number mix", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P() {
        this.lastTokEndLoc = this.lastTokStartLoc = null;
        this.yieldPos = this.awaitPos = this.awaitIdentPos = 0;
        this.n = 0;
      };
      var pp = P.prototype;
      pp.go = function () {
        // read every chained inner target — must NOT be undefined
        if (this.lastTokStartLoc === null) this.n = this.n + 1;
        if (this.awaitPos === 0) this.n = this.n + 1;
        if (this.awaitIdentPos === 0) this.n = this.n + 1;
        return this.n;
      };
      export function probe() { var p = new P(); return p.go(); }
    `);
    expect(exp.probe()).toBe(3);
  });
});
