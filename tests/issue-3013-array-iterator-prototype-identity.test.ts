// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3013 — genuine, identity-stable `%ArrayIteratorPrototype%` singleton (standalone).
 *
 * Extends #2963/#3006's "reify builtins as first-class values with real object
 * identity" substrate to array iterators. ECMA-262 §23.1.5.2: every array
 * iterator (`[].values()` / `.keys()` / `.entries()` / `[][Symbol.iterator]()`)
 * is `ObjectCreate(%ArrayIteratorPrototype%, …)`, so
 * `Object.getPrototypeOf([].values()) === Object.getPrototypeOf([][Symbol.iterator]())`
 * holds by ONE shared prototype identity.
 *
 * Two parts:
 *   1. `<array>[Symbol.iterator]()` in standalone/WASI now lowers to the native
 *      `Array.prototype.values` path (they are the SAME operation, §23.1.3.40),
 *      producing an identical host-free `$__IterRec` instead of leaking the
 *      `env::__iterator` host import.
 *   2. `Object.getPrototypeOf(<array iterator>)` reifies a genuine, identity-
 *      stable native `$Object` `%ArrayIteratorPrototype%` singleton (one
 *      module-level global, lazily `__new_plain_object`) that every array
 *      iterator routes through. Detection is keyed on the TS checker's precise
 *      `ArrayIterator<T>` result type (distinct from
 *      `Generator`/`MapIterator`/`SetIterator`/`StringIterator`), so no other
 *      iterator kind is mis-routed to this prototype.
 *
 * The identity checks below use a CLEAN SameValue helper (`if (a===b) return
 * true`) bound through locals — the concrete WasmGC `ref.eq` identity path.
 * (The verbatim test262 `assert._isSameValue` contains `1/a === 1/b`, whose
 * pre-existing `any`-operand ToNumber coercion collapses object comparisons when
 * the operands are passed inline as call arguments — a separate bug, untouched
 * here; the array-iterator test262 files still pass since they only assert the
 * TRUE case, and none of the changed lowering depends on it.)
 */

const SAME = `function isSameValue(a: any, b: any): boolean { if (a === b) { return true; } return a !== a && b !== b; }\n`;

async function runStandalone(body: string): Promise<number> {
  const r = await compile(SAME + `export function test(): number { ${body} }`, {
    target: "standalone",
    nativeStrings: true,
  });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function envImports(src: string): Promise<string[]> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r.imports.filter((i) => i.module === "env").map((i) => i.name);
}

describe("#3013 — %ArrayIteratorPrototype% shared identity (standalone)", () => {
  it("getPrototypeOf([].values()) === getPrototypeOf([][Symbol.iterator]()) — GENUINELY true", async () => {
    expect(
      await runStandalone(
        `const p1: any = Object.getPrototypeOf([][Symbol.iterator]()); const p2: any = Object.getPrototypeOf([].values()); return isSameValue(p1, p2) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("values()/keys()/entries() all share one prototype identity", async () => {
    expect(
      await runStandalone(
        `const a=[1,2]; const p1: any = Object.getPrototypeOf(a.values()); const p2: any = Object.getPrototypeOf(a.keys()); const p3: any = Object.getPrototypeOf(a.entries()); return (isSameValue(p1,p2) && isSameValue(p2,p3)) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("identity holds for iterators flowing through variables", async () => {
    expect(
      await runStandalone(
        `const it1=[].values(); const it2=[][Symbol.iterator](); const p1: any = Object.getPrototypeOf(it1); const p2: any = Object.getPrototypeOf(it2); return isSameValue(p1, p2) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  // Swap-wrong-value guards: the shared array-iterator prototype must be a
  // GENUINELY DISTINCT object — not a coincidental null≡null or all-objects-equal.
  it("SWAP: array-iterator prototype !== array prototype", async () => {
    expect(
      await runStandalone(
        `const p1: any = Object.getPrototypeOf([].values()); const p2: any = Object.getPrototypeOf([1,2]); return isSameValue(p1, p2) ? 1 : 0;`,
      ),
    ).toBe(0);
  });

  it("SWAP: array-iterator prototype !== plain-object prototype", async () => {
    expect(
      await runStandalone(
        `const p1: any = Object.getPrototypeOf([].values()); const p2: any = Object.getPrototypeOf({a:1}); return isSameValue(p1, p2) ? 1 : 0;`,
      ),
    ).toBe(0);
  });

  it("SWAP: array-iterator prototype !== generator-iterator prototype", async () => {
    expect(
      await runStandalone(
        `function* g(){yield 1;} const p1: any = Object.getPrototypeOf([].values()); const p2: any = Object.getPrototypeOf(g()); return isSameValue(p1, p2) ? 1 : 0;`,
      ),
    ).toBe(0);
  });

  it("[Symbol.iterator]() and getPrototypeOf(array iterator) are host-free (no env::__iterator)", async () => {
    const forms = [
      `export function test(): number { const p: any = Object.getPrototypeOf([].values()); return p ? 1 : 0; }`,
      `export function test(): number { const p: any = Object.getPrototypeOf([][Symbol.iterator]()); return p ? 1 : 0; }`,
    ];
    for (const src of forms) {
      const env = await envImports(src);
      expect(env, `leaked env import(s): ${env.join(",")}`).not.toContain("__iterator");
      expect(env).not.toContain("__getPrototypeOf");
    }
  });

  it("for-of / spread over an array iterator still works host-free", async () => {
    expect(await runStandalone(`let s=0; for (const x of [1,2,3][Symbol.iterator]()) s+=x as number; return s;`)).toBe(
      6,
    );
  });
});
