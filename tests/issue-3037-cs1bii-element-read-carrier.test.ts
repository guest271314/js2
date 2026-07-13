// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3037 CS1b(ii) (element-access family) — dynamic `any`-element READ carrier.
//
// CS1b (member-read family) made `o.a === o.b` reach `===` as a tag-6 `$AnyValue`
// (object identity) by re-classifying an `any`-typed member READ through the
// ALWAYS-honest `__any_from_extern_honest` classifier when the read is a direct
// operand of a standalone `any === any` / `!==` / `==` / `!=` comparison. CS1b(ii)
// applies the SAME context-aware carrier at the ElementAccessExpression choke
// point (`arr[i] === arr[j]`, `o[key] === o[key2]`): the element reader's bare
// externref result is re-classified so it reaches `===` as a proper `$AnyValue`
// (object → tag-6 identity in `refval`, `$BoxedNumber` → tag-3 value,
// `$BoxedBoolean` → tag-4, `$AnyString` → tag-5 content).
//
// Two carrier-support fixes ride with this slice (both standalone-gated,
// byte-inert off-path — prove-emit-identity 39/39 IDENTICAL):
//
//   1. `isAnyEqualityOperand` mirrors binary-ops' EXACT gate — the raw checker
//      `getTypeAtLocation(op).flags & Any` on BOTH operands, not `ctx.oracle`.
//      The two DISAGREE for element operands: the oracle over-reports `a[0]` as
//      `any`, firing the carrier where binary-ops does NOT route through
//      `__any_strict_eq`.
//   2. binary-ops' raw `leftIsRef && rightIsRef` strict-eq arm routes a pair of
//      `$AnyValue` boxes to `__any_strict_eq` (tag-aware) instead of `ref.eq`
//      (struct identity) — because a discriminated `$AnyValue` union must compare
//      by TAG (number by value, string by content, object by `refval`), never by
//      fresh-struct identity. This keeps `const a: any = [5,5]; a[0] === a[1]`
//      correct even when the module registers `$AnyValue` lazily (via the carrier)
//      after binary-ops already chose its numeric path.
//
// Partial-coverage safe via S3a: a member/element read stored in a local first
// (`const x: any = a[0]; x === a[1]`) leaves `x` tag-5 and migrates only `a[1]`;
// the mixed tag-6 × tag-5 pair reconciles via S3a's cross-tag arm → still `1`.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Host-free: a leaked `env` import would mean the case silently ran on a JS
  // host fast-path and the result is not the standalone substrate's answer.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#3037 CS1b(ii) — dynamic element-read identity flips", () => {
  it("two element reads aliasing one object ARE === (any-holder array)", async () => {
    // The pivotal CS1b(ii) case: `a[0]` and `a[1]` read the ONE stored ref. Each
    // read boxed tag-5 twice → guarded same-tag arm → 0 on main; the honest
    // classifier now boxes tag-6 (identity) → the tag-6 `ref.eq` arm answers 1.
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 1 };
        const a: any = [inner, inner];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("aliased elements of an any[] array ARE ===", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 1 };
        const arr: any[] = [inner, inner];
        return (arr[0] === arr[1]) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("computed member access on an `any` object (o[key]) IS === when aliased", async () => {
    // `o["a"]` / `o["b"]` are ElementAccessExpressions (not property access) — the
    // CS1b(ii) choke point, distinct from the member-read family.
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 1 };
        const o: any = { a: inner, b: inner };
        return (o["a"] === o["b"]) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("negation: aliased element reads are NOT !==", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 1 };
        const a: any = [inner, inner];
        return (a[0] !== a[1]) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("half-migrated pair reconciles via S3a (element read vs stored any local)", async () => {
    // `x` is a stored any local (tag-5); `a[1]` migrates to tag-6. S3a's cross-tag
    // reconciliation arm makes the mixed pair still === → 1 (never a regression).
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 1 };
        const a: any = [inner, inner];
        const x: any = a[0];
        return (x === a[1]) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS1b(ii) — anti-vacuity negatives (must stay 0)", () => {
  it("distinct objects held in distinct any locals are NOT === via element reads", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { z: 1 };
        const q: any = { z: 1 };
        const a: any = [p, q];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("distinct object elements are correctly !==", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { z: 1 };
        const q: any = { z: 1 };
        const a: any = [p, q];
        return (a[0] !== a[1]) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS1b(ii) — value-tag classification stays correct (regression guards)", () => {
  // These are the fixes that ride with the carrier: a `$AnyValue` operand pair
  // must compare by TAG, not by fresh-struct `ref.eq` identity. Value-equal
  // numbers/strings read from an `any` array MUST stay ===.
  it("dynamically-read numbers are === by value (tag-3)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [5, 5];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("dynamically-read strings are === by content (tag-5)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const a: any = ["ab", "ab"];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a dynamically-read number IS === to a literal (by value)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [42];
        return (a[0] === 42) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("distinct numbers read from an any array are NOT === (anti-vacuity)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [5, 6];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("undefined / null / OOB element reads compare by value (undefined === undefined)", async () => {
    // The honest classifier maps a null externref to the undefined singleton;
    // undefined === undefined is spec-correct 1. Pins that the carrier does not
    // disturb genuine-undefined element semantics.
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [undefined, undefined];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(1);
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [1];
        return (a[5] === a[6]) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS1b(ii) — non-`===` consumers of an element read are unaffected", () => {
  it("an element-read result used in `===` does not break a following property read", async () => {
    // The carrier only fires on the direct `===` operand shape; a subsequent
    // `a[0].z` read still resolves through the ordinary externref path.
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 7 };
        const a: any = [inner, inner];
        const same = (a[0] === a[1]) ? 1 : 0;
        return same + a[0].z;
      }`),
    ).toBe(8);
  });

  it("an element read used in arithmetic still unboxes to a number", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const a: any = [10, 20];
        return a[0] * 100 + a[1];
      }`),
    ).toBe(1020);
  });

  it("a typed object array (no `any` annotation) keeps correct identity (control)", async () => {
    // No explicit `any` → operands are not TS-`any` → the carrier does NOT fire;
    // the ordinary typed-struct identity path answers correctly.
    expect(
      await runStandalone(`export function run(): number {
        var o = {};
        var a = [o, o];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(1);
    expect(
      await runStandalone(`export function run(): number {
        var a = [{}, {}];
        return (a[0] === a[1]) ? 1 : 0;
      }`),
    ).toBe(0);
  });
});
