// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3037 CS1b(iii) (descriptor `.value`/`.get` producer family) — RE-PROBED.
//
// The task framed CS1b(iii) as "apply the same equality-operand carrier at the
// descriptor-`.value` choke point". Re-probing every descriptor `.value`/`.get`
// shape against current `upstream/main` (7eb51a2c5) DISPROVES that there is any
// remaining carrier-addressable descriptor-specific gap — mirroring how CS0
// disproved the "reader production site" premise and CS1a disproved the
// "`$AnyValue` carrier" premise. The measurement (this suite pins it):
//
//   * Every descriptor `.value`/`.get` read that is a DIRECT operand of a
//     standalone `any` `===`/`!==`/`==` comparison ALREADY answers identity
//     correctly (identical → 1, distinct → 1 under `!==`). Two paths cover it:
//       - the direct gOPD `Site-2` synthesis (`Object.getOwnPropertyDescriptor(
//         RegExp.prototype,"exec").value`) materialises the per-(brand,member)
//         SINGLETON (`pushBuiltinFnSingletonValueInstrs`), a raw `ref` → boxed
//         tag-6 → the tag-6 `ref.eq` arm answers identity with NO carrier needed;
//       - a user-object descriptor read (`Object.getOwnPropertyDescriptor(p,"m")
//         .value`) routes `.value` through the GENERIC `compilePropertyAccess`
//         member-read choke point, where the CS1b(i) member-read carrier
//         (`maybeWrapAnyReadEqualityCarrier`, expressions.ts:1356) already fires
//         because `.value` is a direct `any`-equality operand.
//     So descriptor `.value` as an equality operand was ABSORBED by CS1b(i)'s
//     placement at the generic choke point; there is no separate descriptor site
//     that returns a bare externref the carrier misses.
//
//   * The ONLY residual `0` in the descriptor family is when the `.value` result
//     is stored in an INTERMEDIATE `any` local and the LOCALS are compared
//     (`const v1: any = d.value; const v2: any = d.value; v1 === v2` → 0). This
//     is NOT descriptor-specific: a plain member read stored in a local
//     (`const v1: any = o.a; v1 === v2`) is identically 0. The operand-scoped
//     carrier CANNOT fix it — the equality operands are locals, not reads, and
//     the value must flow as a general `any` usable anywhere (a `$AnyValue`
//     local breaks dynamic reads — the CS1a finding). Canonicalising a reader
//     result INTO an `any` LOCAL (independent of downstream use) is the
//     UNIVERSAL-reader carrier = CS3 / V2-S3b (the −299 minefield), NOT a
//     bounded CS1b sub-slice. This suite pins the residual as a KNOWN-GAP so the
//     eventual CS3 flip is auditable and no accidental partial change re-breaks
//     the covered equality-operand cases in the process.
//
// This suite is BYTE-INERT (no `src/` change): `prove-emit-identity` stays 39/39
// IDENTICAL. It is a REGRESSION-LOCK, not a fix — the descriptor equality-operand
// coverage is real and must not silently regress if the member-read carrier or
// the gOPD Site-2 synthesis is later refactored.

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

describe("#3037 CS1b(iii) — descriptor `.value`/`.get` as a DIRECT equality operand (COVERED, lock at 1)", () => {
  it("direct gOPD(builtin).value === direct gOPD(builtin).value (Site-2 singleton) [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        return (Object.getOwnPropertyDescriptor(RegExp.prototype, "exec").value
              === Object.getOwnPropertyDescriptor(RegExp.prototype, "exec").value) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("direct gOPD(builtin).value === builtin.prototype.member (Site-2 ↔ member-read singleton) [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        return (Object.getOwnPropertyDescriptor(RegExp.prototype, "exec").value
              === RegExp.prototype.exec) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("direct gOPD(user-obj, function value).value self-=== (generic member-read carrier) [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; } };
        return (Object.getOwnPropertyDescriptor(p, "exec").value
              === Object.getOwnPropertyDescriptor(p, "exec").value) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("direct gOPD(user-obj, OBJECT value).value self-=== [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const p: any = { d: inner };
        return (Object.getOwnPropertyDescriptor(p, "d").value
              === Object.getOwnPropertyDescriptor(p, "d").value) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("stored-descriptor member read `d1.value === d2.value` (CS1b member-read, case a) [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; } };
        const d1: any = Object.getOwnPropertyDescriptor(p, "exec");
        const d2: any = Object.getOwnPropertyDescriptor(p, "exec");
        return (d1.value === d2.value) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("defineProperty accessor descriptor `.get` self-=== (direct operand) [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = {};
        Object.defineProperty(o, "x", { get: function () { return 1; }, configurable: true });
        return (Object.getOwnPropertyDescriptor(o, "x").get
              === Object.getOwnPropertyDescriptor(o, "x").get) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("descriptor `.value` passed through a comparator fn (harness shape, both descriptor) [1]", async () => {
    expect(
      await runStandalone(`
        function eq(a: any, b: any): number { return (a === b) ? 1 : 0; }
        export function run(): number {
          const p: any = { exec: function () { return 1; } };
          const d1: any = Object.getOwnPropertyDescriptor(p, "exec");
          const d2: any = Object.getOwnPropertyDescriptor(p, "exec");
          return eq(d1.value, d2.value);
        }`),
    ).toBe(1);
  });
});

describe("#3037 CS1b(iii) — anti-vacuity + boxed-value invariants (must NOT move)", () => {
  it("distinct descriptor `.value` (`exec` vs `test`) are NOT === [0]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; }, test: function () { return 2; } };
        const de: any = Object.getOwnPropertyDescriptor(p, "exec");
        const dt: any = Object.getOwnPropertyDescriptor(p, "test");
        return (de.value === dt.value) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("distinct descriptor `.value` under `!==` (direct operands) [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; }, test: function () { return 2; } };
        return (Object.getOwnPropertyDescriptor(p, "exec").value
              !== Object.getOwnPropertyDescriptor(p, "test").value) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("descriptor `.writable` (boolean) direct === stays value-correct [1]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { x: 1 };
        return (Object.getOwnPropertyDescriptor(p, "x").writable
              === Object.getOwnPropertyDescriptor(p, "x").writable) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS1b(iii) — the KNOWN-GAP: reader result stored in an `any` local (CS3-owned)", () => {
  // These are the residual `0`s. They are NOT descriptor-specific and NOT
  // addressable by the equality-operand carrier — the operands are LOCALS, not
  // reads. Canonicalising a reader result into an `any` local (independent of
  // downstream use) is the UNIVERSAL-reader carrier = CS3 / V2-S3b. Pinned at 0
  // so the eventual CS3 flip is auditable; a bounded CS1b change must NOT touch
  // these (that would be the −299 minefield re-entered).

  it("[KNOWN-GAP] descriptor `.value` stored in intermediate `any` locals then === [0 today]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const p: any = { exec: function () { return 1; } };
        const d1: any = Object.getOwnPropertyDescriptor(p, "exec");
        const v1: any = d1.value;
        const v2: any = d1.value;
        return (v1 === v2) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("[KNOWN-GAP/control] plain member read stored in `any` locals then === is IDENTICALLY 0", async () => {
    // Proves the residual is the GENERAL reader-into-local problem, not a
    // descriptor defect: the descriptor case above and this plain-read case share
    // one root cause (the universal-reader ValType change, CS3).
    expect(
      await runStandalone(`export function run(): number {
        const inner = { z: 1 };
        const o: any = { a: inner };
        const v1: any = o.a;
        const v2: any = o.a;
        return (v1 === v2) ? 1 : 0;
      }`),
    ).toBe(0);
  });
});
