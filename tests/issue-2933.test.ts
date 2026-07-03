// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2933 — reflective `Math`/`Number` namespace static CONSTANT reads.
//
// Under `--target standalone`, a COMPUTED read of a namespace constant
// (`Math["PI"]`, `const k = "PI"; Math[k]`) previously returned `0`: the
// generic dynamic computed-read path cannot resolve a builtin-namespace member
// (the namespace has no `$Object` sidecar). We now fold a statically-resolvable
// computed key on `Math`/`Number` to the SAME `f64.const` the syntactic dot
// read (`Math.PI`) emits — host-free, and observationally identical to the
// host path. The value-as-function reads of Math/JSON/Reflect static METHODS
// (`const f = JSON.stringify; …`) remain tracked on #2933 (needs the
// value-closure wiring; the variadic `Math.max`-as-value split off separately).

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2933 reflective Math/Number namespace constant reads (standalone)", () => {
  it("folds Math['PI'] (string-literal key) to π", async () => {
    expect(await runStandalone(`export function test(): number { return Math["PI"]; }`)).toBe(Math.PI);
  });

  it("folds (Math as any)['PI'] through the as-cast", async () => {
    expect(await runStandalone(`export function test(): number { return (Math as any)["PI"]; }`)).toBe(Math.PI);
  });

  it("folds a const-resolvable key: const k = 'PI'; Math[k]", async () => {
    expect(await runStandalone(`export function test(): number { const k = "PI"; return (Math as any)[k]; }`)).toBe(
      Math.PI,
    );
  });

  it("folds Math['E']", async () => {
    expect(await runStandalone(`export function test(): number { return Math["E"]; }`)).toBe(Math.E);
  });

  it("folds Number['MAX_SAFE_INTEGER']", async () => {
    expect(await runStandalone(`export function test(): number { return Number["MAX_SAFE_INTEGER"]; }`)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("folds Number['EPSILON']", async () => {
    expect(await runStandalone(`export function test(): number { return Number["EPSILON"]; }`)).toBe(Number.EPSILON);
  });

  it("dot read Math.PI is unchanged (control)", async () => {
    expect(await runStandalone(`export function test(): number { return Math.PI; }`)).toBe(Math.PI);
  });

  it("leaves a runtime numeric array index untouched", async () => {
    expect(
      await runStandalone(`export function test(): number { const a = [10, 20, 30]; let i = 1; return a[i]; }`),
    ).toBe(20);
  });

  it("leaves a plain object computed read untouched", async () => {
    expect(await runStandalone(`export function test(): number { const o: any = { x: 5 }; return o["x"]; }`)).toBe(5);
  });
});
