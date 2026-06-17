// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #2009 (PR-1, names) — structurally-identical anon struct types share
 * field names at the host boundary.
 *
 * `{ aa: 1 }` and `{ bb: 2 }` compile to DISTINCT anon struct typeIdxs
 * (`fieldsHashKey` includes field names), but they are structurally identical
 * (`struct (field (mut f64))`) so WasmGC iso-recursive canonicalization makes
 * them indistinguishable to `ref.test`. `__struct_field_names`'s `ref.test`
 * chain therefore returned the FIRST-registered shape's names for EVERY
 * same-shape instance — mislabelling Object.keys / JSON.stringify / for-in /
 * Object.assign / spread:
 *
 *   const a: any = { aa: 1 }; const b: any = { bb: 2 };
 *   JSON.stringify(a) + "|" + JSON.stringify(b)
 *   // wasm (buggy): {"aa":1}|{"aa":2}   node: {"aa":1}|{"bb":2}
 *
 * Fix: every host-enumerable anon object-literal struct carries a hidden
 * trailing `$shape` i32 field, stamped at construction with a shape-id keyed by
 * the ordered field-name list. `__struct_field_names` reads `struct.get $shape`
 * and selects the field-name CSV by VALUE (not by the ambiguous type), so each
 * instance reports its OWN names. The `$`-prefix keeps `$shape` out of
 * Object.keys/values/entries/for-in/JSON.
 *
 * NOTE: the spread source-order / value-resolution bug (R2 Object.assign value
 * merge, R3 `{...a,...b,x:9}` value resolution) is tracked as a separate
 * follow-up (issue #2009 PR-2 / #2076) — this PR fixes the NAME collision only.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#2009 — per-instance struct field names (host boundary)", () => {
  it("JSON.stringify of two same-shape literals reports each one's own keys", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1 };
          const b: any = { bb: 2 };
          return JSON.stringify(a) + "|" + JSON.stringify(b);
        }
      `),
    ).toBe('{"aa":1}|{"bb":2}');
  });

  it("Object.keys of two same-shape literals returns each one's own keys", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1 };
          const b: any = { bb: 2 };
          return Object.keys(a).join(",") + "|" + Object.keys(b).join(",");
        }
      `),
    ).toBe("aa|bb");
  });

  it("three distinct-name same-shape literals each report their own key", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { p: 1 };
          const b: any = { q: 2 };
          const c: any = { r: 3 };
          return JSON.stringify(a) + JSON.stringify(b) + JSON.stringify(c);
        }
      `),
    ).toBe('{"p":1}{"q":2}{"r":3}');
  });

  it("same-name literals still share names (no per-literal bloat)", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1 };
          const b: any = { aa: 9 };
          return JSON.stringify(a) + "|" + JSON.stringify(b);
        }
      `),
    ).toBe('{"aa":1}|{"aa":9}');
  });

  it("the hidden $shape field does not leak into Object.keys / values / entries", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const o: any = { p: 1, q: 2 };
          return Object.keys(o).length + "," + Object.values(o).length + "," + Object.entries(o).length;
        }
      `),
    ).toBe("2,2,2");
  });

  it("multi-field same-shape literals report distinct key sets", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { aa: 1, bb: 2 };
          const b: any = { cc: 3, dd: 4 };
          return JSON.stringify(a) + "|" + JSON.stringify(b);
        }
      `),
    ).toBe('{"aa":1,"bb":2}|{"cc":3,"dd":4}');
  });

  it("a struct with a unique field-name shape (no collision) reports its names", async () => {
    // No other same-TYPE-shape struct exists, so this struct is NOT stamped with
    // $shape (opt-in collision resolution) — verifies the non-colliding path
    // still enumerates correctly and stays on the legacy typeIdx arm.
    expect(
      await runWasm(`
        export function test(): string {
          const o: any = { onlyMe: 1, alsoMe: 2 };
          return JSON.stringify(o);
        }
      `),
    ).toBe('{"onlyMe":1,"alsoMe":2}');
  });

  it("Object.assign onto a struct target keeps the target's own field value (writeback shape-guard)", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          return JSON.stringify(Object.assign({ a: 1 }, { b: 2 }));
        }
      `),
    ).toBe('{"a":1,"b":2}');
  });
});

/**
 * #2009 R3 — spread-source VALUE resolution (PR-2).
 *
 * The struct-path object-literal lowering only read a spread source's field
 * values when the source had a *registered* struct type. An INLINE
 * object-literal spread source (`{ ...{ x: 1 } }`) is never independently
 * declared, so its anonymous object type was never registered — the source was
 * dropped from `spreadSources` and every spread-sourced field defaulted to the
 * undefined sentinel (`{ ...{x:1,y:2} }` produced `{x:null,y:null}` instead of
 * `{x:1,y:2}`). Fix: register a struct for the inline source type before
 * compiling it (`ensureStructForType`), and honour SOURCE ORDER between a named
 * prop and a spread that both write the same key (later writer wins).
 *
 * Asserted on VALUE equality (key insertion order for spread-result structs is
 * a separate pre-existing defect — see the `it.todo` below — driven by the
 * TypeChecker ordering the spread-result type's properties last-spread-first;
 * it affects NAMED-source spreads on main too and is not introduced here).
 */
describe("#2009 R3 — spread-source value resolution + source-order override", () => {
  // Each `lit` is the literal under test; `expected` is the Node-evaluated
  // value (asserted key-order-insensitive via `toEqual` — key order is R3b).
  const cases: { name: string; lit: string; expected: Record<string, unknown> }[] = [
    { name: "inline single spread", lit: `{ ...{ x: 1, y: 2 } }`, expected: { x: 1, y: 2 } },
    {
      name: "inline two spreads value merge",
      lit: `{ ...{ x: 1, y: 2 }, ...{ y: 3, z: 4 } }`,
      expected: { x: 1, y: 3, z: 4 },
    },
    {
      name: "inline spreads + named override after",
      lit: `{ ...{ x: 1, y: 2 }, ...{ y: 3, z: 4 }, x: 9 }`,
      expected: { x: 9, y: 3, z: 4 },
    },
    {
      name: "named prop before inline spread (spread wins)",
      lit: `{ x: 1, ...{ x: 5, y: 6 } }`,
      expected: { x: 5, y: 6 },
    },
    { name: "named after spread (named wins)", lit: `{ ...{ x: 5, y: 6 }, x: 1 }`, expected: { x: 1, y: 6 } },
    { name: "mixed named + inline source", lit: `{ x: 1, ...{ z: 3 } }`, expected: { x: 1, z: 3 } },
    { name: "string values in spread", lit: `{ ...{ a: "hi", b: "bye" } }`, expected: { a: "hi", b: "bye" } },
    { name: "three inline sources", lit: `{ ...{ a: 1 }, ...{ b: 2 }, ...{ c: 3 } }`, expected: { a: 1, b: 2, c: 3 } },
    {
      name: "named between two spreads (later spread overrides)",
      lit: `{ ...{ x: 1 }, y: 2, ...{ x: 9 } }`,
      expected: { x: 9, y: 2 },
    },
  ];
  for (const { name, lit, expected } of cases) {
    it(name, async () => {
      const got = (await runWasm(`export function test(): string { return JSON.stringify(${lit}); }`)) as string;
      expect(JSON.parse(got)).toEqual(expected);
    });
  }

  it("overridden named-prop initializer still runs for side effects (§13.2.5.5)", async () => {
    // `x: se()` is overridden by a later `...{ x: 5 }`, but its side-effecting
    // initializer must still evaluate exactly once.
    expect(
      await runWasm(`
        let calls = 0;
        function se(): number { calls = calls + 1; return 1; }
        export function test(): string {
          const o = { x: se(), ...{ x: 5 } };
          return JSON.stringify(o.x) + "|" + String(calls);
        }
      `),
    ).toBe("5|1");
  });

  // R3b (separate follow-up): key INSERTION ORDER for spread-result structs.
  // `{ ...{x:1,y:2}, ...{y:3,z:4} }` should stringify as `{"x":1,"y":3,"z":4}`
  // but the spread-result anon struct's fields are ordered last-spread-first
  // (`y,z,x`) by the TypeChecker, so JSON/Object.keys report `{"y":3,"z":4,"x":1}`.
  // Pre-existing on main (affects named-source spreads too); fixing it needs the
  // spread-result struct's field registration to follow JS insertion order.
  it.todo("spread-result keys follow JS insertion order (R3b — struct field-order)");
});
