// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2993 — generator-closure lowering: a BigInt (`i64`) yield was written into
 * the eager-buffer generator's generic `__gen_push_ref(externref, externref)`
 * slot WITHOUT the i64→externref box, so the module failed WasmGC validation
 * ("call[1] expected type externref, found local.get of type i64") in the
 * generator closure body (e.g. `__closure_0` / `__closure_3`) → a
 * `compile_error` that never reached instantiation.
 *
 * Root cause: `compileYieldExpression` (src/codegen/expressions/misc.ts)
 * dispatched `f64 → __gen_push_f64`, `i32 → __gen_push_i32`, and *everything
 * else* → `__gen_push_ref`, assuming the value was already reference-shaped.
 * A `yield <bigint>` lowers to a raw `i64`, which fell into that `else` arm
 * unboxed. The fix routes `i64` through `coerceType(i64 → externref)`, which
 * boxes a bigint-branded i64 via `__box_bigint` (round-trips as a JS bigint)
 * and a native `type i64 = number` via `__box_number`.
 *
 * Note: the simple direct `for (const v of g())` bigint case already used the
 * #2864 native carrier and compiled fine — only the eager-buffer shapes
 * (`.next().value`, closure/HOF-threaded generators) hit this bug.
 *
 * Bars asserted:
 *   1. The closure/HOF-threaded BigInt-yield repro compiles to VALID Wasm on
 *      the standalone lane — `WebAssembly.compile` (full module validation)
 *      succeeds, i.e. no `__closure_N` invalid-wasm CE. (Genuine standalone
 *      *value* round-trip of a boxed bigint through the eager buffer is a
 *      separate standalone value-read substrate concern — out of scope here.)
 *   2. In JS-host (gc) mode the boxed value round-trips correctly, proving the
 *      coercion is semantically right, not just type-valid.
 *   3. The non-BigInt (number) generator siblings are unaffected.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** The #2993 repro shape: a BigInt generator threaded through a higher-order closure. */
const CLOSURE_HOF_BIGINT = `
function run(cb) {
  var obj = (function *() { yield 7n; yield 42n; })();
  return cb(obj);
}
export function test() {
  return run(function(g) {
    let sum = 0n;
    for (const v of g) { sum += v; }
    return Number(sum);
  });
}`;

/** The minimal eager-buffer trigger: a BigInt yield read via `.next().value`. */
const NEXT_VALUE_BIGINT = `
export function test() {
  function* g(){ yield 7n; }
  let it = g();
  return Number(it.next().value);
}`;

describe("#2993 BigInt generator-closure i64→externref carrier", () => {
  it("standalone: closure/HOF-threaded BigInt generator compiles to VALID Wasm (no __closure_N invalid-wasm CE)", async () => {
    const r = await compile(CLOSURE_HOF_BIGINT, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    // WebAssembly.compile performs full module validation, including the
    // function-body type check that previously rejected the raw i64 in the
    // externref `__gen_push_ref` slot. Pre-fix this threw; post-fix it resolves.
    await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  it("standalone: `.next().value` BigInt generator compiles to VALID Wasm", async () => {
    const r = await compile(NEXT_VALUE_BIGINT, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  it("gc: closure/HOF-threaded BigInt generator compiles to VALID Wasm (no CE)", async () => {
    // The repro shape validates in gc mode too. NOTE: the *value* does not yet
    // round-trip through the boxed-`any` generator + closure/HOF indirection
    // (`test()` returns null, not 49) — that is a separate value-threading gap,
    // NOT the carrier-mismatch CE this issue fixes. The bar here is validation.
    const r = await compile(CLOSURE_HOF_BIGINT, { fileName: "test.ts", target: "gc" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  it("gc: boxed BigInt value round-trips through `.next().value` (7) — proves the box is semantically correct", async () => {
    const r = await compile(NEXT_VALUE_BIGINT, { fileName: "test.ts", target: "gc" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    (r.importObject as { __setExports?: (e: unknown) => void })?.__setExports?.(instance.exports);
    expect((instance.exports as { test(): number }).test()).toBe(7);
  });

  it("no regression: number-yield generator siblings still work (gc 49, standalone 49)", async () => {
    const numberSrc = `
export function test() {
  function* g(){ yield 7; yield 42; }
  let sum = 0;
  for (const v of g()) sum += v;
  return sum;
}`;
    for (const target of ["gc", "standalone"] as const) {
      const r = await compile(numberSrc, { fileName: "test.ts", target });
      expect(r.success, r.success ? "" : `compile error [${target}]: ${r.errors?.[0]?.message}`).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
      (r.importObject as { __setExports?: (e: unknown) => void })?.__setExports?.(instance.exports);
      expect((instance.exports as { test(): number }).test(), `number generator [${target}]`).toBe(49);
    }
  });
});
