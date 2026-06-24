// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2045 B.3 / B.4 — linear `Uint8Array` (WASI) escape-analysis demotion gaps.
 *
 * The #1886 Slice-C param rewrite (`Uint8Array` params become `(ptr,len)`)
 * seeds every top-level helper's `Uint8Array` param as linear-safe, but never
 * runs the inverse demotion checks. Two valid-WASI-program regressions resulted:
 *
 *  - **B.4 — function-value escape.** Only a *direct* call `fill(a, v)` threads
 *    the `(ptr,len)` ABI. `const g = fill; g(a, v)` (and `fill.call(...)`,
 *    `arr.map(fill)`, `[fill]`, `return fill`, …) reaches the function value
 *    through its *source-level* GC signature while the body was rewritten to
 *    linear params → a GC array lands in the linear slot → runtime
 *    "dereferencing a null pointer". Fix: demote a helper's params when its name
 *    appears in any non-direct-call position.
 *  - **B.3 — untracked argument.** A call site that passes a buffer the analysis
 *    cannot prove linear-backed — a function result `make()`, a `new
 *    Uint8Array(arrayBuffer)` *view*, a conditional `c ? a : b` — left the
 *    callee param linear-safe, then codegen hit "linear Uint8Array helper
 *    argument is not backed by linear memory (#1886)". Fix: demote a callee
 *    param that receives a non-linear-backed argument; gate the linear-local
 *    seed to the FRESH-arena ctor (length / array-literal / zero-arg), excluding
 *    the view ctor.
 *
 * Both fixes are pure analysis demotion: the affected helper/param routes back
 * to the already-correct GC `array.get`/`array.set` lowering. A pure-linear
 * helper still takes the fast `(ptr,len)` path (no over-demotion).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileWasi(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

/** Instantiate a WASI module and call its `main`/`_start`, returning the result. */
async function runWasiMain(binary: Uint8Array): Promise<number> {
  const module = await WebAssembly.compile(binary);
  const memRef: { value?: WebAssembly.Memory } = {};
  const view = () => new DataView(memRef.value!.buffer);
  const wasi = {
    fd_read: () => 0,
    fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovsPtr + i * 8 + 4, true);
      dv.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    proc_exit: () => {
      throw new Error("__proc_exit");
    },
  };
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  memRef.value = exports.memory as WebAssembly.Memory;
  const entry = (exports.main ?? exports._start) as undefined | (() => number);
  if (!entry) throw new Error("no main/_start export");
  return entry() ?? 0;
}

const compileAndRun = async (src: string): Promise<number> => runWasiMain(await compileWasi(src));

describe("#2045 B.4 — function-value escape of a linear-rewritten helper", () => {
  it("`const g = fill; g(a, 5)` compiles + runs (helper demoted, no null deref)", async () => {
    const src = `
      function fill(b: Uint8Array, v: number): void { b[0] = v; }
      export function main(): number {
        const g = fill;
        const a = new Uint8Array(4);
        g(a, 5);
        return a[0];
      }`;
    expect(await compileAndRun(src)).toBe(5);
  });

  it("`fill.call(null, a, 7)` compiles + runs (call-property escape)", async () => {
    const src = `
      function fill(b: Uint8Array, v: number): void { b[0] = v; }
      export function main(): number {
        const a = new Uint8Array(4);
        fill.call(null, a, 7);
        return a[0];
      }`;
    expect(await compileAndRun(src)).toBe(7);
  });

  it("`[fill]` array-literal escape still compiles (helper demoted)", async () => {
    const src = `
      function fill(b: Uint8Array, v: number): void { b[0] = v; }
      export function main(): number {
        const fns = [fill];
        const a = new Uint8Array(4);
        fns[0](a, 9);
        return a[0];
      }`;
    expect(await compileAndRun(src)).toBe(9);
  });

  it("direct self-recursion is NOT an escape (helper stays linear, runs)", async () => {
    const src = `
      function fillUpTo(b: Uint8Array, i: number, v: number): void {
        if (i < 0) return;
        b[i] = v;
        fillUpTo(b, i - 1, v);
      }
      export function main(): number {
        const a = new Uint8Array(4);
        fillUpTo(a, 3, 6);
        return a[0] + a[3];
      }`;
    expect(await compileAndRun(src)).toBe(12);
  });
});

describe("#2045 B.3 — callee param receiving a non-linear-backed argument", () => {
  it("`fill(make(), 7)` — function-result arg (helper demoted, no `not backed` error)", async () => {
    const src = `
      function make(): Uint8Array { return new Uint8Array(4); }
      function fill(b: Uint8Array, v: number): number { b[0] = v; return b[0]; }
      export function main(): number {
        return fill(make(), 7);
      }`;
    expect(await compileAndRun(src)).toBe(7);
  });

  it("`new Uint8Array(arrayBuffer)` view arg compiles + runs", async () => {
    const src = `
      function fill(b: Uint8Array, v: number): void { b[0] = v; }
      export function main(): number {
        const buf = new ArrayBuffer(4);
        const a = new Uint8Array(buf);
        fill(a, 9);
        return a[0];
      }`;
    expect(await compileAndRun(src)).toBe(9);
  });

  it("`fill(c ? a : b, 3)` — conditional arg compiles + runs", async () => {
    const src = `
      function fill(b: Uint8Array, v: number): void { b[0] = v; }
      export function main(): number {
        const a = new Uint8Array(4);
        const b = new Uint8Array(4);
        const c = true;
        fill(c ? a : b, 3);
        return (c ? a : b)[0];
      }`;
    expect(await compileAndRun(src)).toBe(3);
  });
});

describe("#2045 B.3/B.4 — no over-demotion of a pure-linear helper", () => {
  it("`fill(localBuf, v)` with a fresh-arena local still works (fast path retained)", async () => {
    const src = `
      function fill(b: Uint8Array, v: number): void { b[0] = v; }
      export function main(): number {
        const a = new Uint8Array(4);
        fill(a, 42);
        return a[0];
      }`;
    expect(await compileAndRun(src)).toBe(42);
  });
});
