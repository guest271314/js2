// #3143 — IR-first default flip: gate 8 (TypedArray-view element store).
//
// The IR front-end's `from-ast.ts` `lowerElementStore` throws a clean
// post-claim fallback ("element store on a TypedArray view not in IR scope")
// for TypedArray-view receivers — the per-view value conversions (ToUint8 /
// clamp / packing) and the typed backing store are legacy-only. The selector's
// #2856-C2 element-store arm accepts the shape STRUCTURALLY (checker-free), so
// under the IR-first default a claimed function with such a store would promote
// the demote to a HARD compile error as a skipped slot. Gate 8
// (`irFirstBodyStoresTypedArrayView`) keeps those functions compile-twice.
//
// This test locks two properties:
//   1. The syntactic predicate fires on the real class-4 shapes (typed param
//      receiver, `new Uint8Array(n)` local, compound / prefix stores) and does
//      NOT fire on plain-array / string / non-view element stores.
//   2. End-to-end: a program with a TypedArray-view element store compiles with
//      ZERO hard errors under the IR-first default and runs correctly (parity
//      with the escape-hatch legacy order).
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  irFirstBodyCallsUnloweredArrayMethod,
  irFirstBodyMutatesParam,
  irFirstBodyStoresTypedArrayView,
} from "../src/codegen/ir-first-gate.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function fnDecl(src: string): ts.FunctionDeclaration {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("no function declaration in source");
  return fn;
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return instance.exports as Record<string, Function>;
}

describe("#3143 gate 8 — irFirstBodyStoresTypedArrayView predicate (store OR construct)", () => {
  it.each([
    ["typed param receiver, plain store", `function f(out: Uint8Array, i: number){ out[i] = 65; }`],
    ["typed param receiver, computed index", `function f(out: Uint8Array, p: number, i: number){ out[p + i] = 10; }`],
    [
      "new-Uint8Array local receiver + store",
      `function f(n: number){ const b = new Uint8Array(n); b[0] = 1; return b; }`,
    ],
    ["Int32Array param compound store", `function f(a: Int32Array, i: number){ a[i] += 3; }`],
    ["Float64Array param prefix incr", `function f(a: Float64Array, i: number){ ++a[i]; }`],
    ["Uint8ClampedArray param postfix", `function f(a: Uint8ClampedArray, i: number){ a[i]--; }`],
    ["new-Float32Array local, shl store", `function f(){ const v = new Float32Array(4); v[1] <<= 1; return v; }`],
    // (b) construction alone — even with only a READ afterward — is unlowered.
    ["new-Uint8Array + read only (no store)", `function f(n: number){ const b = new Uint8Array(n); return b.length; }`],
    ["new-Uint8Array returned only", `function f(n: number): Uint8Array { return new Uint8Array(n); }`],
    ["new-Int16Array as argument", `function f(){ return new Int16Array(8)[0]; }`],
  ])("fires (keep compile-twice): %s", (_label, src) => {
    expect(irFirstBodyStoresTypedArrayView(fnDecl(src))).toBe(true);
  });

  it.each([
    // plain arrays are lowerable (vec-elem-set) — must NOT fire.
    ["number[] param store", `function f(a: number[], i: number){ a[i] = 1; }`],
    ["untyped array local store", `function f(){ const a = [0,0,0]; a[0] = 1; return a; }`],
    // TypedArray READ on a param (no construction, no store) lowers — must NOT fire.
    ["typed param element READ only", `function f(a: Uint8Array, i: number){ return a[i]; }`],
    ["typed param length READ only", `function f(a: Uint8Array){ return a.length; }`],
    // string element store is a different gate / receiver.
    ["object string-literal key store", `function f(o){ o["k"] = 1; }`],
    // non-view construction is not this gate's concern.
    ["new Array construction", `function f(){ const a = new Array(4); a[0] = 1; return a; }`],
  ])("does not fire: %s", (_label, src) => {
    expect(irFirstBodyStoresTypedArrayView(fnDecl(src))).toBe(false);
  });
});

describe("#3143 gate 9 — irFirstBodyMutatesParam predicate", () => {
  it.each([
    ["param decrement in do-while", `function f(n: number){ let c=0; do { c++; n--; } while (n>0); return c; }`],
    ["param increment in for", `function f(n: number){ for (let i=0;i<3;i++){ n++; } return n; }`],
    ["param plain assignment", `function f(n: number){ n = 5; return n; }`],
    ["param compound assignment", `function f(n: number){ n += 2; return n; }`],
    ["param prefix decrement", `function f(n: number){ while (n>0){ --n; } return n; }`],
  ])("fires (keep compile-twice): %s", (_label, src) => {
    expect(irFirstBodyMutatesParam(fnDecl(src))).toBe(true);
  });

  it.each([
    ["local mutation only (param read)", `function f(n: number){ let m=n; while(m>0){ m--; } return m; }`],
    ["param read, no write", `function f(n: number){ return n + 1; }`],
    ["no params", `function f(){ let x=0; x++; return x; }`],
    [
      "nested-fn shadows param name",
      `function f(n: number){ const g = (n: number) => { let k=n; k--; return k; }; return g(n); }`,
    ],
  ])("does not fire: %s", (_label, src) => {
    expect(irFirstBodyMutatesParam(fnDecl(src))).toBe(false);
  });
});

