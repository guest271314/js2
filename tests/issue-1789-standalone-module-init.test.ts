// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1789 — module-level const/let initializers must run before ANY exported
 * function in standalone / WASI mode, not just `_start`.
 *
 * Before this fix, `--target wasi` emitted `__module_init` only behind the
 * `_start` export (no Wasm `(start)` section). The test262 standalone harness
 * (and `WebAssembly.instantiate(bytes, {})`) calls exported functions like
 * `test()` directly WITHOUT `_start`, so a module-level `const o = {...}`
 * never initialized and reading it tripped its TDZ guard global → trap. This
 * was the root cause of the #1781 876-row "ToPrimitive / object-to-string"
 * standalone bucket (the coercion path was fine; the binding was uninitialized).
 *
 * Fix: `__module_init` is made idempotent (guarded by a fresh `__init_done`
 * global) and a `call __module_init` is prepended to every exported function,
 * so the first entry called — direct export OR `_start` — runs init exactly
 * once. Top-level side effects still fire on whichever entry runs first
 * (`_start` for WASI hosts), and never run twice (see wasi.test.ts for the
 * stdout-timing regression guard).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiateWasi(src: string): Promise<Record<string, unknown>> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // Empty import object — genuine standalone instantiation.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, unknown>;
}

describe("#1789 standalone module-init runs before exported functions", () => {
  it("reads a module-level const object (valueOf) from a direct export call without _start", async () => {
    const src = `const o = { valueOf() { return 42; } };
export function test(): number { return (o as any) * 1; }`;
    const ex = await instantiateWasi(src);
    // Direct call — no _start invoked first. Must not trap on the TDZ guard.
    expect((ex.test as () => number)()).toBe(42);
  });

  it("module-level top-level statements run exactly once (no double-init)", async () => {
    // counter starts 0, top-level bumps it by 5; valueOf returns the counter.
    // If init ran twice the counter would be 10.
    const src = `let counter = 0;
const o = { valueOf() { return counter; } };
counter = counter + 5;
export function test(): number { return (o as any) * 1; }`;
    const ex = await instantiateWasi(src);
    expect((ex.test as () => number)()).toBe(5);
  });

  it("calling _start first then a direct export still inits exactly once", async () => {
    const src = `let counter = 0;
const o = { valueOf() { return counter; } };
counter = counter + 5;
export function test(): number { return (o as any) * 1; }`;
    const ex = await instantiateWasi(src);
    if (typeof ex._start === "function") (ex._start as () => void)();
    expect((ex.test as () => number)()).toBe(5);
  });

  it("a plain numeric module const still works (constant-folded path unaffected)", async () => {
    const src = `const k = 7;
export function test(): number { return k + 1; }`;
    const ex = await instantiateWasi(src);
    expect((ex.test as () => number)()).toBe(8);
  });
});
