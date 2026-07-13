// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3231 — Wasm-native DisposableStack (sync) for standalone / WASI targets.
// The class ctor + use/adopt/defer/move/dispose/disposed were host imports
// (DisposableStack_*). This slice makes construct / disposed / defer / adopt /
// dispose (LIFO) / move / disposed-throw / host-free. `use()` (dynamic
// [Symbol.dispose] lookup) + SuppressedError aggregation + AsyncDisposableStack
// are follow-ups.

const HOST_LEAK_RE = /DisposableStack_|__make_callback/;

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No DisposableStack host-import / host-callback leak.
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((n) => HOST_LEAK_RE.test(n));
  expect(leaks).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3231 native standalone DisposableStack", () => {
  it("constructs host-free; a fresh stack is not disposed", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); return s.disposed ? 1 : 0; }`,
      ),
    ).toBe(0);
  });

  it("dispose() flips the disposed flag", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); s.dispose(); return s.disposed ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("defer() registers a callback dispose() runs", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack(); s.defer(() => { n = 7; }); s.dispose(); return n; }`,
      ),
    ).toBe(7);
  });

  it("runs deferred disposers in LIFO order", async () => {
    // A pushed first, B second → B runs first: n = 0*10+2 = 2, then A: 2*10+1 = 21.
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack(); s.defer(() => { n = n*10+1; }); s.defer(() => { n = n*10+2; }); s.dispose(); return n; }`,
      ),
    ).toBe(21);
  });

  it("adopt(value, onDispose) invokes onDispose(value) at dispose", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack(); s.adopt(3, (v) => { n = v; }); s.dispose(); return n; }`,
      ),
    ).toBe(3);
  });

  it("dispose() is idempotent — disposers run once", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack(); s.defer(() => { n = n + 1; }); s.dispose(); s.dispose(); return n; }`,
      ),
    ).toBe(1);
  });

  it("grows the backing array past the initial capacity (>4 disposers)", async () => {
    // Five distinct defers exceed the initial capacity (4), exercising the
    // array.copy grow path. (Registering disposers inside a loop is a separate
    // loop-scoped-closure limitation — a Phase 1b follow-up.)
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack();
         s.defer(() => { n = n + 1; }); s.defer(() => { n = n + 1; }); s.defer(() => { n = n + 1; });
         s.defer(() => { n = n + 1; }); s.defer(() => { n = n + 1; }); s.dispose(); return n; }`,
      ),
    ).toBe(5);
  });

  it("move() transfers disposers to a new stack and disposes the source", async () => {
    // n=5 runs on the moved stack; source is disposed (a=1) → 5*10+1 = 51.
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack(); s.defer(() => { n = 5; }); const t = s.move(); const a = s.disposed ? 1 : 0; t.dispose(); return n*10+a; }`,
      ),
    ).toBe(51);
  });

  it("throws ReferenceError on defer after dispose", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); s.dispose(); try { s.defer(() => {}); return 0; } catch (e) { return e instanceof ReferenceError ? 2 : 1; } }`,
      ),
    ).toBe(2);
  });

  it("throws ReferenceError on move after dispose", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); s.dispose(); try { s.move(); return 0; } catch (e) { return e instanceof ReferenceError ? 2 : 1; } }`,
      ),
    ).toBe(2);
  });
});

describe("#3231 Phase 1b — use() dynamic [Symbol.dispose] lookup (host-free)", () => {
  it("use(resource) runs the resource's [Symbol.dispose] at dispose", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack(); s.use({ [Symbol.dispose]() { n = 9; } }); s.dispose(); return n; }`,
      ),
    ).toBe(9);
  });

  it("binds the disposer's `this` to the used value", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let g = 0; const s = new DisposableStack(); const r = { v: 3, [Symbol.dispose]() { g = this.v; } }; s.use(r); s.dispose(); return g; }`,
      ),
    ).toBe(3);
  });

  it("use(null) / use(undefined) are no-ops that add no resource", async () => {
    expect(
      await runStandalone(
        `export function f(): number { let n = 0; const s = new DisposableStack(); s.use(null); s.use(undefined); s.defer(() => { n = 5; }); s.dispose(); return n; }`,
      ),
    ).toBe(5);
  });

  it("interleaves use/adopt/defer disposers in LIFO order", async () => {
    // use→resource(1) first, adopt(2), defer(3); dispose LIFO → defer(3),adopt(2),use(1).
    expect(
      await runStandalone(
        `export function f(): number { const order: number[] = []; const s = new DisposableStack();
         s.use({ [Symbol.dispose]() { order.push(1); } });
         s.adopt({}, () => order.push(2));
         s.defer(() => order.push(3));
         s.dispose();
         return order[0]*100 + order[1]*10 + order[2]; }`,
      ),
    ).toBe(321);
  });

  it("throws TypeError when the value is not an object", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); try { s.use(true as any); return 0; } catch (e) { return e instanceof TypeError ? 2 : 1; } }`,
      ),
    ).toBe(2);
  });

  it("throws TypeError when the value has no [Symbol.dispose]", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); try { s.use({} as any); return 0; } catch (e) { return e instanceof TypeError ? 2 : 1; } }`,
      ),
    ).toBe(2);
  });

  it("throws TypeError when [Symbol.dispose] is null", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); try { s.use({ [Symbol.dispose]: null } as any); return 0; } catch (e) { return e instanceof TypeError ? 2 : 1; } }`,
      ),
    ).toBe(2);
  });

  it("throws ReferenceError on use() after dispose — even for use(undefined)", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const s = new DisposableStack(); s.dispose(); try { s.use(undefined); return 0; } catch (e) { return e instanceof ReferenceError ? 2 : 1; } }`,
      ),
    ).toBe(2);
  });
});

describe("#3231 host lane unchanged (byte-identical gate)", () => {
  it("gc/host mode still routes DisposableStack through host imports", async () => {
    const r = await compile(
      `export function f(): number { const s = new DisposableStack(); s.defer(() => {}); s.dispose(); return 0; }`,
      {},
    );
    expect(r.success).toBe(true);
    const names = r.imports.map((i) => i.name);
    expect(names).toContain("DisposableStack_new");
    expect(names).toContain("DisposableStack_dispose");
  });

  it("gc/host mode still routes use() through the DisposableStack_use host import", async () => {
    const r = await compile(
      `export function f(): number { const s = new DisposableStack(); s.use({ [Symbol.dispose]() {} }); return 0; }`,
      {},
    );
    expect(r.success).toBe(true);
    expect(r.imports.map((i) => i.name)).toContain("DisposableStack_use");
  });
});
