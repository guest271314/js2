// #3389 Slice 2a — `.return(v)` / `.throw(e)` consumer methods on DRIVEN
// async-generator carriers (§27.6.3.8/.9), standalone lane.
//
// For every body the driven lane admits, try/finally + catch ACROSS a yield
// stay legacy (2b), so a suspended-at-yield `.return`/`.throw` runs NO further
// body — it just COMPLETES the frame. The per-gen `__async_gen_return_<stem>` /
// `__async_gen_throw_<stem>` drivers settle/reject a fresh result promise and
// re-point `frame.STATE` at the gen's settleDone state (subsequent `.next()` →
// `{value: undefined, done: true}`), without touching the shared resume
// dispatch. Host-free: no `__gen_return`/`__gen_throw` host imports.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Ex {
  test: () => number;
  probe: () => number;
  __drain_microtasks?: () => void;
}

async function drive(code: string): Promise<number> {
  const r = await compile(code, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`).filter((n) => n.startsWith("env."))).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as unknown as Ex;
  ex.test();
  ex.__drain_microtasks?.();
  return ex.probe();
}

describe("#3389 Slice 2a — driven async-gen .return()/.throw() (standalone, host-free)", () => {
  it(".return(42) on a suspended-at-yield gen → {42,true}, then next → done", async () => {
    const v = await drive(`
      var rv = -9, rd = -9, nd = -9;
      export function test(): number {
        async function* g(): AsyncGenerator<number, number, unknown> { yield 1; yield 2; return 0; }
        const it = g();
        it.next().then((_: any) => {
          it.return(42).then((r: any) => {
            rv = r.value as number; rd = r.done ? 1 : 0;
            it.next().then((n: any) => { nd = n.done ? 1 : 0; });
          });
        });
        return 0;
      }
      export function probe(): number { return rv * 100 + rd * 10 + nd; }
    `);
    // rv=42 rd=1 nd=1 → 4211
    expect(v).toBe(4211);
  });

  it(".throw(e) on a suspended gen rejects the returned promise", async () => {
    const v = await drive(`
      var caught = -9;
      export function test(): number {
        async function* g(): AsyncGenerator<number, number, unknown> { yield 1; yield 2; return 0; }
        const it = g();
        it.next().then((_: any) => {
          it.throw(new Error("boom")).then((_r: any) => { caught = 1; }, (_e: any) => { caught = 2; });
        });
        return 0;
      }
      export function probe(): number { return caught; }
    `);
    expect(v).toBe(2); // rejected
  });

  it(".return() bare on a fresh (never-nexted) gen → done, frame completed", async () => {
    const v = await drive(`
      var rd = -9, nd = -9;
      export function test(): number {
        async function* g(): AsyncGenerator<number, void, unknown> { yield 1; }
        const it = g();
        it.return().then((r: any) => {
          rd = r.done ? 1 : 0;
          it.next().then((n: any) => { nd = n.done ? 1 : 0; });
        });
        return 0;
      }
      export function probe(): number { return rd * 10 + nd; }
    `);
    // .return() done=true; frame completed → subsequent next done=true → 11
    expect(v).toBe(11);
  });

  it(".return(v) completes the frame: a later .return gives {v2,true} too", async () => {
    const v = await drive(`
      var r1d = -9, r2v = -9, r2d = -9;
      export function test(): number {
        async function* g(): AsyncGenerator<number, number, unknown> { yield 1; yield 2; return 0; }
        const it = g();
        it.return(5).then((r1: any) => {
          r1d = r1.done ? 1 : 0;
          it.return(9).then((r2: any) => { r2v = r2.value as number; r2d = r2.done ? 1 : 0; });
        });
        return 0;
      }
      export function probe(): number { return r1d * 1000 + r2v * 10 + r2d; }
    `);
    // r1: {5,true} → r1d=1 ; r2 on completed frame: {9,true} → r2v=9 r2d=1 → 1000 + 90 + 1 = 1091
    expect(v).toBe(1091);
  });

  it("no-regression: a plain driven gen without .return/.throw still drives host-free", async () => {
    const v = await drive(`
      var val = -9;
      export function test(): number {
        async function* g(): AsyncGenerator<number, void, unknown> { yield 8; }
        g().next().then((r: any) => { val = r.value as number; });
        return 0;
      }
      export function probe(): number { return val; }
    `);
    expect(v).toBe(8);
  });
});
