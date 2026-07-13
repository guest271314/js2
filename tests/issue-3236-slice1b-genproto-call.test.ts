// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3236 Slice 1b — `Function.prototype.call`/`.apply` on a dynamically-read
 * %GeneratorPrototype% member closure.
 *
 * Slice 1 installed `%GeneratorPrototype%`'s own `next`/`return`/`throw` as
 * brand-checked native-method closure VALUES (real `$Object` data properties)
 * and wired the DIRECT-call path: `GeneratorPrototype.next()` throws a catchable
 * TypeError (GeneratorValidate §27.5.1.2, whose Slice-1 stand-in is an
 * unconditional catchable-TypeError refusal body).
 *
 * The remaining test262 `this-val-not-{object,generator}` cases invoke the
 * member via `GeneratorPrototype.next.call(undefined)`. There the receiver
 * `GeneratorPrototype.next` is a DYNAMIC `$Object` data-property read (the
 * closure value) on an `any`-typed object, so the symbol-based reflective
 * `.call` recovery misses and `.call` degraded to reading `next.call` →
 * `undefined` (no invocation → no throw). Slice 1b resolves the (brand, member)
 * from the receiver's syntactic GeneratorPrototype provenance and routes the
 * value-call through the shared reflective closure-call emitter (threading
 * `thisArg → this`), so the brand-check fires and the spec TypeError is thrown.
 *
 * Standalone-gated; every case compiles host-free (zero imports).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compHostFree(src: string) {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true } as any);
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.map((e) => e.message).join("; ")}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

const PRELUDE = `
function* g() {}
var GeneratorPrototype = Object.getPrototypeOf(g).prototype;
var symbol = Symbol();
`;

describe("#3236 Slice 1b — GeneratorPrototype.<m>.call/apply throws TypeError host-free", () => {
  it("this-val-not-object: every non-object this throws a catchable TypeError", async () => {
    // Mirrors built-ins/GeneratorPrototype/next/this-val-not-object.js.
    const ex = await compHostFree(`${PRELUDE}
function throws1(): boolean {
  try { GeneratorPrototype.next.call(undefined); return false; } catch (e) { return e instanceof TypeError; }
}
function throws2(): boolean {
  try { GeneratorPrototype.next.call(undefined, 1); return false; } catch (e) { return e instanceof TypeError; }
}
export function allThrow(): number {
  var vals: any[] = [undefined, null, true, 's', 1, symbol];
  for (var i = 0; i < vals.length; i++) {
    try { GeneratorPrototype.next.call(vals[i]); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
    try { GeneratorPrototype.next.call(vals[i], 1); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  }
  return throws1() && throws2() ? 1 : 0;
}
`);
    expect(ex.allThrow()).toBe(1);
  });

  it("this-val-not-generator: ordinary/function/generator-fn this throws TypeError", async () => {
    // Mirrors built-ins/GeneratorPrototype/next/this-val-not-generator.js.
    const ex = await compHostFree(`${PRELUDE}
export function allThrow(): number {
  try { GeneratorPrototype.next.call({}); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  try { GeneratorPrototype.next.call({}, 1); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  try { GeneratorPrototype.next.call(function() {}); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  try { GeneratorPrototype.next.call(g); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  try { GeneratorPrototype.next.call(g.prototype); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  return 1;
}
`);
    expect(ex.allThrow()).toBe(1);
  });

  it("return / throw members flip the same way, incl. .apply", async () => {
    const ex = await compHostFree(`${PRELUDE}
export function allThrow(): number {
  try { GeneratorPrototype.return.call(undefined); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  try { GeneratorPrototype.throw.call({}); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  try { GeneratorPrototype.next.apply(undefined); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  try { GeneratorPrototype.next.apply(undefined, [1]); return 0; } catch (e) { if (!(e instanceof TypeError)) return 0; }
  return 1;
}
`);
    expect(ex.allThrow()).toBe(1);
  });

  it("Slice-1 direct-call + value-read semantics are unregressed", async () => {
    const ex = await compHostFree(`${PRELUDE}
export function directThrows(): number {
  try { GeneratorPrototype.next(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 0; }
}
export function isFn(): number { return typeof GeneratorPrototype.next === 'function' ? 1 : 0; }
export function descOK(): number {
  var d = Object.getOwnPropertyDescriptor(GeneratorPrototype, 'next');
  return (d && d.writable === true && d.enumerable === false && d.configurable === true) ? 1 : 0;
}
`);
    expect(ex.directThrows()).toBe(1);
    expect(ex.isFn()).toBe(1);
    expect(ex.descOK()).toBe(1);
  });

  it("unrelated borrowed-method idiom (hasOwnProperty.call) is unaffected", async () => {
    // The reflective refusal-body fall-through path emitReflectiveNativeProtoClosureCall
    // relies on for Object.prototype.hasOwnProperty.call must stay intact — Slice 1b's
    // refusalBodyFallback is strictly opt-in and must not leak to this caller.
    const ex = await compHostFree(`
export function hop(): number {
  var o: any = { a: 1 };
  return Object.prototype.hasOwnProperty.call(o, 'a') ? 1 : 0;
}
`);
    expect(ex.hop()).toBe(1);
  });
});
