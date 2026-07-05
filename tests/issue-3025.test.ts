// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3025 W1 — Tier-1 `with` over a closed-struct-TYPED target.
//
// #1387 implemented the static (Tier-1) `with` path for object *literals*, and
// #2663 added the Tier-2 dynamic path (runtime HasBinding + Get) for everything
// else. But the Tier-2 path cannot see a WasmGC struct's fields — a struct
// wrapped `extern.convert_any` is opaque to host `in`/get reflection — so the
// overwhelmingly common `var o = { … }; with (o) { … }` pattern resolved every
// own-field read to a bare global → `ReferenceError: p1 is not defined`.
//
// W1 extends Tier-1 to a bare-identifier target whose static type resolves to a
// closed struct: it is compiled into a struct-typed local and bare-identifier
// reads/writes route to direct struct get/set. Conservative gates fall through to
// Tier-2 (never a compile error) for anything the static scope cannot model
// soundly: @@unscopables, dynamic element writes, `delete name`, inherited
// Object.prototype members, or non-single-object (`any`/union) types.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runWasm(src: string): Promise<any> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("Compile: " + r.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("#3025 — with over a closed-struct-typed variable (Tier-1)", () => {
  it("reads own fields of a struct-typed variable (the core fix)", async () => {
    expect(
      await runWasm(`export function test(): number {
        let out = 0;
        const o = { p1: 7, p2: 8 };
        with (o) { out = p1 + p2; }
        return out;
      }`),
    ).toBe(15);
  });

  it("routes a write to struct.set on the target object", async () => {
    expect(
      await runWasm(`export function test(): number {
        const o = { p1: 7, p2: 8 };
        with (o) { p1 = 100; }
        return o.p1 + o.p2;
      }`),
    ).toBe(108);
  });

  it("a compound assignment inside with mutates the struct field", async () => {
    expect(
      await runWasm(`export function test(): number {
        const o = { a: 1, b: 2, c: 3 };
        with (o) { a = a + b + c; }
        return o.a;
      }`),
    ).toBe(6);
  });

  it("a name that is not a field resolves to the outer binding", async () => {
    expect(
      await runWasm(`export function test(): number {
        let outer = 5;
        const o = { p1: 7 };
        let r = 0;
        with (o) { r = p1 + outer; }
        return r;
      }`),
    ).toBe(12);
  });

  it("mixed-type fields route to the correct field type", async () => {
    expect(
      await runWasm(`export function test(): number {
        const o = { n: 41, s: "x" };
        let r = 0;
        with (o) { r = n + 1; }
        return r;
      }`),
    ).toBe(42);
  });

  it("an OUTER struct scope resolves inside a nested with (partial nesting support)", async () => {
    // The OUTER `with (a)` takes the Tier-1 struct path, so `y` (only on `a`)
    // resolves to `a.y` even though it is referenced inside the inner `with (b)`.
    // (The INNER target `b` is typed `any` by the checker inside the outer `with`
    // body, so it stays on Tier-2 — full nested support arrives with the #3027
    // substrate reader. On `origin/main` this whole case throws ReferenceError.)
    expect(
      await runWasm(`export function test(): number {
        const a = { x: 1, y: 2 };
        const b = { z: 10 };
        let r = 0;
        with (a) { with (b) { r = y; } }
        return r;
      }`),
    ).toBe(2);
  });

  it("typeof of a present field is the field's type; absent is 'undefined'", async () => {
    expect(
      await runWasm(`export function test(): number {
        const o = { y: 1 };
        let r = 0;
        with (o) { r = (typeof y === "number" ? 1 : 0) + (typeof zzz === "undefined" ? 10 : 0); }
        return r;
      }`),
    ).toBe(11);
  });

  it("a let-declared local variable target also routes through Tier-1", async () => {
    expect(
      await runWasm(`export function test(): number {
        let o = { v: 21 };
        let r = 0;
        with (o) { r = v * 2; }
        return r;
      }`),
    ).toBe(42);
  });
});