describe("#3143 gate 10 — irFirstBodyCallsUnloweredArrayMethod predicate", () => {
  it.each([
    ["array-literal local .indexOf", `function f(){ const a=[10,20,30]; return a.indexOf(20); }`],
    ["array-literal local .includes", `function f(){ const a=[1,2,3]; return a.includes(2)?1:0; }`],
    ["array-literal local .flat", `function f(){ const a=[[1],[2]]; return a.flat()[0]; }`],
    ["T[] param .lastIndexOf", `function f(a: number[]){ return a.lastIndexOf(5); }`],
    ["Array<T> param .join", `function f(a: Array<number>){ return a.join(","); }`],
    ["new Array local .slice", `function f(){ const a=new Array(3); return a.slice(1); }`],
  ])("fires (keep compile-twice): %s", (_label, src) => {
    expect(irFirstBodyCallsUnloweredArrayMethod(fnDecl(src))).toBe(true);
  });

  it.each([
    // `.push` IS lowered by from-ast — must NOT fire.
    ["array .push", `function f(a: number[], v: number){ a.push(v); }`],
    // element read / .length (not a call) — not gated.
    ["array element read", `function f(a: number[], i: number){ return a[i]; }`],
    ["array .length", `function f(a: number[]){ return a.length; }`],
    // method call on a non-array receiver (class instance) — different gate/receiver.
    ["method call on non-array local", `function f(o: { m(): number }){ return o.m(); }`],
  ])("does not fire: %s", (_label, src) => {
    expect(irFirstBodyCallsUnloweredArrayMethod(fnDecl(src))).toBe(false);
  });
});

describe("#3143 gate 8 — end-to-end IR-first default (no hard error, correct bytes)", () => {
  // The native-messaging class-4 shape, reduced: a typed-param writer whose
  // element store stays legacy (gate 8a) plus a caller that constructs a view
  // (gate 8b). Both must compile cleanly under the IR-first default.
  const SRC = `
    function fill(out: Uint8Array, base: number): void {
      for (let i = 0; i < 4; i++) { out[i] = base + i; }
    }
    export function run(): number {
      const buf = new Uint8Array(4);
      fill(buf, 10);
      return buf[0] + buf[1] + buf[2] + buf[3]; // 10+11+12+13 = 46
    }
  `;

  it("compiles with ZERO hard errors under IR-first default", async () => {
    const r = await compile(SRC, { fileName: "nm.ts", experimentalIR: true });
    const hard = (r.errors ?? []).filter((e) => e.severity === "error");
    expect(hard.map((e) => e.message)).toEqual([]);
    expect(r.binary.length).toBeGreaterThan(0);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("runs correctly under the IR-first default", async () => {
    const r = await compile(SRC, { fileName: "nm.ts", experimentalIR: true });
    const exports = await instantiate(r);
    expect((exports.run as () => number)()).toBe(46);
  });

  it("parity: escape-hatch legacy order (JS2WASM_IR_FIRST=0) gives the same result", async () => {
    const prev = process.env.JS2WASM_IR_FIRST;
    process.env.JS2WASM_IR_FIRST = "0";
    try {
      const r = await compile(SRC, { fileName: "nm.ts", experimentalIR: true });
      const hard = (r.errors ?? []).filter((e) => e.severity === "error");
      expect(hard.map((e) => e.message)).toEqual([]);
      const exports = await instantiate(r);
      expect((exports.run as () => number)()).toBe(46);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
      else process.env.JS2WASM_IR_FIRST = prev;
    }
  });
});

describe("#3143 — __box_number / __extern_is_undefined union-import pre-registration", () => {
  // fibMemo: a memoized recursion over a module-level Map. Its IR body emits a
  // __box_number funcref (boxing f64→externref for the Map) and __extern_is_undefined
  // (`hit !== undefined`), both of which legacy used to register as a side effect.
  // Under IR-first that side effect is gone; preregisterDynamicSupport must
  // register them. Regression guard for the funcIdx-shift fix (a stale shift
  // desynced a sibling IR function's funcIdx — "out of local range").
  const SRC = `
    const memo = new Map<number, number>();
    function fibMemo(n: number): number {
      if (n < 2) return n;
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      const v = fibMemo(n - 1) + fibMemo(n - 2);
      memo.set(n, v);
      return v;
    }
    function fibIter(n: number): number {
      let a = 0, b = 1;
      for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; }
      return a;
    }
    export function run(): number { return fibMemo(10) + fibIter(10); } // 55 + 55 = 110
  `;

  it("compiles with ZERO hard errors and a VALID binary under IR-first default", async () => {
    const r = await compile(SRC, { fileName: "fib.ts", experimentalIR: true });
    const hard = (r.errors ?? []).filter((e) => e.severity === "error");
    expect(hard.map((e) => e.message)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("runs correctly under the IR-first default", async () => {
    const r = await compile(SRC, { fileName: "fib.ts", experimentalIR: true });
    const exports = await instantiate(r);
    expect((exports.run as () => number)()).toBe(110);
  });
});
