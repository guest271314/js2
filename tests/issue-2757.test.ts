import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2757 (partial) — clamp the vec-rest length in array assignment-destructuring.
//
// In `[a, b, ...r] = src` the rest array is sized `src.length - i` where `i` is
// the rest element's index (the count of preceding pattern elements). When the
// source vec has FEWER elements than that prefix (`src.length < i`), the count is
// NEGATIVE; `array.new_default` reads the size operand as UNSIGNED → it requests
// a ~4-billion-element array → "requested new array is too large" trap.
// `src/codegen/expressions/assignment.ts` now floors the count at 0, so a
// short/empty source yields an EMPTY rest array instead of trapping.
//
// NOTE: this is the partial (trap-hardening) slice of #2757. The remaining work
// (object-pattern rest target `[...{0:x,length}] = vals`, and the OOB non-rest
// element → `undefined` value, and tuple-source rest) is tracked in the #2757
// issue file. These tests pin ONLY the clamp's contract.
describe("#2757 array assignment-destructuring rest-length clamp", () => {
  it("does not trap when the vec source is shorter than the non-rest prefix", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let src: any[] = [1];
        let a: any, b: any, r: any;
        [a, b, ...r] = src;        // prefix(2) > src.length(1): rest count -1 pre-clamp
        if (a !== 1) return 1;      // the present element still reads
        if (!Array.isArray(r)) return 2;
        if (r.length !== 0) return 3; // clamped to an empty rest — no trap
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });

  it("still collects the tail for a normal rest", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let src: any[] = [1, 2, 3];
        let a: any, r: any;
        [a, ...r] = src;
        if (a !== 1) return 1;
        if (r.length !== 2 || r[0] !== 2 || r[1] !== 3) return 2;
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });
});

// #2757 — object/array/member rest TARGETS in array assignment-destructuring.
//
// Previously the array-rest branch only handled an IDENTIFIER rest target
// (`[a, ...r] = x`); an object-pattern, array-pattern or member-expression rest
// target silently dropped every binding. The collected rest vec is now bound by
// dispatching on the target kind, with array-like semantics for an object
// pattern (numeric key → element index, `length` → vec length). Mirrors the
// test262 `language/expressions/assignment/dstr/array-rest-nested-*` cluster.
describe("#2757 array assignment-destructuring non-identifier rest targets", () => {
  it("object-pattern rest: numeric key + length (array-rest-nested-obj-undefined-own)", async () => {
    // `[...{ 0: x, length }] = [undefined]` ⇒ x === undefined, length === 1
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = null;
        let length: any;
        let vals: any[] = [undefined];
        [...{ 0: x, length }] = vals;
        if (x !== undefined) return 1;
        if (length !== 1) return 2;
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });

  it("object-pattern rest: hole reads undefined (array-rest-nested-obj-undefined-hole)", async () => {
    // `[...{ 0: x, length }] = [ , ]` ⇒ x === undefined, length === 1
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = null;
        let length: any;
        let vals: any[] = [ , ];
        [...{ 0: x, length }] = vals;
        if (x !== undefined) return 1;
        if (length !== 1) return 2;
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });

  it("object-pattern rest: numeric index binds the element (array-rest-nested-obj)", async () => {
    // `[...{ 1: x }] = [1, 2, 3]` ⇒ x === 2
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any;
        let vals: any[] = [1, 2, 3];
        [...{ 1: x }] = vals;
        if (x !== 2) return 1;
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });

  it("array-pattern rest target binds nested elements (array-rest-nested-array)", async () => {
    // `[...[x]] = [1, 2, 3]` ⇒ x === 1
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any;
        let vals: any[] = [1, 2, 3];
        [...[x]] = vals;
        if (x !== 1) return 1;
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });
});

// #2757 (CI-fix, PR #2224 merge-group park) — nested array-pattern rest target
// over a source whose only element is `undefined` (explicit or a hole). Both
// cases emitted INVALID Wasm, caught only in the merge group:
//   (a) `array-rest-nested-array-undefined-own.js` (`vals = [undefined]`): the
//       nested-pattern identifier bind DOUBLE-coerced the element — a manual
//       `coerceType(elemType → localType)` then `emitCoercedLocalSet` (which
//       coerces again) → `f64.convert_i32_s` on an externref. Fixed by dropping
//       the redundant pre-coerce (`emitCoercedLocalSet` already coerces).
//   (b) `array-rest-nested-array-undefined-hole.js` (`vals = [ , ]`): the nested
//       pattern's null guard ran `buildDestructureNullThrow`, adding a LATE
//       `string_constants` import global that shifted every module-global index;
//       a `$Hole` `global.get` emitted earlier for the hole literal went one slot
//       stale → `extern.convert_any` on an i32 global. The rest vec is freshly
//       `struct.new`'d (provably non-null), so the guard is now skipped.
// These pin the *invalid-Wasm* regression specifically: `compileToWasm` runs
// `WebAssembly.validate` on the binary and throws on an invalid module, so a
// successful compile+run is exactly the contract both defects broke (the
// value-level `x === undefined` semantics are already covered by the flipped
// `language/expressions/assignment/dstr/array-rest-nested-array-undefined-*`
// test262 files; host-side `undefined` marshaling is representation-dependent
// and orthogonal to this fix).
describe("#2757 nested array-pattern rest over an undefined/hole source", () => {
  it("compiles to valid Wasm and runs for an explicit `[undefined]` source (own)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = null;
        let vals: any[] = [undefined];
        let result: any = ([...[x]] = vals);
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });

  it("compiles to valid Wasm and runs for a hole `[ , ]` source", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = null;
        let vals: any[] = [ , ];
        let result: any = ([...[x]] = vals);
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });

  it("compiles to valid Wasm and runs for an empty `[]` source", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = 7;
        let vals: any[] = [];
        [...[x]] = vals;
        return 0;
      }`);
    expect((exports as { test: () => number }).test()).toBe(0);
  });
});
