// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2175 V2-S1 — the MATERIALIZED `__typeof` function-classifier arm.
 *
 * #1896 taught the standalone `__typeof_function` PREDICATE (the inline
 * `typeof x === "function"` compare) to recognise closure wrapper structs, but
 * the MATERIALIZED `__typeof` native — the tag as a NativeString VALUE, used by
 * `const t = typeof x` / `typeof x` flowing through a param — had NO function
 * arm and fell through to `"object"`. So `typeof` was path-dependent: inline
 * said `"function"`, const-bound said `"object"` (the #2984 defect; it also
 * contradicted `JsTag.Function`, #2949 V1 tag fidelity).
 *
 * `fillStandaloneTypeofClosureArms` now splices a closure `ref.test` →
 * `"function"` arm into `__typeof` at finalize, using the SAME shared
 * closure-base-wrapper list (`closure-classifier.ts`) as the predicate — one
 * predicate, all three typeof natives in lockstep.
 *
 * All cases run under `--target standalone`, host-free (zero `env` imports).
 */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, `compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const env = r.imports.filter((i) => i.module === "env");
  expect(env).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2175 V2-S1 — materialized typeof classifies closures as 'function'", () => {
  it("closure: inline AND const-bound typeof both report 'function'", async () => {
    // Inline form goes through the __typeof_function predicate (#1896); the
    // const-bound form materializes the tag through __typeof (V2-S1). Both must
    // agree — the fix eliminates the path-dependence.
    expect(
      await runStandalone(`
        export function test(): number {
          const f = (x: number): number => x * 2;
          const a: any = f;
          const inlineFn: number = (typeof a === "function") ? 1 : 0;
          const t: any = typeof a;
          const boundFn: number = (t === "function") ? 1 : 0;
          return (inlineFn === 1 && boundFn === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("capturing closure: materialized typeof is 'function'", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          let k = 7;
          const f = (): number => k;
          const a: any = f;
          const t: any = typeof a;
          return (t === "function") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("RegExp.prototype.exec: inline AND const-bound typeof both 'function'", async () => {
    // The native-method-closure VALUE (a $NativeProto member read, #2175 S1)
    // read back as `any` must classify as a function through the runtime native,
    // not just the compile-time TS type.
    expect(
      await runStandalone(`
        export function test(): number {
          const m: any = RegExp.prototype.exec;
          const inlineFn: number = (typeof m === "function") ? 1 : 0;
          const t: any = typeof m;
          const boundFn: number = (t === "function") ? 1 : 0;
          return (inlineFn === 1 && boundFn === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("swap-guard: a materialized closure typeof is NOT 'object'", async () => {
    // Proves the function arm actually fires (diverts closures away from the
    // "object" fallthrough) rather than the test passing coincidentally: if the
    // arm were absent this returns 1 (closure → "object"); with the arm it is 0.
    expect(
      await runStandalone(`
        export function test(): number {
          const f = (x: number): number => x;
          const a: any = f;
          const t: any = typeof a;
          return (t === "object") ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("non-closure receivers keep their materialized tag (no over-broad diversion)", async () => {
    // Guards that the new arm does not mis-classify plain objects / primitives.
    expect(
      await runStandalone(`
        export function test(): number {
          const o: any = { x: 1 };
          const n: any = 42;
          const s: any = "hi";
          const b: any = true;
          const to: any = typeof o;
          const tn: any = typeof n;
          const ts: any = typeof s;
          const tb: any = typeof b;
          return (to === "object" && tn === "number" && ts === "string" && tb === "boolean") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
