// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 (follow-on to #1979) — non-terminating `if (cond) <stmt>;` guard at a
// NON-void, non-tail body position.
//
// #1979 fixed the `from-ast.ts` lowering so a non-terminating then-arm no
// longer skips the rest of the body (`lowerStatementList`'s converging-guard
// path). But the SELECTOR only let such guards through for VOID functions (via
// the `isVoidReturn && ExpressionStatement` void-tail arm in `isPhase1Tail`).
// A NON-void function whose non-tail `if (cond) x = e;` guard is followed by
// more statements + a value return (the canonical `fdow` day-of-week shape)
// stayed `body-shape-rejected: tail-unhandled`, even though from-ast could
// already lower it. This slice extends the selector's non-tail if-no-else arm
// to mirror from-ast's `thenArmTerminates` fork: terminating then-arm → tail
// rewrite; non-terminating then-arm → `isPhase1BodyStatement` guard.
//
// Every case asserts legacy/IR observable equality, ZERO post-claim demotions,
// and that the IR path was genuinely exercised (bytes differ from the
// `experimentalIR: false` compile — a silent legacy demote fails the test).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

interface RunResult {
  value: unknown;
  binary: Uint8Array;
  postClaim: unknown[];
}

async function compileRun(source: string, fn: string, args: unknown[], experimentalIR: boolean): Promise<RunResult> {
  const r = await compile(source, { experimentalIR, trackFallbacks: true });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return {
    value: (f as (...a: unknown[]) => unknown)(...args),
    binary: r.binary,
    postClaim: r.irPostClaimErrors ?? [],
  };
}

async function expectParity(
  source: string,
  fn: string,
  args: unknown[],
  expected: unknown,
  opts: { expectClaimed?: boolean } = {},
): Promise<void> {
  const legacy = await compileRun(source, fn, args, false);
  const ir = await compileRun(source, fn, args, true);
  expect(legacy.value, "legacy value").toStrictEqual(expected);
  expect(ir.value, "IR value matches legacy").toStrictEqual(legacy.value);
  expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
  if (opts.expectClaimed !== false) {
    expect(
      Buffer.compare(Buffer.from(legacy.binary), Buffer.from(ir.binary)) !== 0,
      "IR path exercised (bytes differ from legacy)",
    ).toBe(true);
  }
}

describe("#2856 — non-terminating if-guard at non-void body position", () => {
  it("simple `if (cond) x = e;` guard then value return", async () => {
    // The minimal fdow shape: a mutation guard followed by more statements.
    await expectParity(
      `export function f(m: number, y: number): number {
         let yr = y;
         if (m < 2) yr = yr - 1;
         return yr * 10 + m;
       }`,
      "f",
      [1, 2000],
      // m=1 < 2 → yr = 1999; 1999*10 + 1 = 19991
      19991,
    );
  });

  it("guard NOT taken — rest still runs with the unmutated value", async () => {
    await expectParity(
      `export function f(m: number, y: number): number {
         let yr = y;
         if (m < 2) yr = yr - 1;
         return yr * 10 + m;
       }`,
      "f",
      [5, 2000],
      // m=5 ≥ 2 → yr stays 2000; 2000*10 + 5 = 20005
      20005,
    );
  });

  it("Zeller-style day-of-week (the `fdow` corpus function)", async () => {
    const src = `export function fdow(y: number, m: number): number {
      const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
      let yr = y;
      if (m < 2) yr = yr - 1;
      const d = (yr + ((yr / 4) | 0) - ((yr / 100) | 0) + ((yr / 400) | 0) + t[m] + 1) % 7;
      return (d + 6) % 7;
    }`;
    // Verify across a range of (y, m) pairs to exercise both guard arms.
    const oracle = (y: number, m: number): number => {
      let yr = y;
      if (m < 2) yr = yr - 1;
      const d =
        (yr + ((yr / 4) | 0) - ((yr / 100) | 0) + ((yr / 400) | 0) + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][m]! + 1) % 7;
      return (d + 6) % 7;
    };
    for (const [y, m] of [
      [2026, 0],
      [2026, 1],
      [2026, 6],
      [2000, 11],
      [1999, 2],
    ] as const) {
      await expectParity(src, "fdow", [y, m], oracle(y, m));
    }
  });

  it("block then-arm with multiple mutations", async () => {
    await expectParity(
      `export function f(a: number): number {
         let x = 1;
         let y = 2;
         if (a > 0) { x = x + a; y = y + a; }
         return x * 100 + y;
       }`,
      "f",
      [5],
      // x=6, y=7 → 607
      607,
    );
  });

  it("multiple consecutive guards before the tail", async () => {
    await expectParity(
      `export function f(a: number, b: number): number {
         let acc = 0;
         if (a > 0) acc = acc + 10;
         if (b > 0) acc = acc + 1;
         return acc;
       }`,
      "f",
      [1, 0],
      10,
    );
  });

  it("nested non-terminating guard `if (c1) if (c2) x = e;`", async () => {
    await expectParity(
      `export function f(a: number, b: number): number {
         let x = 0;
         if (a > 0) if (b > 0) x = a + b;
         return x;
       }`,
      "f",
      [3, 4],
      7,
    );
  });

  it("guard followed by a loop that reads the mutated local", async () => {
    await expectParity(
      `export function f(n: number): number {
         let base = 0;
         if (n > 5) base = 100;
         let s = base;
         for (let i = 0; i < n; i++) s = s + i;
         return s;
       }`,
      "f",
      [10],
      // base=100; sum 0..9 = 45 → 145
      145,
    );
  });

  it("REGRESSION: terminating then-arm (early return) still rewrites", async () => {
    await expectParity(
      `export function f(n: number): number {
         if (n < 0) return -1;
         return n * 2;
       }`,
      "f",
      [21],
      42,
    );
  });
});
