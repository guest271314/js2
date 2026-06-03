// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1665 — Wasm-native generator `for-of` in standalone / WASI mode.
 *
 * Before this slice, `function* g() { yield … } for (const x of g()) …` under
 * `--target wasi` hit the `#681` codegen gate and failed to compile, because
 * the for-of lowering only knew the JS-host iterator protocol
 * (`env.__iterator` / `env.__iterator_next`). The Wasm-native generator state
 * machine (`generators-native.ts`, #680) already lowered `function*`
 * declarations and `.next()` calls in standalone mode, but the for-of consumer
 * was never wired to drive it.
 *
 * This test asserts:
 *   1. The compiled module emits ZERO `__gen_*` / `__create_generator*` /
 *      `__iterator*` host imports (genuine standalone — instantiates with an
 *      empty import object).
 *   2. `for (const x of gen()) s += x` produces the correct sum.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_GEN_ITER_RE = /^(__gen_|__create_generator|__create_async_generator|__iterator)/;

async function compileStandalone(src: string): Promise<{ binary: Uint8Array; imports: string[] }> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_GEN_ITER_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  return { binary: r.binary, imports };
}

describe("#1665 standalone Wasm-native generator for-of", () => {
  it("for-of over a generator sums yields with no host iterator imports", async () => {
    const src = `function* gen() { yield 1; yield 2; }
export function test(): number { let s = 0; for (const x of gen()) s += x; return s; }`;
    const { binary, imports } = await compileStandalone(src);
    expect(imports, "no __gen_*/__create_generator*/__iterator* host import in standalone").toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary, {});
    const exports = instance.exports as { test(): number };
    expect(exports.test()).toBe(3);
  });

  it("for-of over a generator with three yields and a running product", async () => {
    const src = `function* gen() { yield 2; yield 3; yield 4; }
export function test(): number { let p = 1; for (const x of gen()) p *= x; return p; }`;
    const { binary, imports } = await compileStandalone(src);
    expect(imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary, {});
    const exports = instance.exports as { test(): number };
    expect(exports.test()).toBe(24);
  });

  it("break inside a generator for-of exits early", async () => {
    const src = `function* gen() { yield 1; yield 2; yield 3; }
export function test(): number {
  let s = 0;
  for (const x of gen()) { if (x === 3) break; s += x; }
  return s;
}`;
    const { binary, imports } = await compileStandalone(src);
    expect(imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary, {});
    const exports = instance.exports as { test(): number };
    expect(exports.test()).toBe(3); // 1 + 2, breaks before adding 3
  });
});
