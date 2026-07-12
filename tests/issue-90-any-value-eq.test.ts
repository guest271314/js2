// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #90 / #3154 — `any !== any` value-equality for string / symbol / undefined
// under externref, and the array-literal-in-`any`-context lossy-f64 rep.
//
// Two coupled root causes, both surfaced by the test262 `compareArray` harness
// shim (`compareArray(a: any, b: any)`) which does `a[i] !== b[i]` over element
// reads of `any` params:
//
//  (A) ARRAY-LITERAL REP (#3154): an array literal built in a BARE-`any`
//      context (`f([1, void 0, 3])` with `f(a: any)`, or an inner tuple of an
//      `any[]`) adopted the first-element f64/i32 fast path. A `void 0` element
//      became the sNaN sentinel (read back as a NaN *number*, `a[1] !== a[1]`
//      self-compare true, `typeof` lies "number"), and string / boolean /
//      symbol elements were number-coerced or dropped at CONSTRUCTION —
//      unrecoverable at any read site. Fix: widen a non-all-numeric bare-`any`
//      literal to externref-boxed elements (each boxed by its own static type),
//      matching what the `Array<any>` context already does. A homogeneous
//      numeric literal keeps the f64 fast path.
//
//  (B) STRICT-EQ VALUE COMPARE (#90): a dynamic element/member read in
//      standalone lowers to a `(ref $AnyValue)` carrier; compared with `===`/
//      `!==` against an `any` PARAM (raw externref) or a primitive, the codegen
//      `ref.eq`'d the CARRIER BOX against the raw value — always false. So two
//      equal strings, the SAME interned symbol via different boxes, or a
//      boxed-undefined vs undefined wrongly tested unequal. Fix: route the
//      mixed `$AnyValue`-vs-externref/primitive pair through the tag-aware
//      `__any_strict_eq` (§7.2.16 IsStrictlyEqual: numbers by value with
//      NaN≠NaN / +0===-0, strings by content, objects/symbols by identity),
//      classifying the non-carrier side with the SAME honest classifier the
//      reader used. Symbol operands are boxed by their static brand
//      (`__box_symbol` interned carrier), never `__box_number`.
//
// §7.2.16 IsStrictlyEqual is the governing spec: SameType short-circuits on a
// type mismatch (no coercion), Number by `f64.eq`, String by code-unit content,
// Symbol / Object by identity.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-90.ts", target: "standalone" });
  expect(result.success, result.success ? "" : `compile error: ${result.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  const leaked = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(
    leaked.map((i) => i.name),
    "no host imports leaked in standalone",
  ).toEqual([]);
  const inst = await WebAssembly.instantiate(mod, {});
  return (inst.exports as { test(): number }).test();
}

async function runHost(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-90.ts" });
  expect(result.success, result.success ? "" : `compile error: ${result.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  const imports = buildImports(
    (result as unknown as { imports: unknown[] }).imports ?? [],
    undefined,
    result.stringPool,
  );
  const inst = await WebAssembly.instantiate(mod, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    inst.exports as Record<string, Function>,
  );
  return (inst.exports as { test(): number }).test();
}

// Each case runs on BOTH lanes (standalone dominant, host for the harness-lane
// coverage of #3154's 15-test host regression cluster).
function bothLanes(name: string, source: string, expected: number) {
  it(`${name} (standalone)`, async () => {
    expect(await runStandalone(source)).toBe(expected);
  });
  it(`${name} (host)`, async () => {
    expect(await runHost(source)).toBe(expected);
  });
}

describe("#90/#3154 — array-literal any-context rep + strict-eq value compare", () => {
  // ── (A) #3154 array-literal lossy-f64 rep ──
  bothLanes(
    "undefined element self-compares equal (no NaN sentinel leak)",
    `function f(a: any): number { return a[1] !== a[1] ? 0 : 1; }
     export function test(): number { return f([1, void 0, 3]); }`,
    1,
  );
  bothLanes(
    "typeof a bare-any undefined element is 'undefined', not 'number'",
    `function g(a: any): number { return typeof a[1] === "undefined" ? 1 : 0; }
     export function test(): number { return g([1, void 0, 3]); }`,
    1,
  );
  bothLanes(
    "string element in a numeric-first bare-any literal survives",
    `function f(a: any): number { return a[1] === "z" ? 1 : 0; }
     export function test(): number { return f([1, "z"]); }`,
    1,
  );
  bothLanes(
    "boolean element in a numeric-first bare-any literal keeps its tag",
    `function f(a: any): number { return a[0] === true ? 1 : 0; }
     export function test(): number { return f([true, "z"]); }`,
    1,
  );
  bothLanes(
    "homogeneous numeric bare-any literal keeps the fast path (elements read back)",
    `function f(a: any): number { return a[0] === 1 && a[2] === 3 ? 1 : 0; }
     export function test(): number { return f([1, 2, 3]); }`,
    1,
  );

  // ── (B) #90 strict-eq value compare through mixed carrier/param ──
  bothLanes(
    "equal strings from distinct allocations compare === through any params",
    `function f(a: any, b: any): number { return a === b ? 1 : 0; }
     export function test(): number { let x = "a"; x = x + "b"; return f("ab", x); }`,
    1,
  );
  bothLanes(
    "any[] string element !== string element compares by VALUE (compareArray shape)",
    `function f(a: any, b: any): number { return a !== b ? 1 : 0; }
     export function test(): number {
       let x = "a"; x = x + "b";
       const arr: any[] = ["ab", x];
       return f(arr[0], arr[1]);
     }`,
    0,
  );
  bothLanes(
    "same symbol via an any[] element and a param compares === (identity, not box)",
    `function f(a: any, s: any): number { return a[0] === s ? 1 : 0; }
     export function test(): number { const s = Symbol("k"); const t: any[] = [s, 2]; return f(t, s); }`,
    1,
  );
  bothLanes(
    "same module-scoped symbol via an any[] element compares ===",
    `const symA = Symbol("a");
     function f(a: any): number { return a[0] === symA ? 1 : 0; }
     export function test(): number { const t: any[] = [symA, 2]; return f(t); }`,
    1,
  );
  bothLanes(
    "distinct same-description symbols compare !== (identity, not description)",
    `function f(a: any, s: any): number { return a[0] === s ? 1 : 0; }
     export function test(): number { const s1 = Symbol("k"); const s2 = Symbol("k"); const t: any[] = [s1, 2]; return f(t, s2); }`,
    0,
  );
  bothLanes(
    "NaN element self-compare is !== (spec §7.2.16 Number(NaN, NaN) = false)",
    `function f(a: any): number { return a[0] !== a[0] ? 1 : 0; }
     export function test(): number { const t: any[] = [NaN, "z"]; return f(t); }`,
    1,
  );
  bothLanes(
    "-0 element === +0 literal through any (spec §7.2.16 Number +0/-0 equal)",
    `function f(a: any): number { return a[0] === 0 ? 1 : 0; }
     export function test(): number { const t: any[] = [-0, "z"]; return f(t); }`,
    1,
  );
  bothLanes(
    "distinct objects stay !== (identity preserved)",
    `function f(a: any, o: any): number { return a[0] === o ? 1 : 0; }
     export function test(): number { const o1: any = { x: 1 }; const o2: any = { x: 1 }; const t: any[] = [o1, "z"]; return f(t, o2); }`,
    0,
  );
  bothLanes(
    "the same object stays === through element and param",
    `function f(a: any, o: any): number { return a[0] === o ? 1 : 0; }
     export function test(): number { const o1: any = { x: 1 }; const t: any[] = [o1, "z"]; return f(t, o1); }`,
    1,
  );
  bothLanes(
    "boolean element strict-!== a number (no cross-type coercion, §7.2.16 SameType)",
    `function f(a: any): number { return a[0] === 1 ? 1 : 0; }
     export function test(): number { const t: any[] = [true, "z"]; return f(t); }`,
    0,
  );
});
