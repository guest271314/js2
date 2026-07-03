// #3010 — Standalone regression: a destructuring parameter whose argument is a
// single-element array literal holding `undefined` (`f([undefined])` with param
// `[x = 23]`) threw `TypeError: Cannot destructure 'null' or 'undefined'` at
// RUNTIME. This regressed 55 test262 `class/dstr/*meth-ary-ptrn-elem-id-init-*`
// files (all runtime `type_error`, compiles fine).
//
// Root cause: #2979 made the shared native `__extern_is_undefined` sentinel-aware
// (it reports `true` for a `$BoxedNumber` carrying the UNDEF_F64 sentinel — correct
// for VALUE sites like `g.next().value === undefined` and element-default checks).
// But a single-element array literal `[undefined]` passed as an argument is
// scalarized at the call site to exactly that boxed sentinel, and the destructure
// OUTER null-guard (`emitExternrefDestructureGuard`) also called
// `__extern_is_undefined` — so it misread the array CONTAINER as `undefined` and
// threw. Fix: in standalone/wasi the container guard relies on `ref.is_null` alone
// (the canonical standalone undefined); the sentinel-aware call is host-mode only
// there. Element-level default checks keep the sentinel awareness (separate call
// sites), so #2979 and `[a = 9] = [undefined]` still work.
//
// Host lanes are byte-identical (the guard's sentinel-aware arm is gated on
// `!ctx.standalone && !ctx.wasi`, i.e. the original code path unchanged).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const envImports = r.imports.filter((i) => i.module === "env");
  expect(envImports, `unexpected env imports: ${envImports.map((i) => i.name).join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3010 standalone dstr-param undefined-element does not throw", () => {
  // The core regression shape (test262 `meth-ary-ptrn-elem-id-init-undef`):
  // element is `undefined` → the element default (23) applies; NO container throw.
  it("function param [x = 23] called with [undefined] applies the default", async () => {
    const src = `export function test(): number {
      let cc = 0;
      function m([x = 23]: any): void { if (x === 23) cc = cc + 1; }
      m([undefined]);
      return cc;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  // The exact test262 cluster shape: class method with the same param pattern.
  it("class method([x = 23]) called with [undefined] applies the default", async () => {
    const src = `export function test(): number {
      let cc = 0;
      class C { method([x = 23]: any): void { if (x === 23) cc = cc + 1; } }
      new C().method([undefined]);
      return cc;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  // A multi-element array literal with a leading undefined already worked — keep it green.
  it("param [x = 23, y] called with [undefined, 5] applies default to x, binds y", async () => {
    const src = `export function test(): number {
      let ok = 0;
      function m([x = 23, y]: any): void { if (x === 23 && y === 5) ok = 1; }
      m([undefined, 5]);
      return ok;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  // A genuine null container MUST still throw TypeError (spec: destructuring
  // null/undefined). The `ref.is_null` arm of the guard preserves this.
  it("destructuring a null argument still throws TypeError", async () => {
    const src = `export function test(): number {
      function m([x = 23]: any): void { void x; }
      try { m(null as any); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
    }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
