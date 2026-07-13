// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3237 Slice 1 — any-receiver dispatch for the native DisposableStack `dispose`
// method + `disposed` accessor. The test262 runner hoists a nested-closure-
// captured `var stack = new DisposableStack()` to `let stack: any`, so
// `stack.dispose()` / `stack.disposed` lose the nominal `DisposableStack` symbol.
// Before this slice `dispose` on an `any` receiver first-match-bound the
// `DisposableStack_dispose` HOST import (unsatisfiable standalone → the module
// failed to instantiate), and `disposed` fell to the generic `__extern_get` reader
// (a miss on the native struct → always false, silently wrong after dispose).
//
// Slice 1 dispatches on the RUNTIME shape (`ref.test $DisposableStack`): match →
// the native op; miss → a clean TypeError (dispose) / the generic read (disposed).
// The callback methods (`defer`/`adopt`/`use`) are Slice 2.

const HOST_LEAK_RE = /DisposableStack_|__make_callback/;

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((n) => HOST_LEAK_RE.test(n));
  expect(leaks).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3237 slice 1 — any-receiver DisposableStack dispose/disposed", () => {
  it("dispose() on an any-typed receiver is host-free and flips disposed", async () => {
    // The receiver is `any`, so the nominal className arm never fires.
    expect(
      await runStandalone(
        `export function f(): number { let s: any = new DisposableStack(); s.dispose(); return s.disposed ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("disposed accessor on an any receiver reads the real flag before/after dispose", async () => {
    // sets-state-to-disposed.js shape: read `.disposed` before and after dispose.
    expect(
      await runStandalone(
        `export function f(): number {
           let s: any = new DisposableStack();
           let wasDisposed = s.disposed;
           s.dispose();
           let isDisposed = s.disposed;
           return (!wasDisposed && isDisposed) ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("dispose() on an any receiver returns undefined (value position)", async () => {
    // returns-undefined.js: `assert.sameValue(stack.dispose(), undefined)`.
    expect(
      await runStandalone(
        `export function f(): number { let s: any = new DisposableStack(); let u = s.dispose(); return (u === undefined) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("dispose() on an any receiver is idempotent; disposed stays true", async () => {
    // does-not-throw-if-already-disposed.js: dispose twice, no throw.
    expect(
      await runStandalone(
        `export function f(): number { let s: any = new DisposableStack(); s.dispose(); s.dispose(); return s.disposed ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("a fresh stack read through an any receiver is not disposed", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let s: any = new DisposableStack(); return s.disposed ? 1 : 0; }`,
      ),
    ).toBe(0);
  });

  // ── Regression guards: the fix must NOT hijack non-DisposableStack receivers ──

  it("a user object's dispose() on an any receiver still routes to the closed-struct method", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let o: any = { dispose() { return 5; } }; return o.dispose(); }`,
      ),
    ).toBe(5);
  });

  it("a user object's dispose() on an any receiver still works when DisposableStack is also present", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
           let d = new DisposableStack(); d.dispose();
           let o: any = { dispose() { return 7; } };
           return o.dispose();
         }`,
      ),
    ).toBe(7);
  });

  it("a user object's own disposed property on an any receiver still resolves (truthy)", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
           let d = new DisposableStack();
           let o: any = { disposed: true };
           return o.disposed ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("a user object's own disposed property (false) on an any receiver still resolves (falsy)", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
           let d = new DisposableStack();
           let o: any = { disposed: false };
           return o.disposed ? 1 : 0;
         }`,
      ),
    ).toBe(0);
  });

  it("the typed (nominal) dispose/disposed path is unchanged", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); s.dispose(); return s.disposed ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("dispose() in value position === undefined (undefined singleton, not raw null)", async () => {
    // returns-undefined.js: the value handed back must compare `=== undefined`.
    expect(
      await runStandalone(
        `export function f(): number { let s: any = new DisposableStack(); let u = s.dispose(); return (u === undefined) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});

// #3237 Slice 2 — the callback methods `defer(cb)` / `adopt(value, cb)` /
// `use(value)` on an `any` receiver. Before this slice these first-match-bound the
// `DisposableStack_defer` / `_adopt` / `_use` HOST imports (unsatisfiable
// standalone → module fails to instantiate before dispose runs) — the residual
// leak of the dispose/defer cluster the #3234 SuppressedError aggregation was a
// prerequisite for. Slice 2 routes them through the native append/use substrate
// guarded by `ref.test $DisposableStack` (miss → clean TypeError, never the
// import; the `defer`/`adopt` callbacks compile as native closures via #3235).

describe("#3237 slice 2 — any-receiver DisposableStack defer/adopt/use", () => {
  it("defer(cb) on an any receiver runs its callback at dispose (LIFO), host-free", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
           let log = 0;
           let s: any = new DisposableStack();
           s.defer(() => { log = log * 10 + 1; });
           s.defer(() => { log = log * 10 + 2; });
           s.dispose();
           return log; }`,
      ),
    ).toBe(21); // LIFO: the second-deferred callback runs first
  });

  it("defer() in value position returns undefined (=== undefined)", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let s: any = new DisposableStack(); let u = s.defer(() => {}); s.dispose(); return (u === undefined) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("adopt(value, cb) on an any receiver returns the value and disposes it, host-free", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
           let seen = 0;
           let s: any = new DisposableStack();
           let ret = s.adopt(7, (v: number) => { seen = v; });
           s.dispose();
           return ret * 100 + seen; }`,
      ),
    ).toBe(707); // ret === 7 (value returned); callback saw value 7 at dispose
  });

  it("use(value) on an any receiver runs value[Symbol.dispose]() at dispose, host-free", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
           let d = 0;
           let s: any = new DisposableStack();
           let res: any = { [Symbol.dispose]() { d = 1; } };
           s.use(res);
           s.dispose();
           return d; }`,
      ),
    ).toBe(1);
  });

  it("use(null) on an any receiver returns the value and adds no resource (no throw)", async () => {
    // allows-null-value.js / returns-value.js: null/undefined value → return value.
    expect(
      await runStandalone(
        `export function f(): number { let s: any = new DisposableStack(); let u = s.use(null); s.dispose(); return (u === null) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("defer disposers run in reverse order after use + adopt (dispose cluster shape)", async () => {
    // disposes-resources-in-reverse-order.js shape across all three registrars.
    expect(
      await runStandalone(
        `export function f(): number {
           let log = 0;
           let s: any = new DisposableStack();
           s.defer(() => { log = log * 10 + 1; });
           s.adopt(0, () => { log = log * 10 + 2; });
           let res: any = { [Symbol.dispose]() { log = log * 10 + 3; } };
           s.use(res);
           s.dispose();
           return log; }`,
      ),
    ).toBe(321); // LIFO: use(3) first, then adopt(2), then defer(1)
  });

  // ── Regression guards: the fix must NOT hijack non-DisposableStack receivers ──

  it("a user object's own defer() on an any receiver still routes to the closed-struct method", async () => {
    // The #3033 user-function-member refusal fires before the any-receiver native
    // dispatch, so a user object with its own `defer` keeps the #2151 path.
    expect(
      await runStandalone(
        `export function f(): number {
           let d = new DisposableStack(); d.dispose();
           let o: any = { defer() { return 9; } };
           return o.defer(); }`,
      ),
    ).toBe(9);
  });

  it("the typed (nominal) defer/adopt/use path is unchanged", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
           let log = 0;
           const s = new DisposableStack();
           s.defer(() => { log = log * 10 + 1; });
           s.adopt(0, () => { log = log * 10 + 2; });
           s.dispose();
           return log; }`,
      ),
    ).toBe(21);
  });
});
