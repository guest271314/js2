// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1104 Phase 3 — native Error instanceof + throw/catch (standalone mode).
//
// Phase 1 (PR #324) made `new Error(...)` build a `$Error_struct` in WASI
// mode; Phase 2 wired `.message` / `.name` reads to `struct.get`. Phase 3
// makes `error instanceof TypeError` and `try { throw new RangeError() }
// catch (e) { e instanceof ... }` work standalone, driven by the
// `$Error_struct` `$tag` field (#1325 builtin-type-tag registry) instead of
// the `__instanceof` host import — which is unavailable with no JS host.
//
// Scope (this file locks the already-landed behaviour against regression):
//   1. `e instanceof <SameError>` → true; `e instanceof Error` (parent) → true;
//      `e instanceof <OtherError>` → false. Subclass tag-walk via BUILTIN_PARENT.
//   2. `try { throw new <Error> } catch (e) { e instanceof <Error> }` round-trips
//      the struct ref through the externref exception payload and back.
//   3. The WASI module instantiates with NO `env` imports and the exported
//      function returns the spec-correct i32 (1 = true, 0 = false).
//   4. JS-host mode is unchanged — instanceof still routes through the host
//      path there (control case).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runWasi(src: string): Promise<number> {
  const r = await compile(src, { target: "wasi" });
  expect(r.success).toBe(true);
  // Standalone: no JS host imports needed for Error instanceof / throw-catch.
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#1104 Phase 3 — native Error instanceof + throw/catch (standalone mode)", () => {
  describe("WASI mode — instanceof", () => {
    it("`e instanceof TypeError` is true for a TypeError", async () => {
      expect(
        await runWasi(`
          export function test(): number {
            const e = new TypeError("x");
            return (e instanceof TypeError) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("`e instanceof Error` is true for a TypeError (parent-chain tag walk)", async () => {
      expect(
        await runWasi(`
          export function test(): number {
            const e = new TypeError("x");
            return (e instanceof Error) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("`e instanceof RangeError` is false for a TypeError (sibling)", async () => {
      expect(
        await runWasi(`
          export function test(): number {
            const e = new TypeError("x");
            return (e instanceof RangeError) ? 1 : 0;
          }
        `),
      ).toBe(0);
    });
  });

  describe("WASI mode — throw / catch", () => {
    it("catch binds the thrown Error struct; instanceof on it holds", async () => {
      expect(
        await runWasi(`
          export function test(): number {
            try {
              throw new RangeError("r");
            } catch (e) {
              return (e instanceof RangeError) ? 1 : 0;
            }
          }
        `),
      ).toBe(1);
    });

    it("caught Error is also instanceof Error (parent) in standalone mode", async () => {
      expect(
        await runWasi(`
          export function test(): number {
            try {
              throw new SyntaxError("s");
            } catch (e) {
              return (e instanceof Error) ? 1 : 0;
            }
          }
        `),
      ).toBe(1);
    });
  });

  describe("JS-host mode unchanged (control)", () => {
    it("instanceof still compiles in default (JS-host) mode", async () => {
      const r = await compile(
        `
          export function test(): number {
            const e = new TypeError("x");
            return (e instanceof TypeError) ? 1 : 0;
          }
        `,
      );
      expect(r.success).toBe(true);
    });
  });
});
