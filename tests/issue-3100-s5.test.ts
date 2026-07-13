// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3100 S5 — IteratorClose (§7.4.9) through the native ladder + custom-iterable
 * consumer completion (standalone).
 *
 * Before this slice:
 *   - `__iterator_return` was an EMPTY native body — for-of break/throw and
 *     non-exhausting destructuring never called a user iterator's `return()`.
 *   - the `__array_from_iter_n` materializer passed custom-iterable closed
 *     structs THROUGH (the #2904 guard), so `[x, y] = customIterable` read
 *     nothing (indexed reads on a method struct) — values wrong AND no close.
 *   - `__iterator_rest` was VEC-only, so `[...customIterable]` /
 *     `Array.from(customIterable)` silently produced [].
 *
 * The fix (all at the finalize fill, reserve-then-fill discipline):
 *   - `emitMethodDispatch("return", "__call_return")` (index.ts) — emitted only
 *     when some struct carries a `return` method.
 *   - `__iterator_return` gains a USER close arm: dispatch `__call_return` on
 *     the record's userIter; every non-USER shape no-ops (never traps).
 *   - `__array_from_iter_n` gains user-iterable drain arms (structs with an
 *     `@@iterator`/`next` method) and calls IteratorClose when the bounded
 *     drain stops with the iterator NOT done (§8.5.2/§13.15.5.2). This
 *     deliberately diverges from the host `_arrayFromIter` (#1592 no-close) —
 *     the native lane follows the spec.
 *   - `__iterator_rest` gains a USER step-to-exhaustion drain arm.
 *   - the spread-literal externref arm materializes through
 *     `__array_from_iter_n(src, -1)` first (passthrough for indexable
 *     carriers, protocol drain for custom iterables).
 *
 * Every case compiles standalone and must instantiate with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

/** A counting custom iterable: yields 10,20,30 then done; counts return(). */
const ITER = `
      let closed = 0;
      const it: any = {
        [Symbol.iterator]() {
          return {
            i: 0,
            next() { this.i += 1; return { value: this.i * 10, done: this.i > 3 }; },
            return() { closed += 1; return { done: true }; },
          };
        },
      };`;

describe("#3100 S5 — IteratorClose §7.4.9 (native __iterator_return USER arm)", () => {
  it("assignment dstr close: [x] = iterable → return() called once", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        let x = 0;
        [x] = it;
        return closed;
      }`),
    ).toBe(1);
  });

  it("decl dstr close: const [x] = iterable → return() called once", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        const [x] = it;
        return closed;
      }`),
    ).toBe(1);
  });

  it("for-of break close: return() called once", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        for (const v of it) { if (v === 20) break; }
        return closed;
      }`),
    ).toBe(1);
  });

  it("for-of throw close: return() called once, exception catchable", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        let seen = 0;
        try {
          for (const v of it) { seen = v; throw new Error("stop"); }
        } catch (e) { }
        return closed * 10 + (seen === 10 ? 1 : 0);
      }`),
    ).toBe(11);
  });

  it("exhaustion does NOT close (for-of full drive)", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        let n = 0;
        for (const v of it) { n += v; }
        return n + closed * 1000;
      }`),
    ).toBe(60);
  });

  it("rest pattern exhausts → no close", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        let a = 0;
        let r: any = null;
        [a, ...r] = it;
        return closed;
      }`),
    ).toBe(0);
  });

  it("already-done iterator: no close", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let closed = 0;
        const it: any = {
          [Symbol.iterator]() {
            return {
              next() { return { value: undefined, done: true }; },
              return() { closed += 1; return { done: true }; },
            };
          },
        };
        let x: any = null;
        [x] = it;
        return closed;
      }`),
    ).toBe(0);
  });

  it("iterable WITHOUT return(): close is the spec no-op, values intact", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const it: any = {
          [Symbol.iterator]() {
            return {
              i: 0,
              next() { this.i += 1; return { value: this.i * 10, done: this.i > 3 }; },
            };
          },
        };
        let x = 0, y = 0;
        [x, y] = it;
        return x + y;
      }`),
    ).toBe(30);
  });
});

describe("#3100 S5 — custom-iterable consumer completion (materializer/rest drain)", () => {
  it("dstr VALUES from custom iterable: [x, y] = it → 10+20", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        let x = 0, y = 0;
        [x, y] = it;
        return x + y;
      }`),
    ).toBe(30);
  });

  it("decl dstr VALUES: const [x, y] = it → 10+20", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        const [x, y] = it;
        return x + y;
      }`),
    ).toBe(30);
  });

  it("rest values: [a, ...r] = it → a=10, r.length=2", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        let a = 0;
        let r: any = null;
        [a, ...r] = it;
        return a + r.length;
      }`),
    ).toBe(12);
  });

  it("spread [...customIterable] → 3 elements (was silently [])", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        const c = [...it];
        return c.length;
      }`),
    ).toBe(3);
  });

  it("spread content: [...it][1] === 20", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        const c: any = [...it];
        return c[1];
      }`),
    ).toBe(20);
  });

  it("Array.from(customIterable) → 3 elements (was silently [])", async () => {
    expect(
      await runStandalone(`export function test(): number {${ITER}
        const c = Array.from(it);
        return c.length;
      }`),
    ).toBe(3);
  });
});

describe("#3100 S5 — regression guards", () => {
  it("[a,b] = <any vec> unchanged (S4 path)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [1, 2, 3];
        let a = 0, b = 0;
        [a, b] = o;
        return a + b;
      }`),
    ).toBe(3);
  });

  it("spread [...<any vec>] unchanged", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [1, 2, 3];
        const c = [...o];
        return c.length;
      }`),
    ).toBe(3);
  });

  it("generator dstr unchanged (native gen carrier)", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield 1; yield 2; yield 3; }
      export function test(): number {
        const [a, b] = g();
        return a + b;
      }`),
    ).toBe(3);
  });

  it("for-of over Object.keys(<any>) unchanged (S1 probe)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 5, b: 6 };
        let n = 0;
        for (const k of Object.keys(o)) { n += 1; }
        return n;
      }`),
    ).toBe(2);
  });
});
