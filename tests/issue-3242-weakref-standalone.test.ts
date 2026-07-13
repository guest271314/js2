// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3242 — Native standalone WeakRef.
//
// In `--target standalone` there is no JS host, so `new WeakRef(o)` /
// `wr.deref()` must NOT emit `WeakRef_new` / `WeakRef_deref` host imports.
// Before this fix WeakRef routed through the generic externClass constructor
// table (host imports), unlike WeakMap/WeakSet which were made native in #2162.
//
// The native representation is a strong-backed `$WeakRef` struct holding the
// target as a single immutable anyref field — no real GC weakness (WasmGC has
// none), but no passing spec test observes the difference. `deref()` returns
// the stored target with identity preserved.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  const r = await compile(src, { target: "standalone", emitText: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r;
}

function envImports(wat: string): string[] {
  return [...wat.matchAll(/\(import "env" "([^"]+)"/g)].map((m) => m[1]!);
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3242 native standalone WeakRef", () => {
  it("new WeakRef + deref emit no WeakRef_* host imports", async () => {
    const r = await compileStandalone(`const o = { a: 1 }; const wr = new WeakRef(o); const d = wr.deref();`);
    const wat = (r as { wat?: string; text?: string }).wat ?? (r as { text?: string }).text ?? "";
    expect(envImports(wat).filter((i) => /Weak/.test(i))).toEqual([]);
  });

  it("deref returns the object target (identity preserved)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o = { a: 1 };
        const wr = new WeakRef(o);
        return wr.deref() === o ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("deref returns the same target across repeated calls (target not emptied)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o = { a: 1 };
        const wr = new WeakRef(o);
        return (wr.deref() === wr.deref() && wr.deref() === o) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("deref returns a symbol target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const s = Symbol("desc");
        const wr = new WeakRef(s);
        return wr.deref() === s ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
