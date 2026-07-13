// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 — bench_array slice: the three capabilities that let the two
// `bench_array` corpus functions (benchmarks.ts / benchmarks/array.ts) claim
// on the IR path.
//
//   A  `number[]` type annotation — `isPhase1TypeNode` accepts the
//      ArrayTypeNode; `lowerVarDecl` resolves it to the f64-element vec ref,
//      which is the hint an EMPTY literal initializer needs to type its
//      `vec.new_fixed`.
//   B  `arr.push(v)` — rides the C2 `__vec_elem_set_<t>` helper (store at
//      index == length ⇒ grow + store + length update is EXACTLY push).
//      Statement position drops the result; expression position returns the
//      new length (old + 1). Single plain arg, f64/externref element vecs,
//      non-null `(ref $vec)` receivers only — everything else demotes.
//   C  Sibling `for (let i = ...)` loops re-declaring the SAME counter name —
//      the selector's flat scope set leaked the first loop's counter and
//      falsely rejected the second as a duplicate; from-ast scopes each
//      for-init in its own innerCx copy, so the shadow is build-safe.
//
// Every positive case asserts legacy/IR observable equality, ZERO post-claim
// demotions, AND that the IR path was genuinely exercised (bytes differ from
// the `experimentalIR: false` compile) — a silent legacy demote fails the
// test (the vacuous-pass hazard).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

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

async function compileRun(source: string, fn: string, experimentalIR: boolean): Promise<RunResult> {
  const r = await compile(source, { experimentalIR, trackFallbacks: true });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, {}, r.stringPool);
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return {
    value: (f as (...a: unknown[]) => unknown)(),
    binary: r.binary,
    postClaim: r.irPostClaimErrors ?? [],
  };
}

/**
 * Assert legacy and IR agree on the observable result, the IR compile has
 * ZERO post-claim demotions (unless `allowDemote`), and (when `expectClaimed`,
 * the default) the IR path was genuinely taken (bytes differ).
 */
async function expectParity(
  source: string,
  fn: string,
  expected: unknown,
  opts: { expectClaimed?: boolean; allowDemote?: boolean } = {},
): Promise<void> {
  const legacy = await compileRun(source, fn, false);
  const ir = await compileRun(source, fn, true);
  expect(legacy.value, "legacy value").toStrictEqual(expected);
  expect(ir.value, "IR value matches legacy").toStrictEqual(legacy.value);
  if (!opts.allowDemote) {
    expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
  }
  const bytesDiffer = Buffer.compare(Buffer.from(legacy.binary), Buffer.from(ir.binary)) !== 0;
  if (opts.expectClaimed !== false) {
    expect(bytesDiffer, "IR path exercised (bytes differ from legacy)").toBe(true);
  }
}

const BENCH_ARRAY = `export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}`;

describe("#2856 — number[] annotation + empty literal (A)", () => {
  it("empty literal with number[] annotation reads back pushed values", async () => {
    await expectParity(
      `export function f(): number {
         const arr: number[] = [];
         arr.push(42);
         return arr[0] * 10 + arr.length;
       }`,
      "f",
      421,
    );
  });

  it("non-empty literal with number[] annotation stays claimed", async () => {
    await expectParity(
      `export function f(): number {
         const arr: number[] = [5, 6];
         return arr[0] * 10 + arr[1];
       }`,
      "f",
      56,
    );
  });
});

describe("#2856 — arr.push(v) on a growable vec (B)", () => {
  it("push grows an empty vec across a C-style loop (bench_array shape, whole fn e2e)", async () => {
    await expectParity(BENCH_ARRAY, "bench_array", 49995000);
  });

  it("push in expression position returns the NEW length", async () => {
    await expectParity(
      `export function f(): number {
         const arr: number[] = [];
         arr.push(7);
         const n = arr.push(9);
         return n * 100 + arr[0] * 10 + arr[1];
       }`,
      "f",
      279,
    );
  });

  it("push appends past a non-empty literal (grow-on-capacity path)", async () => {
    await expectParity(
      `export function f(): number {
         const arr: number[] = [1, 2];
         arr.push(3);
         arr.push(4);
         return arr[3] * 1000 + arr[2] * 100 + arr.length;
       }`,
      "f",
      4304,
    );
  });

  it("multi-arg push demotes cleanly to legacy (claim-partial residual)", async () => {
    // The generic method-call arm claims the shape; the .push lowering throws
    // its documented single-arg residual and the function demotes to legacy,
    // which handles multi-arg push. Observable behavior must stay correct.
    await expectParity(
      `export function f(): number {
         const arr: number[] = [];
         arr.push(1, 2);
         return arr.length;
       }`,
      "f",
      2,
      { expectClaimed: false, allowDemote: true },
    );
  });
});

describe("#2856 — sibling for-loops re-declaring the counter (C)", () => {
  it("two sibling `for (let i...)` loops claim and agree with legacy", async () => {
    await expectParity(
      `export function f(): number {
         let s = 0;
         for (let i = 0; i < 5; i++) s = s + i;
         for (let i = 0; i < 3; i++) s = s * 2;
         return s;
       }`,
      "f",
      80,
    );
  });

  it("shadowing a GENUINE outer local still rejects (build-side parity)", async () => {
    // `let i` at body level makes the for's `let i` a REAL redeclaration in
    // from-ast's flat function scope — the selector must keep rejecting it
    // (stays legacy; behavior correct, no post-claim demotion).
    await expectParity(
      `export function f(): number {
         let i = 100;
         let s = 0;
         for (let i = 0; i < 3; i++) s = s + i;
         return s + i;
       }`,
      "f",
      103,
      { expectClaimed: false },
    );
  });
});

describe("#2856 — mode cleanliness", () => {
  it("standalone / wasi compiles stay clean (pure-WasmGC helper, no host import)", async () => {
    for (const extra of [{ target: "standalone" as const }, { target: "wasi" as const }]) {
      const r = await compile(BENCH_ARRAY, { experimentalIR: true, trackFallbacks: true, ...(extra as object) });
      expect(r.success, `compile ok under ${JSON.stringify(extra)}`).toBe(true);
      expect(r.irPostClaimErrors ?? []).toStrictEqual([]);
    }
  });
});
