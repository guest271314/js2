// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1721 — `class Sub extends Object {}` / `class Sub extends Function {}` must
 * satisfy `new Sub() instanceof Sub` (and the parent / Object chain), per
 * §10.2.1 / §20.1.2 / §20.2.2.
 *
 * Residual of #1455, which registered Map / TypedArray / WeakMap / DataView /
 * WeakRef (and the wrapper types + Date) as host-constructible subclassable
 * parents but missed the two roots `Object` and `Function`. Without them:
 *   - `Object` / `Function` were absent from
 *     `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`, so `class Sub extends Object {}`
 *     produced a plain WasmGC struct, never externref-backed, and
 *     `instanceof Sub` returned false.
 *   - `Object` / `Function` were absent from the runtime `builtinCtors` map,
 *     so the `extern_class new` resolver threw "No dependency provided".
 *   - The static `instanceof` evaluator had no `Function -> Object` edge, so a
 *     subclass of Function reported `instanceof Object === false`.
 *
 * Fix (all in builtin-tags.ts + runtime.ts):
 *   - Added `Object`, `Function` to `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`.
 *   - Added `Object`, `Function` to the runtime `builtinCtors` map.
 *   - Added the `Function -> Object` edge to `BUILTIN_PARENT` so a subclass of
 *     Function is statically an instance of Object too.
 */
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const exports = await compileAndInstantiate(src);
  return ((exports as any).test as () => number)();
}

describe("#1721 — subclass of Object / Function instanceof", () => {
  it("class extends Object — instanceof Sub and Object both pass", async () => {
    const src = `
class Subclass extends Object {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Object ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("class extends Function — instanceof Sub, Function, Object all pass", async () => {
    const src = `
class Subclass extends Function {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Function ? 1 : 0;
  const c: number = sub instanceof Object ? 1 : 0;
  return (a << 2) | (b << 1) | c;
}`;
    expect(await run(src)).toBe(7);
  });

  it("class expression extends Object — instanceof checks pass", async () => {
    const src = `
const Subclass = class extends Object {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Object ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("subclass of Object carries its own instance method", async () => {
    const src = `
class Subclass extends Object {
  mine(): number { return 7; }
}
const sub = new Subclass();
export function test(): number {
  return sub instanceof Subclass && sub.mine() === 7 ? 1 : 0;
}`;
    expect(await run(src)).toBe(1);
  });
});
