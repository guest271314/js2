import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers";
import { compile } from "../src/index.js";

/**
 * #2724 — Object-literal get/set accessor representation.
 *
 * An object literal containing a `get x()` / `set x(v)` accessor whose inferred
 * type flows through a context that resolves to a WasmGC struct (e.g. a function
 * return type) used to mis-register the accessor as a plain DATA field. The
 * literal is built as an externref `$Object` (carrying real accessor
 * descriptors) but the *type* it flowed through was a closed struct, so the two
 * representations collided:
 *   - gc/host: the externref `$Object` doesn't match the struct → reads back null
 *   - standalone: the externref→struct `ref.cast` traps ("illegal cast")
 *
 * Fix: `ensureStructForType` skips closed-struct registration for object-LITERAL
 * accessor-bearing types that ALSO carry a non-accessor (data/method) own
 * property (declaration parent is an ObjectLiteralExpression), so they lower to
 * externref end to end and the existing `$Object` accessor read path services
 * them. CLASS accessors (parent = ClassDeclaration) keep the struct +
 * getter-method representation.
 *
 * This is the root cause of #1642's residual `iterator-close-*-get-method-*`
 * edges: the for-of iterator factory `{ next, get return() }` (MIXED: a `next`
 * method + a `get return()` accessor) registered a closed struct, so
 * `__iterator(iterable)` read back null and threw upstream of IteratorClose.
 *
 * NARROWING (merge_group floor fix): the guard fires only for MIXED literals
 * (≥1 accessor AND ≥1 non-accessor property). A getter-ONLY literal like
 * `{ get v() {} }` is, on main, used predominantly as an object-REST/spread
 * source (`{...x} = { get v() {} }`, RegExpExec's `{ get 0() {} }`), whose copy
 * paths require the source to be a registered struct; externref-lowering it broke
 * CopyDataProperties. Getter-only literals therefore stay on the struct path; the
 * getter-only return/member-read case is deferred to the #2580 externref-rest
 * substrate work. Every #1642 iterator is mixed (an iterator always has `next`),
 * so the acceptance edges are fully covered.
 */
describe("#2724 object-literal accessor representation (gc/host)", () => {
  it("(a) MIXED accessor literal returned from a function — getter fires on read", async () => {
    const src = `
let sideEffect = 0;
function makeObj() {
  return { tag: 7, get x() { sideEffect++; return 42; } };
}
export function test(): number {
  const o = makeObj();
  const a = o.x; // fires getter -> 42, sideEffect = 1
  const b = o.x; // fires getter -> 42, sideEffect = 2
  return a + b + sideEffect + o.tag; // 42 + 42 + 2 + 7 = 93
}`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(93);
  });

  it("(b) for-of IteratorClose with get return() throwing → throw propagates", async () => {
    const src = `
let iterationCount = 0;
function run(): number {
  const iterable: any = {};
  iterable[Symbol.iterator] = function () {
    return {
      next() { return { done: false, value: null }; },
      get return() { throw new Error("close"); }
    };
  };
  let threw = 0;
  try {
    for (const x of iterable) { iterationCount++; break; }
  } catch (e) { threw = 1; }
  return threw * 100 + iterationCount; // want 101
}
export function test(): number { return run(); }`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(101);
  });

  it("(b2) for-of IteratorClose runs get return() exactly once on break", async () => {
    const src = `
let returnCalled = 0;
function run(): number {
  const iterable: any = {};
  iterable[Symbol.iterator] = function () {
    let i = 0;
    return {
      next() { return { value: i++, done: i > 5 }; },
      get return() { returnCalled++; return function () { return { value: undefined, done: true }; }; },
    };
  };
  for (const x of iterable) { break; }
  return returnCalled; // want 1
}
export function test(): number { return run(); }`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(1);
  });

  it("(b3) IteratorClose get return() returns null → no throw, body ran once", async () => {
    const src = `
let iterationCount = 0;
function run(): number {
  const iterable: any = {};
  iterable[Symbol.iterator] = function () {
    return {
      next() { return { done: false, value: null }; },
      get return() { return null; }
    };
  };
  for (const x of iterable) { iterationCount++; break; }
  return iterationCount; // want 1
}
export function test(): number { return run(); }`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(1);
  });

  it("(b4) throw completion + get return() also throws → ORIGINAL throw wins", async () => {
    const src = `
function run(): number {
  const iterable: any = {};
  iterable[Symbol.iterator] = function () {
    return {
      next() { return { done: false, value: null }; },
      get return() { throw new TypeError("getter"); }
    };
  };
  let which = 0;
  try {
    for (const x of iterable) { throw new Error("BODY"); }
  } catch (e: any) {
    which = (e && e.message === "BODY") ? 1 : 2;
  }
  return which; // want 1 (original body throw)
}
export function test(): number { return run(); }`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(1);
  });

  it("(c) mixed data + accessor literal returned from a function", async () => {
    const src = `
let n = 0;
function make() {
  return { a: 7, get b() { n++; return 5; } };
}
export function test(): number {
  const o = make();
  return o.a + o.b + n; // 7 + 5 + 1 = 13
}`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(13);
  });

  it("(c2) MIXED setter literal returned from a function routes to externref", async () => {
    const src = `
let stored = 0;
function make() {
  return { tag: 3, set s(v: number) { stored = v; } };
}
export function test(): number {
  const o = make();
  o.s = 9;
  return stored + o.tag; // 9 + 3 = 12
}`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(12);
  });

  it("(c3) getter-ONLY literal as an object-REST source — getter fires once (narrowing regression guard)", async () => {
    // A getter-only literal is kept on the struct path so the object-rest copy
    // (struct→externref→__extern_rest_object) invokes the getter exactly once.
    // Lowering it to externref (the un-narrowed guard) broke this (#2724 floor).
    const src = `
let count = 0;
function run(): number {
  let x: any;
  let threw = 0;
  try {
    ({ ...x } = { get v() { count++; throw new Error("T"); } });
  } catch (e) { threw = 1; }
  return threw * 100 + count; // getter invoked once during rest, then throws -> 101
}
export function test(): number { return run(); }`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(101);
  });

  it("(d) CLASS getter control — struct + getter-method representation preserved", async () => {
    const src = `
class C { get v(): number { return 14; } }
export function test(): number {
  const c = new C();
  return c.v;
}`;
    const exp = await compileToWasm(src);
    expect((exp.test as Function)()).toBe(14);
  });
});

describe("#2724 object-literal accessor representation (standalone)", () => {
  async function run(src: string): Promise<number> {
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors?.map((e) => e.message).join("; ")).toBe(true);
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports.test as Function)() as number;
  }

  it("MIXED accessor literal returned from a function — getter fires (no illegal cast)", async () => {
    const v = await run(`
let sideEffect = 0;
function makeObj() {
  return { tag: 7, get x() { sideEffect++; return 42; } };
}
export function test(): number {
  const o = makeObj();
  const a = o.x;
  const b = o.x;
  return a + b + sideEffect + o.tag; // 42 + 42 + 2 + 7 = 93
}`);
    expect(v).toBe(93);
  });

  it("mixed data + accessor returned from a function", async () => {
    const v = await run(`
let n = 0;
function make() {
  return { a: 7, get b() { n++; return 5; } };
}
export function test(): number {
  const o = make();
  return o.a + o.b + n; // 13
}`);
    expect(v).toBe(13);
  });

  it("CLASS getter control — works standalone", async () => {
    const v = await run(`
class C { get v(): number { return 14; } }
export function test(): number { const c = new C(); return c.v; }`);
    expect(v).toBe(14);
  });
});
