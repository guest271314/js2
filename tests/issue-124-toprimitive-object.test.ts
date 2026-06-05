import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #124 (co-land with #1901) — ToPrimitive over a `$Object` (user object with its
 * own valueOf/toString/Symbol.toPrimitive) under `--target standalone`.
 *
 * #1901 routes any-context object literals to the open `$Object` and stores
 * their own methods as callable closures (proven: `{foo:()=>7}` → `o.foo()`
 * dispatches via `__extern_method_call`). But valueOf/toString are intercepted
 * by name-specific call-site / coercion handlers that bypass that generic
 * dispatch, so OrdinaryToPrimitive (§7.1.1.1) never invokes the user method —
 * yielding NaN, a refused `__extern_toString`, or a null-deref. This is the
 * −266 regression cluster the #1897 gate caught on #1901-alone (#1241).
 *
 * §7.1.1 ToPrimitive / §7.1.1.1 OrdinaryToPrimitive: number/default hint tries
 * valueOf then toString; string hint tries toString then valueOf; if neither
 * returns a primitive, throw a TypeError.
 */

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#124 — $Object ToPrimitive (own valueOf/toString) under standalone", () => {
  it("numeric coercion calls own valueOf: (o as number)+0 → 7", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = { valueOf: () => 7 }; return (o as number) + 0; }`,
      ),
    ).toBe(7);
  });

  it("arithmetic forces valueOf: o * 1 → 7", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = { valueOf: () => 7 }; return (o as any) * 1; }`,
      ),
    ).toBe(7);
  });

  it("explicit o.valueOf() dispatches the own method (not the wrapper identity)", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = { valueOf: function() { return 42; } }; return o.valueOf() as number; }`,
      ),
    ).toBe(42);
  });

  it("abrupt completion: own valueOf throws → propagates (the 174-cluster shape)", async () => {
    // `o.valueOf()` throws a sentinel; arithmetic coercion must invoke it so the
    // throw propagates. We assert the thrown control reaches the catch (run → 1).
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { valueOf: function() { throw 99; } };
        try { return (o as any) * 1; } catch (e) { return (e as number) === 99 ? 1 : 0; }
      }`),
    ).toBe(1);
  });

  it("no valueOf/toString primitive → 0 today (genuine §7.1.1.1 step-6 TypeError + NaN both deferred)", async () => {
    // §7.1.1.1 step 6: when own valueOf AND toString both return objects,
    // OrdinaryToPrimitive must throw a TypeError. This slice does NOT yet (a)
    // distinguish that exhaustion case from a *plain* `$Object` (no own
    // valueOf/toString at all), nor (b) yield the spec NaN — `__to_primitive`
    // returns the `undefined` sentinel when no own primitive method is found,
    // and the native `__unbox_number(undefined)` is **0** (not NaN). Both the
    // genuine step-6 throw and the `__unbox_number(undefined)→NaN` correction are
    // tracked #124 follow-ons (see plan/issues/1901 — the closed-struct/$Object
    // representation work). The contract pinned here is the CURRENT honest
    // behaviour: the module compiles + runs (no invalid Wasm, no spurious throw),
    // yielding 0. When the follow-on lands this flips to a thrown TypeError.
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { valueOf: () => ({}), toString: () => ({}) };
        return (o as any) * 1;
      }`),
    ).toBe(0);
  });
});
