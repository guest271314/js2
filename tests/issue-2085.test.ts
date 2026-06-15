// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2085 — array-HOF predicate truthiness (`buildTruthyCheck`).
 *
 * The truthiness test for array higher-order-method callback RESULTS
 * (filter/find/some/every) was a second hand-rolled ToBoolean that drifted from
 * the canonical `ensureI32Condition` (src/codegen/index.ts): its `f64` arm used
 * `f64.ne 0` (so `NaN` was wrongly truthy) and its ref/externref arm only did a
 * `ref.is_null` non-null check (so a boxed `0` / `""` / `false` / `NaN` was
 * wrongly truthy). §7.1.2 ToBoolean: those are all falsy.
 *
 * `buildTruthyCheck` / `buildFalsyCheck` now route through a shared
 * `buildToBooleanInstrs` that mirrors `ensureI32Condition`: f64 → `|x|>0`,
 * any-boxed ref → `__any_unbox_bool`, externref → `__is_truthy`, native-string →
 * length>0.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";

async function run(src: string): Promise<unknown> {
  const r = await compileToWasm(src);
  return (r as { test: () => unknown }).test();
}

describe("#2085 array-HOF predicate truthiness", () => {
  it("filter with NaN predicate keeps none (NaN is falsy)", async () => {
    expect(await run(`export function test(): number { return [1, 2, 3].filter((x) => NaN as any).length; }`)).toBe(0);
  });

  it("filter with a boxed-0 predicate keeps none", async () => {
    expect(
      await run(`export function test(): number { const z: any = 0; return [1, 2, 3].filter((x) => z).length; }`),
    ).toBe(0);
  });

  it("filter with a boxed-empty-string predicate keeps none", async () => {
    expect(
      await run(`export function test(): number { const e: any = ""; return [1, 2, 3].filter((x) => e).length; }`),
    ).toBe(0);
  });

  it("filter with a truthy predicate keeps all", async () => {
    expect(await run(`export function test(): number { return [1, 2, 3].filter((x) => 5 as any).length; }`)).toBe(3);
  });

  it("find: element-as-any — 0 is falsy, first truthy element wins", async () => {
    expect(
      await run(`export function test(): number { const r = [0, 1].find((x) => (x as any)); return r === 1 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("some/every with boxed-falsy predicate results", async () => {
    expect(
      await run(
        `export function test(): number { const z: any = 0; return ([1, 2].some((x) => z) || [1, 2].every((x) => z)) ? 1 : 0; }`,
      ),
    ).toBe(0);
  });

  it("normal boolean predicates are unaffected", async () => {
    expect(
      await run(
        `export function test(): number { const f = [1, 2, 3, 4].filter((x) => x > 2).length; const r = [1, 2, 3].find((x) => x === 2); return (f === 2 && r === 2) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
