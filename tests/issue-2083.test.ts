import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2083 — the host-glue vec export suite (__vec_len / __vec_get / __is_vec /
// __vec_mut_supported / __vec_push / __vec_pop) leaked into EVERY compiled
// module, even arith-/string-only programs with no arrays. Root cause:
// `createCodegenContext` pre-registers the `externref` + `f64` vec struct
// types for type-index stability, so the gate's `vecTypeMap.size === 0`
// disjunct could never be true. Because the helpers are module EXPORTS, they
// are GC roots that wasm-opt cannot DCE — so they (and the ref.test/ref.cast
// dispatch bodies they pin) dominated small-binary size.
//
// Fix: gate the vec exports on `ctx.usesVecValue`, set only when a genuine
// array-usage site asks `getOrRegisterVecType` for a type (the two
// pre-registrations are excluded via `suppressVecUsageFlag`). The host runtime
// guards every `exports.__vec_*` access with a `typeof === "function"` check,
// so the helpers' absence is safe for modules that never materialise an array.

const VEC_EXPORTS = ["__vec_len", "__vec_get", "__is_vec", "__vec_mut_supported", "__vec_push", "__vec_pop"];

async function exportNames(src: string, target?: "gc" | "standalone"): Promise<string[]> {
  const r = await compile(src, target ? ({ fileName: "t.ts", target } as any) : ({ fileName: "t.ts" } as any));
  if (!r.success) throw new Error("Compile failed: " + (r.errors?.[0]?.message ?? "unknown"));
  const mod = new WebAssembly.Module(r.binary as Uint8Array);
  return WebAssembly.Module.exports(mod).map((e) => e.name);
}

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts" } as any);
  if (!r.success) throw new Error("Compile failed: " + (r.errors?.[0]?.message ?? "unknown"));
  const importObj = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary as Uint8Array, importObj as any);
  if (typeof (importObj as any).setExports === "function") {
    (importObj as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

describe("#2083 — host-glue vec exports gated on actual array usage", () => {
  it("arith-only program (no arrays) emits NONE of the vec exports (gc)", async () => {
    const names = await exportNames(
      `export function test(): number { let s = 0; for (let i = 0; i < 10; i++) s = s + i; return s; }`,
    );
    for (const e of VEC_EXPORTS) expect(names, `${e} should be absent`).not.toContain(e);
  });

  it("string-only program (no arrays) emits NONE of the vec exports (gc)", async () => {
    const names = await exportNames(`export function test(): string { return "hi" + "x"; }`);
    for (const e of VEC_EXPORTS) expect(names, `${e} should be absent`).not.toContain(e);
  });

  it("one-closure program with no arrays emits NONE of the vec exports (gc)", async () => {
    const names = await exportNames(
      `function mk(){let n=0; return function(){n=n+1; return n;};}
       const c = mk();
       export function test(): number { return c(); }`,
    );
    for (const e of VEC_EXPORTS) expect(names, `${e} should be absent`).not.toContain(e);
  });

  it("array-literal program KEEPS all vec exports (used internally)", async () => {
    const names = await exportNames(`export function test(): number { const a = [1, 2, 3]; return a[1]; }`);
    for (const e of VEC_EXPORTS) expect(names, `${e} should be present`).toContain(e);
  });

  it("array-returning program KEEPS all vec exports (crosses host boundary)", async () => {
    const names = await exportNames(`export function test(): number[] { return [1, 2, 3]; }`);
    for (const e of VEC_EXPORTS) expect(names, `${e} should be present`).toContain(e);
  });

  it("array-method program KEEPS all vec exports", async () => {
    const names = await exportNames(
      `export function test(): number { const a = [1, 2, 3]; return a.map((x: number) => x * 2)[0]; }`,
    );
    for (const e of VEC_EXPORTS) expect(names, `${e} should be present`).toContain(e);
  });

  // Behavioural invariant: stripping the exports from array-free modules must
  // not change what they compute, and array-using modules must still marshal
  // correctly through the host bridge.
  it("array-free module still runs correctly without the exports", async () => {
    expect(
      await run(`export function test(): number { let s = 0; for (let i = 0; i < 10; i++) s = s + i; return s; }`),
    ).toBe(45);
  });

  it("array-using module still marshals correctly with the exports", async () => {
    expect(
      await run(
        `export function test(): number { const a = [10, 20, 30]; let s = 0; for (const x of a) s = s + x; return s; }`,
      ),
    ).toBe(60);
  });
});
