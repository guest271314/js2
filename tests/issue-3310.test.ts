// #3310 — G2: the standalone open-`$Object` dynamic method-call bridge
// (`__apply_closure`) previously hard-capped its arity dispatch at 4, silently
// dropping a 5+-arg call (`o.m(a,b,c,d,e)`) to the undefined sentinel (→ 0 in a
// numeric context). The `__call_fn_method_N` dispatchers are emitted up to
// arity 8, so the bridge dispatch is lifted to match. This asserts a dynamic
// method call through the generic open-object lane receives its arguments for
// arities 2 (control, already worked), 5, 6, 7, and 8 under `--target standalone`,
// host-free (0 function imports).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, entry: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error("compile failed: " + (r.errors ?? []).map((e) => e.message).join("; "));
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const fn = (instance.exports as Record<string, unknown>)[entry];
  if (typeof fn !== "function") throw new Error(`export ${entry} is not a function`);
  return (fn as () => unknown)();
}

const SRC = `
const o: any = {};
o.add2 = (a: number, b: number) => a + b;
o.add5 = (a: number, b: number, c: number, d: number, e: number) => a + b + c + d + e;
o.add6 = (a: number, b: number, c: number, d: number, e: number, f: number) => a + b + c + d + e + f;
o.add7 = (a: number, b: number, c: number, d: number, e: number, f: number, g: number) =>
  a + b + c + d + e + f + g;
o.add8 = (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) =>
  a + b + c + d + e + f + g + h;
export function two(): number { const g: any = o; return g.add2(10, 20) as number; }
export function five(): number { const g: any = o; return g.add5(1, 2, 3, 4, 5) as number; }
export function six(): number { const g: any = o; return g.add6(1, 2, 3, 4, 5, 6) as number; }
export function seven(): number { const g: any = o; return g.add7(1, 2, 3, 4, 5, 6, 7) as number; }
export function eight(): number { const g: any = o; return g.add8(1, 2, 3, 4, 5, 6, 7, 8) as number; }
`;

describe("#3310 — standalone dynamic method-call arity lift (>4 args through __apply_closure)", () => {
  it("arity 2 (control) still dispatches", async () => {
    expect(await runStandalone(SRC, "two")).toBe(30);
  });

  it("arity 5 dispatches (was the undefined-sentinel bug)", async () => {
    expect(await runStandalone(SRC, "five")).toBe(15);
  });

  it("arity 6 dispatches", async () => {
    expect(await runStandalone(SRC, "six")).toBe(21);
  });

  it("arity 7 dispatches", async () => {
    expect(await runStandalone(SRC, "seven")).toBe(28);
  });

  it("arity 8 dispatches (the emission cap)", async () => {
    expect(await runStandalone(SRC, "eight")).toBe(36);
  });

  it("standalone binary has zero function imports", async () => {
    const r = await compile(SRC, { fileName: "test.ts", target: "standalone" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const mod = await WebAssembly.compile(r.binary);
    const funcImports = WebAssembly.Module.imports(mod).filter((i) => i.kind === "function");
    expect(funcImports).toEqual([]);
  });
});
