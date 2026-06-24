import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

/**
 * #2177 — `Array.prototype.<m>.call(receiver, …)` element retrieval for a
 * compiled receiver (`$Vec` array literal, typed array variable, `any`-typed
 * array, or open-object numeric-key array-like).
 *
 * The spec (2026-06-04) reported that `Array.prototype.findIndex.call(
 * [10,20,30], …)` returned -1 because the generic array-like loop / host
 * `__proto_method_call` bridge could not read elements of an opaque compiled
 * receiver. By the time this regression suite was added the JS-host element
 * read was **already correct on main** — the array-method dispatch routes a
 * compiled-vec `.call` receiver to the element-aware typed `compileArrayMethodCall`
 * path (verified: no `__proto_method_call` / `__extern_get_idx` import is
 * emitted for these). These cases therefore PIN the now-working behaviour so it
 * cannot silently regress, and double as the verification harness for the four
 * "correct-but-unverifiable" point-fixes #1828/#1830/#1831/#1832 cited.
 *
 * They run through `assertEquivalent`, which compiles the source to Wasm AND
 * evaluates it as native JS, asserting the two agree.
 *
 * NOTE — standalone (`--target wasi` / `nativeStrings`) parity is intentionally
 * NOT asserted here: in that mode array-callback element boxing still routes
 * through the host `__box_number` / `__unbox_number` helpers for BOTH the
 * `.call` form and a plain `arr.findIndex(...)` call, so it is a general
 * standalone-array-callback boxing gap, not a `$Vec`-element-read gap specific
 * to #2177. Tracked separately.
 */
describe("#2177 — Array.prototype.<m>.call on a compiled receiver (element read)", () => {
  it("findIndex.call finds a dense element (headline symptom)", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.findIndex.call([10, 20, 30], (x: number) => x === 20);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("findIndex.call returns -1 when absent", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.findIndex.call([10, 20, 30], (x: number) => x === 99);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("find.call returns the matching element", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.find.call([10, 20, 30], (x: number) => x === 20) as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf.call finds a dense element", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.indexOf.call([10, 20, 30], 20);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes.call reports membership", async () => {
    // Coerced to number — a Wasm export marshals a boolean as i32 (1/0), so an
    // `Object.is(1, true)` comparison in the equivalence harness would
    // false-fail on a return-marshaling artifact unrelated to #2177's element
    // read. The `? 1 : 0` projection asserts the element read + comparison are
    // correct without tripping that artifact.
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.includes.call([10, 20, 30], 20) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes.call reports absence", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.includes.call([10, 20, 30], 99) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("forEach.call visits every element in order", async () => {
    await assertEquivalent(
      `export function test(): number {
        let s = 0;
        Array.prototype.forEach.call([10, 20, 30], (x: number) => { s += x; });
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("every.call short-circuits correctly", async () => {
    // `? 1 : 0` — see the includes.call note on boolean return marshaling.
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.every.call([10, 20, 30], (x: number) => x >= 10) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("every.call returns false when an element fails the predicate", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.every.call([10, 20, 30], (x: number) => x > 15) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("some.call short-circuits correctly", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.some.call([10, 20, 30], (x: number) => x === 30) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("some.call returns false when no element matches", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Array.prototype.some.call([10, 20, 30], (x: number) => x === 999) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("map.call returns a fresh transformed array (sum the result)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const doubled = Array.prototype.map.call([10, 20, 30], (x: number) => x * 2) as number[];
        let s = 0;
        for (let i = 0; i < doubled.length; i++) s += doubled[i];
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("filter.call retains matching elements (sum the result)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const kept = Array.prototype.filter.call([10, 20, 30], (x: number) => x > 15) as number[];
        let s = 0;
        for (let i = 0; i < kept.length; i++) s += kept[i];
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  // --- receiver shapes beyond the array literal -------------------------------

  it("findIndex.call on a typed number[] variable", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a: number[] = [10, 20, 30];
        return Array.prototype.findIndex.call(a, (x: number) => x === 20);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf.call on a typed number[] variable", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a: number[] = [10, 20, 30];
        return Array.prototype.indexOf.call(a, 30);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("findIndex.call on an any-typed array", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a: any = [10, 20, 30];
        return Array.prototype.findIndex.call(a, (x: number) => x === 20);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("indexOf.call on an open-object numeric-key array-like", async () => {
    // {0:..,1:..,2:..,length:3} — an open-object struct with integer-named
    // props, NOT a $Vec. Reads through the per-field getter path; this is the
    // #2177b candidate, confirmed working alongside the $Vec read.
    await assertEquivalent(
      `export function test(): number {
        const o: any = { 0: 10, 1: 20, 2: 30, length: 3 };
        return Array.prototype.indexOf.call(o, 20);
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
