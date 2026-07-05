// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3037 CS1a — object-literal-into-`any` tag-6 CARRIER (the beachhead slice).
//
// A spread-free, data-only object literal produced into a genuine
// `any`/`unknown`/`object` context under `--target standalone` is carried as a
// raw `ref $Object` local (statements/variables.ts +
// literals.ts `objectLiteralIsStandaloneAnyObjectCarrier`) instead of an
// externref. Consequence: at `===` the value boxes **tag-6** (`__any_box_ref`,
// identity in `refval`) so `__any_strict_eq`'s tag-6 same-tag `ref.eq` arm
// answers identity — WITHOUT touching the `===` operand seam (−299) or the
// generic externref boxing arm (−788). Dynamic `any`-typed member reads still
// work: they coerce the ref back to externref (`extern.convert_any`) for
// `__extern_get`.
//
// This suite pins BOTH halves: the identity FLIP (self-`===`, fn round-trip) and
// the NON-`===` consumer invariants (member read/write, method call, `typeof`,
// numeric field, distinct-object anti-vacuity) so a future change can't restore
// identity by breaking reads (the whole hazard of the carrier retype).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Host-free: a leaked env import would mean the case silently ran on a host
  // fast-path, not the standalone substrate.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#3037 CS1a — any-object-literal carrier: IDENTITY flips", () => {
  it("an any-typed object literal is === to itself", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const inner: any = { z: 1 };
        return (inner === inner) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("identity survives a round-trip through an any-typed function", async () => {
    expect(
      await runStandalone(`
        function id(x: any): any { return x; }
        export function run(): number {
          const o: any = { z: 3 };
          const p: any = id(o);
          return (p === o) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("a multi-field any object literal is === to itself", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { a: 1, b: 2, c: 3 };
        return (o === o) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3037 CS1a — anti-vacuity: distinct objects stay NOT ===", () => {
  it("two distinct any object literals are NOT ===", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { z: 1 };
        const q: any = { z: 1 };
        return (o === q) ? 1 : 0;
      }`),
    ).toBe(0);
  });
});

describe("#3037 CS1a — the carrier retype must NOT break non-=== consumers", () => {
  it("dynamic member read still works", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { z: 5 };
        return o.z;
      }`),
    ).toBe(5);
  });

  it("two dynamic member reads sum correctly", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { a: 4, b: 7 };
        return o.a + o.b;
      }`),
    ).toBe(11);
  });

  it("dynamic member WRITE then read works", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { z: 1 };
        o.z = 9;
        return o.z;
      }`),
    ).toBe(9);
  });

  it("method value on the carrier is callable", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { f: function () { return 42; } };
        return o.f();
      }`),
    ).toBe(42);
  });

  it("the carrier is typeof 'object'", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: any = { z: 1 };
        return (typeof o === "object") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("passing the carrier to an any param reads its field", async () => {
    expect(
      await runStandalone(`
        function readZ(x: any): number { return x.z; }
        export function run(): number {
          const o: any = { z: 8 };
          return readZ(o);
        }`),
    ).toBe(8);
  });

  it("a let carrier reassigned to a new object literal reads the new value", async () => {
    expect(
      await runStandalone(`export function run(): number {
        let o: any = { z: 1 };
        o = { z: 2 };
        return o.z;
      }`),
    ).toBe(2);
  });

  it("a typed struct local is unaffected (control)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const o: { z: number } = { z: 6 };
        return o.z;
      }`),
    ).toBe(6);
  });
});
