import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #2716 — The linear backend inlined a `try { … } finally { … }` as
// try-body-then-finally, so an early `return` / `break` / `continue` in the try
// jumped past the inlined finally and silently dropped its side effects. The fix
// replays the finally on every early-exit path (innermost first), and refuses
// loudly when the finally itself performs a return/break/continue.

async function runLinear(src: string): Promise<number> {
  const r = await compile(src, { target: "linear" });
  if (!r.success) throw new Error("compile failed: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary);
  return (instance.exports as { test: () => number }).test();
}

async function compileLinear(src: string) {
  return compile(src, { target: "linear" });
}

describe("#2716 linear try/finally runs finally on early exit", () => {
  it("finally runs on early return (observable side effect)", async () => {
    expect(
      await runLinear(`
      let flag = 0;
      function f(): number { try { return 1; } finally { flag = 9; } }
      export function test(): number { const r = f(); return r * 100 + flag; }
    `),
    ).toBe(109);
  });

  it("return value is captured before finally mutates the source global", async () => {
    expect(
      await runLinear(`
      let g = 0;
      function f(): number { try { return g + 1; } finally { g = 99; } }
      export function test(): number { const r = f(); return r * 100 + g; }
    `),
    ).toBe(199);
  });

  it("finally runs on break out of the enclosing loop", async () => {
    expect(
      await runLinear(`
      let fin = 0;
      export function test(): number {
        for (let i = 0; i < 3; i++) { try { if (i === 0) break; } finally { fin = fin + 1; } }
        return fin;
      }
    `),
    ).toBe(1);
  });

  it("finally runs on continue each iteration", async () => {
    expect(
      await runLinear(`
      let fin = 0;
      export function test(): number {
        for (let i = 0; i < 3; i++) { try { continue; } finally { fin = fin + 1; } }
        return fin;
      }
    `),
    ).toBe(3);
  });

  it("nested try/finally replays innermost-first on return", async () => {
    expect(
      await runLinear(`
      let log = 0;
      function f(): number { try { try { return 1; } finally { log = log * 10 + 2; } } finally { log = log * 10 + 3; } }
      export function test(): number { const r = f(); return r * 1000 + log; }
    `),
    ).toBe(1023);
  });

  it("normal fall-through still runs finally exactly once", async () => {
    expect(
      await runLinear(`
      let n = 0;
      export function test(): number { try { n = n + 1; } finally { n = n + 10; } return n; }
    `),
    ).toBe(11);
  });

  it("a break of an inner loop inside the try does NOT prematurely run the try-finally", async () => {
    // The inner-loop break exits only the inner loop; the try-finally runs once
    // at the try's normal completion afterwards.
    expect(
      await runLinear(`
      let fin = 0;
      export function test(): number {
        try { for (let i = 0; i < 3; i++) { if (i === 1) break; } } finally { fin = 5; }
        return fin;
      }
    `),
    ).toBe(5);
  });
});

describe("#2716 linear try/finally refuses loudly for finally with its own early exit", () => {
  it("finally with its own return is rejected (not silently miscompiled)", async () => {
    const r = await compileLinear(`
      function f(): number { try { return 1; } finally { return 2; } }
      export function test(): number { return f(); }
    `);
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/finally/i);
  });
});
