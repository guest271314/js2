// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { injectIteratorStaticsPrelude } from "../src/iterator-statics-prelude.js";

// #3146 — standalone (no-JS-host) `Iterator.zip / zipKeyed / concat / from`.
// The four ES2025+ Iterator static helpers used to hard-CE standalone through
// the `__get_builtin` refusal (#1472 Phase B). They are now delivered by a
// source-prelude (`src/iterator-statics-prelude.ts`) riding on the native
// iterator runtime via the `__j2w_iter_*` intrinsics — ZERO new host imports.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // The whole point: no JS host imports leak (the prelude is pure Wasm).
  expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3146 standalone Iterator static helpers", () => {
  it("Iterator.from(array) drives a for-of", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          let s = 0;
          for (const v of Iterator.from([1, 2, 3])) s = s + v;
          return s;
        }
      `),
    ).toBe(6);
  });

  it("Iterator.from(custom iterator) steps via explicit next()", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          let i = 0;
          const src: any = { next() { i = i + 1; return { done: i > 2, value: i * 10 }; } };
          const it: any = Iterator.from(src);
          let s = 0;
          const r1: any = it.next(); s = s + r1.value;
          const r2: any = it.next(); s = s + r2.value;
          const r3: any = it.next(); if (r3.done) s = s + 100;
          return s;
        }
      `),
    ).toBe(130);
  });

  it("Iterator.from(string) yields code points", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          let n = 0;
          for (const ch of Iterator.from("abc")) n = n + 1;
          return n;
        }
      `),
    ).toBe(3);
  });

  it("Iterator.concat sequences its iterables", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          let s = 0;
          for (const v of Iterator.concat([1, 2], [3], [4, 5])) s = s * 10 + v;
          return s;
        }
      `),
    ).toBe(12345);
  });

  it("Iterator.concat forwards return() to the underlying iterator (idempotent)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          let returnCount = 0;
          const testIterator: any = {
            next() { return { done: false, value: 1 }; },
            return() { returnCount = returnCount + 1; return {}; },
          };
          const iterable: any = { [Symbol.iterator]() { return testIterator; } };
          const iterator: any = Iterator.concat(iterable);
          let s = 0;
          if (returnCount === 0) s = s + 1;
          const r: any = iterator.next();
          if (returnCount === 0 && r.done === false && r.value === 1) s = s + 10;
          iterator.return();
          if (returnCount === 1) s = s + 100;
          iterator.return();
          if (returnCount === 1) s = s + 1000;
          return s;
        }
      `),
    ).toBe(1111);
  });

  it("Iterator.zip (shortest) pairs elements", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          let s = 0;
          for (const pair of Iterator.zip([[1, 2, 3], [10, 20]])) {
            s = s + (pair as any)[0] + (pair as any)[1];
          }
          return s;
        }
      `),
    ).toBe(1 + 10 + 2 + 20);
  });

  it("Iterator.zip (strict) throws TypeError on length mismatch", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it: any = Iterator.zip([[1, 2], [1]], { mode: "strict" });
          it.next();
          try { it.next(); return 0; }
          catch (e) { return e instanceof TypeError ? 1 : 2; }
        }
      `),
    ).toBe(1);
  });

  it("Iterator.zip return() closes sources in reverse order", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const st: any = { log: 0 };
          function mkIt(id: number): any {
            return { next() { return { done: false, value: id }; },
                     return() { st.log = st.log * 10 + id; return {}; } };
          }
          const z: any = Iterator.zip([mkIt(1), mkIt(2), mkIt(3)]);
          z.return();
          return st.log; // reverse close: 3, 2, 1
        }
      `),
    ).toBe(321);
  });

  it("Iterator.zipKeyed yields keyed objects", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          let s = 0;
          for (const entry of Iterator.zipKeyed({ a: [1, 2], b: [10, 20] })) {
            s = s + (entry as any).a * 100 + (entry as any).b;
          }
          return s;
        }
      `),
    ).toBe(1 * 100 + 10 + 2 * 100 + 20);
  });

  it("Iterator.zip(non-object) throws a catchable TypeError", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          try { Iterator.zip(5 as any); return 0; }
          catch (e) { return e instanceof TypeError ? 1 : 2; }
        }
      `),
    ).toBe(1);
  });

  it("typeof Iterator.zip === 'function'", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          return typeof Iterator.zip === "function" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a user Iterator binding suppresses the rewrite (shadow guard)", () => {
    // A user-declared `Iterator` with a real body / a variable owns the name —
    // the prelude must NOT inject or rewrite `Iterator.zip`.
    const withVarShadow = injectIteratorStaticsPrelude(
      `const Iterator: any = { zip() { return 42; } };\nconst x = Iterator.zip();`,
    );
    expect(withVarShadow.injected).toBe(false);
    expect(withVarShadow.source).toContain("Iterator.zip()");
    expect(withVarShadow.source).not.toContain("__js2wasm_Iterator_zip");

    const withFnShadow = injectIteratorStaticsPrelude(
      `function Iterator() { return { zip() { return 1; } }; }\nconst y = Iterator().zip();`,
    );
    expect(withFnShadow.injected).toBe(false);

    // But the test262 %Iterator% shim (empty-body fn) does NOT suppress it —
    // that shim carries no statics, so the rewrite must still fire.
    const withShim = injectIteratorStaticsPrelude(`function Iterator(): void {}\nconst z = Iterator.zip([[1]]);`);
    expect(withShim.injected).toBe(true);
    expect(withShim.source).toContain("__js2wasm_Iterator_zip");
  });
});
