// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1896 defect-1 (typeof half) — standalone/WASI `__typeof_function` /
 * `__typeof_object` must recognise stored closure wrapper structs.
 *
 * Under `--target standalone` / `--target wasi` (native strings) a closure is
 * lowered to a WasmGC wrapper struct. When such a closure is held in an
 * `any`-typed binding (or an open-object slot) and read back dynamically, the
 * `typeof` operator routes through the native `__typeof_function` /
 * `__typeof_object` helpers synthesised by `addUnionImportsAsNativeFuncs`.
 *
 * Before this fix those helpers were stubs:
 *   - `__typeof_function` returned a hard `0` → a stored closure reported
 *     `typeof !== "function"` (it fell through to `"object"`).
 *   - `__typeof_object` returned `1` for *any* non-null, non-boxed-primitive
 *     externref → a closure wrapper read from an open slot was mis-classified
 *     as `"object"`.
 *
 * `fillStandaloneTypeofClosureArms` (src/codegen/index.ts) rewrites both helper
 * bodies at finalize — after every closure type is registered in
 * `ctx.closureInfoByTypeIdx` — to `ref.test` the closure base-wrapper set:
 *   - `__typeof_function`: any.convert_extern then chained `ref.test` over each
 *     closure base wrapper → 1 on first match, else 0.
 *   - `__typeof_object`: a closure-base-wrapper `ref.test` guard returning 0
 *     (a callable is `"function"`, never `"object"`) before the terminal
 *     non-null `i32.const 1`.
 *
 * The fix is no-op outside native-strings (the helpers only exist there) and
 * when no closure base wrapper was registered.
 *
 * Tests use the *dynamic* typeof path (closure stored in an `any` slot / open
 * object property) so the value flows through the native helper rather than
 * being statically resolved to `"function"` at compile time.
 */

async function runStandalone(src: string, target: "standalone" | "wasi"): Promise<number> {
  const r = await compile(src, { target });
  expect(
    r.success,
    `compile failed (${target}):\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  // Standalone / WASI binaries take no JS-host imports beyond an empty env.
  const { instance } = await WebAssembly.instantiate(r.binary, { env: {} });
  return (instance.exports as Record<string, (...a: unknown[]) => number>).test();
}

const TARGETS: Array<"standalone" | "wasi"> = ["standalone", "wasi"];

describe("#1896 standalone typeof recognises closure wrappers", () => {
  for (const target of TARGETS) {
    describe(`target=${target}`, () => {
      it("closure held in an `any` slot reports typeof 'function'", async () => {
        const src = `
          export function test(): number {
            const f = (x: number): number => x * 2;
            const a: any = f;
            return (typeof a === "function") ? 1 : 0;
          }
        `;
        expect(await runStandalone(src, target)).toBe(1);
      });

      it("capturing closure in an `any` slot reports typeof 'function'", async () => {
        const src = `
          export function test(): number {
            let k = 7;
            const f = (): number => k;
            const a: any = f;
            return (typeof a === "function") ? 1 : 0;
          }
        `;
        expect(await runStandalone(src, target)).toBe(1);
      });

      it("plain object in an `any` slot is NOT 'function'", async () => {
        const src = `
          export function test(): number {
            const o: any = { a: 1 };
            return (typeof o === "function") ? 1 : 0;
          }
        `;
        expect(await runStandalone(src, target)).toBe(0);
      });

      it("plain object in an `any` slot reports typeof 'object'", async () => {
        const src = `
          export function test(): number {
            const o: any = { a: 1 };
            return (typeof o === "object") ? 1 : 0;
          }
        `;
        expect(await runStandalone(src, target)).toBe(1);
      });

      it("number in an `any` slot is NOT 'function'", async () => {
        const src = `
          export function test(): number {
            const x: any = 7;
            return (typeof x === "function") ? 1 : 0;
          }
        `;
        expect(await runStandalone(src, target)).toBe(0);
      });

      it("string in an `any` slot is NOT 'function'", async () => {
        const src = `
          export function test(): number {
            const s: any = "hi";
            return (typeof s === "function") ? 1 : 0;
          }
        `;
        expect(await runStandalone(src, target)).toBe(0);
      });
    });
  }
});
