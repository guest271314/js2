// (#3227 S2) JS-host lane: `await Promise.resolve(x)` yielded NaN synchronously.
// The static-resolution census (awaitIsStaticallyResolved, #1936) classifies
// `Promise.resolve(<static>)` as a no-suspension await, so the async fn skips
// the CPS/$AsyncFrame lanes and the await reaches the legacy passthrough in
// expressions.ts — which compiled the OPERAND (a host call returning the
// Promise OBJECT as externref), so a numeric consumer's externref→f64 coercion
// read NaN. Fix: substitute the settled value (resolve argument / undefined)
// via staticPromiseResolveSettledExpr. Root of the "await-NaN" cluster (~875
// honest fails exposed by the S1 post-drain verdict re-read).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface HostRun {
  test: () => unknown;
  getCount: () => number;
}

async function runHost(src: string): Promise<HostRun> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports ?? [], undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary!, imports as unknown as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  const ex = instance.exports as unknown as HostRun;
  return ex;
}

const drain = () => new Promise((res) => setTimeout(res, 10));

describe("#3227 S2 — await Promise.resolve(x) delivers the settled value (JS-host)", () => {
  it("async function declaration: await Promise.resolve(7)", async () => {
    const ex = await runHost(`
let count: number = 0;
export function getCount(): number { return count; }
async function f(): Promise<void> {
  const v = await Promise.resolve(7);
  count = count + v;
}
export function test(): number { f(); return 0; }
`);
    ex.test();
    await drain();
    expect(ex.getCount()).toBe(7); // was NaN
  });

  it("async function expression + arrow: store awaited value", async () => {
    for (const fn of [
      "const g = async function () { const v = await Promise.resolve(7); count = v; };",
      "const g = async () => { const v = await Promise.resolve(7); count = v; };",
    ]) {
      const ex = await runHost(`
let count: number = 0;
export function getCount(): number { return count; }
export function test(): number { ${fn} g(); return 0; }
`);
      ex.test();
      await drain();
      expect(ex.getCount()).toBe(7); // was NaN
    }
  });

  it("two sequential static awaits", async () => {
    const ex = await runHost(`
let count: number = 0;
export function getCount(): number { return count; }
export function test(): number {
  const g = async function () {
    const a = await Promise.resolve(3);
    const b = await Promise.resolve(4);
    count = a * 10 + b;
  };
  g();
  return 0;
}
`);
    ex.test();
    await drain();
    expect(ex.getCount()).toBe(34); // was NaN
  });

  it("await Promise.resolve() settles to undefined; nested resolve unwraps", async () => {
    const ex = await runHost(`
let count: number = 0;
export function getCount(): number { return count; }
export function test(): number {
  const g = async function () {
    const u: any = await Promise.resolve();
    const v = await Promise.resolve(Promise.resolve(5));
    count = (u === undefined ? 100 : 0) + v;
  };
  g();
  return 0;
}
`);
    ex.test();
    await drain();
    expect(ex.getCount()).toBe(105);
  });

  it("await over literal stays correct (control)", async () => {
    const ex = await runHost(`
let count: number = 0;
export function getCount(): number { return count; }
export function test(): number {
  const g = async function () { const v = await 7; count = v; };
  g();
  return 0;
}
`);
    ex.test();
    await drain();
    expect(ex.getCount()).toBe(7);
  });

  it("genuinely-suspending awaits still deliver (guard: variable / then-chain / new Promise)", async () => {
    for (const body of [
      "const p = Promise.resolve(7); const v = await p; count = v;",
      "const v = await Promise.resolve(1).then((w: number) => w + 6); count = v;",
      "const v = await new Promise<number>((resolve) => { resolve(7); }); count = v;",
    ]) {
      const ex = await runHost(`
let count: number = 0;
export function getCount(): number { return count; }
export function test(): number {
  const g = async function () { ${body} };
  g();
  return 0;
}
`);
      ex.test();
      await drain();
      expect(ex.getCount()).toBe(7);
    }
  });
});
