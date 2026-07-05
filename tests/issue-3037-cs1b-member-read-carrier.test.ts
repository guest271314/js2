// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3037 CS1b (member-read family) — dynamic `any`-member READ carrier.
//
// CS1a made an object LITERAL produced into an `any` local reach `===` as a
// tag-6 `ref $Object` (identity). CS1b extends the carrier to a DYNAMIC read:
// when an `any`-typed member read (`o.a`, `o.n`, `d.value`) is a direct operand
// of a standalone `any === any` / `!==` / `==` / `!=` comparison, the reader's
// bare externref result is re-classified through the ALWAYS-honest
// `__any_from_extern_honest` classifier so it reaches `===` as a proper
// `$AnyValue`: object → tag-6 (identity in `refval`), `$BoxedNumber` → tag-3
// (value), `$BoxedBoolean` → tag-4, `$AnyString` → tag-5 (content).
//
// This flips CS0 FLIP-TARGETs (a) gOPD `.value`, (b) aliased-object member read,
// (e) dynamic-number self-identity — WITHOUT touching the generic `boxToAny`
// externref arm (−788) or the `===` operand seam (−299). The change is purely
// the reader's result ValType, gated to EXACTLY the shape that routes through
// `emitAnyEqOperands` (both operands `any`), so the carrier can only flow into
// the equality helper's `isAnyValue` fast-path — never into a subsequent
// read/store (which a `$AnyValue` local would break, the CS1a finding).
//
// This suite pins BOTH halves: the identity flips AND that the classification
// keeps strings/numbers/booleans correct and does not disturb non-`===`
// consumers of a member read (chained read, method call, arithmetic, typeof).

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

describe("#3037 CS1b — dynamic member-read identity flips", () => {
  it("(b) two member reads aliasing one object ARE ===", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const o: any = { a: inner, b: inner };
        return (o.a === o.b) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(a) two gOPD().value reads of one data property ARE ===", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; } };
        const d1: any = Object.getOwnPropertyDescriptor(p, "exec");
        const d2: any = Object.getOwnPropertyDescriptor(p, "exec");
        return (d1.value === d2.value) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("(e) a dynamically-read number IS === to a re-read (by value, tag-3)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { n: 42 };
        return (o.n === o.n) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("negation: aliased member reads are NOT !==", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const o: any = { a: inner, b: inner };
        return (o.a !== o.b) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("half-migrated pair reconciles via S3a (member read vs stored any local)", async () => {
    // `x` is an identifier operand (stays tag-5), `o.b` is a migrated member read
    // (tag-6). The mixed pair hits S3a's cross-tag reconciliation arm -> 1. Proves
    // partial coverage never regresses.
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const o: any = { a: inner, b: inner };
        const x: any = o.a;
        return (x === o.b) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS1b — anti-vacuity negatives (must stay 0)", () => {
  it("distinct objects of equal shape are NOT === via member reads", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { a: { z: 1 }, b: { z: 1 } };
        return (o.a === o.b) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("distinct gOPD .value functions are NOT ===", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; }, test: function () { return 2; } };
        const de: any = Object.getOwnPropertyDescriptor(p, "exec");
        const dt: any = Object.getOwnPropertyDescriptor(p, "test");
        return (de.value === dt.value) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("distinct numbers read dynamically are NOT ===", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { m: 42, n: 7 };
        return (o.m === o.n) ? 1 : 0;
      }`),
    ).toBe(0);
  });
});

describe("#3037 CS1b — classification correctness + non-=== consumers unaffected", () => {
  it("a dynamically-read string stays === by content (tag-5 intact)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { s: "ab" };
        return (o.s === o.s) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a dynamically-read string is === to a literal (content)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { s: "ab" };
        return (o.s === "ab") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a dynamically-read number is === to a literal (by value)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { n: 42 };
        return (o.n === 42) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a dynamically-read boolean is === to a literal (by value)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { b: true };
        return (o.b === true) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("typeof a dynamically-read string is still 'string'", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { s: "ab" };
        return (typeof o.s === "string") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a chained read off a member read still resolves (o.a.z)", async () => {
    // `o.a` here is NOT an equality operand — the carrier must NOT fire, so the
    // chained `.z` read still routes through `__extern_get` correctly.
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 7 };
        const o: any = { a: inner };
        return o.a.z;
      }`),
    ).toBe(7);
  });

  it("a member-read result used in arithmetic still unboxes to a number", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { n: 40 };
        return (o.n + 2);
      }`),
    ).toBe(42);
  });
});
