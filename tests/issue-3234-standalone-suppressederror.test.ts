// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3234 — Wasm-native SuppressedError multi-error aggregation in the standalone
// DisposableStack dispose driver (#3231 Phase 1b follow-up). When more than one
// disposer throws, `dispose()` must run EVERY disposer and chain the errors into
// nested native SuppressedError instances (LIFO: `.error` = the newer error,
// `.suppressed` = the accumulated prior), then rethrow the aggregate — host-free.
//
// Also makes `instanceof SuppressedError` and the `.error`/`.suppressed`
// accessors resolve natively (no `SuppressedError_get_error` / `__instanceof`
// host imports) via the SuppressedError builtin tag + `$Error_struct.$props`.

// Any leak of these host imports means the SuppressedError path is not native.
const HOST_LEAK_RE =
  /DisposableStack_|__make_callback|SuppressedError_get|__new_SuppressedError|__instanceof|__get_caught_exception/;

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((n) => HOST_LEAK_RE.test(n));
  expect(leaks).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

async function importsOf(src: string): Promise<string[]> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r.imports.map((i) => `${i.module}::${i.name}`);
}

describe("#3234 standalone SuppressedError aggregation", () => {
  it("nests multiple disposer errors into SuppressedError (LIFO, spec §DisposeResources)", async () => {
    // 3 defers, each throws. LIFO: d3(error3) first, d2(error2), d1(error1) last.
    // Aggregate = SuppressedError{error: error1, suppressed: SuppressedError{error: error2, suppressed: error3}}.
    // code bits: 1=instanceof, 2=e.error===error1, 4=e.suppressed instanceof SE,
    //            8=inner.error===error2, 16=inner.suppressed===error3 → 31.
    expect(
      await runStandalone(`
        export function f(): number {
          class MyError extends Error {}
          const error1 = new MyError();
          const error2 = new MyError();
          const error3 = new MyError();
          const stack = new DisposableStack();
          stack.defer(() => { throw error1; });
          stack.defer(() => { throw error2; });
          stack.defer(() => { throw error3; });
          let code = 0;
          try { stack.dispose(); code = 100; }
          catch (e) {
            if (e instanceof SuppressedError) code += 1;
            const se = e as SuppressedError;
            if (se.error === error1) code += 2;
            if (se.suppressed instanceof SuppressedError) code += 4;
            const inner = se.suppressed as SuppressedError;
            if (inner.error === error2) code += 8;
            if (inner.suppressed === error3) code += 16;
          }
          return code;
        }`),
    ).toBe(31);
  });

  it("rethrows a single disposal error as-is (not wrapped in SuppressedError)", async () => {
    // 2=e===error1 (identity preserved); +1 would mean wrongly wrapped.
    expect(
      await runStandalone(`
        export function f(): number {
          class MyError extends Error {}
          const error1 = new MyError();
          const stack = new DisposableStack();
          stack.defer(() => { throw error1; });
          let code = 0;
          try { stack.dispose(); code = 100; }
          catch (e) {
            if (e instanceof SuppressedError) code += 1;
            if (e === error1) code += 2;
          }
          return code;
        }`),
    ).toBe(2);
  });

  it("runs every disposer even when a prior one throws", async () => {
    // d2 throws but d1 must still run (it flips `ran`). LIFO: d2 first (throws),
    // then d1 (sets ran=1). Aggregate rethrown; caught. Expect ran=1.
    expect(
      await runStandalone(`
        export function f(): number {
          let ran = 0;
          const e2 = new Error();
          const stack = new DisposableStack();
          stack.defer(() => { ran = 1; });      // pushed first -> runs LAST
          stack.defer(() => { throw e2; });     // pushed second -> runs FIRST, throws
          try { stack.dispose(); } catch (e) {}
          return ran;
        }`),
    ).toBe(1);
  });

  it("aggregates two errors: outermost .error is the last-run disposer's error", async () => {
    // defer(e1) first, defer(e2) second. LIFO: e2 runs first, e1 last.
    // Aggregate = SuppressedError{error: e1, suppressed: e2}. 1+2+4 = 7.
    expect(
      await runStandalone(`
        export function f(): number {
          class MyError extends Error {}
          const e1 = new MyError();
          const e2 = new MyError();
          const stack = new DisposableStack();
          stack.defer(() => { throw e1; });
          stack.defer(() => { throw e2; });
          let code = 0;
          try { stack.dispose(); }
          catch (e) {
            if (e instanceof SuppressedError) code += 1;
            const se = e as SuppressedError;
            if (se.error === e1) code += 2;
            if (se.suppressed === e2) code += 4;
          }
          return code;
        }`),
    ).toBe(7);
  });

  it("emits no SuppressedError / instanceof / DisposableStack host imports", async () => {
    const imports = await importsOf(`
      export function f(): number {
        class MyError extends Error {}
        const e1 = new MyError();
        const e2 = new MyError();
        const stack = new DisposableStack();
        stack.defer(() => { throw e1; });
        stack.defer(() => { throw e2; });
        try { stack.dispose(); } catch (e) {
          if (e instanceof SuppressedError) { const se = e as SuppressedError; return (se.error === e1 ? 1 : 0) + (se.suppressed === e2 ? 2 : 0); }
        }
        return 0;
      }`);
    expect(imports.filter((n) => HOST_LEAK_RE.test(n))).toEqual([]);
  });
});

describe("#3234 host lane unchanged", () => {
  it("gc/host mode still routes DisposableStack / SuppressedError through host imports", async () => {
    const r = await compile(
      `export function f(): number {
        const e1 = new Error();
        const stack = new DisposableStack();
        stack.defer(() => { throw e1; });
        try { stack.dispose(); } catch (e) { if (e instanceof SuppressedError) return 1; }
        return 0;
      }`,
      { target: "gc" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Host mode keeps the host-import contract (no native dispose driver).
    const names = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(names.some((n) => /DisposableStack_/.test(n))).toBe(true);
  });
});
