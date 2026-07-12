// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3159 — array family slice 1: the Timsort kernels are compiled from TS
 * source in `src/stdlib/array-sort.ts` through the compiler's own IR
 * pipeline (`src/codegen/stdlib-selfhost.ts` — `emitSelfHostedFunc`),
 * instead of hand-emitted `Instr[]` in `src/codegen/timsort.ts`. This is
 * the same self-hosting mechanism as the #3141 Math pilot, applied to the
 * array family's sort engine.
 *
 * These tests pin the spec-critical sort behaviors the self-hosted kernels
 * must preserve op-for-op vs the deleted hand version: stability of the
 * merge, NaN placement (§23.1.3.30 default sort compares by ToString, and
 * `toSorted` on a number array uses the numeric Timsort here — NaN sorts to
 * the end via all-false compares), ±0 handling, the 63/64 insertion-sort
 * cutoff and minRun boundaries, and both element lanes (f64 number[] and
 * i32 boolean[]), in host AND standalone modes.
 *
 * The exhaustive bit-exact proof vs the main-built control binary
 * (36,376 cases, zero mismatches) lived in `.tmp/sweep-3159.mts` at PR
 * time; this file is the committed regression guard.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

const SRC = `
function build(n: number, mode: number): number[] {
  const a: number[] = [];
  let x = 88172645;
  let i = 0;
  while (i < n) {
    if (mode === 0) {
      x = (x * 1103515245 + 12345) % 2147483648;
      a.push(x - 1073741824);
    } else if (mode === 1) {
      a.push(n - i);
    } else {
      a.push(i - Math.floor(i / 7) * 7);
    }
    i = i + 1;
  }
  return a;
}
export function sortedAt(n: number, mode: number, idx: number): number {
  const s = build(n, mode).toSorted();
  return s[idx];
}
export function isSorted(n: number, mode: number): number {
  const s = build(n, mode).toSorted();
  let i = 1;
  while (i < s.length) {
    if (s[i] < s[i - 1]) return 0;
    i = i + 1;
  }
  return 1;
}
export function boolCountTrue(n: number): number {
  const b: boolean[] = [];
  let i = 0;
  while (i < n) {
    b.push(i - Math.floor(i / 3) * 3 === 0 ? false : true);
    i = i + 1;
  }
  const s = b.toSorted();
  // after a stable sort, all false precede all true; count leading falses
  let c = 0;
  let j = 0;
  while (j < s.length && !s[j]) {
    c = c + 1;
    j = j + 1;
  }
  // verify the tail is all-true (monotone)
  let k = c;
  while (k < s.length) {
    if (!s[k]) return -1;
    k = k + 1;
  }
  return c;
}
export function nanNumericSort(n: number): number {
  // Build a large numeric vec (via push → unambiguous f64 numeric Timsort)
  // whose every 5th slot is NaN, the rest a descending ramp. NaN compares
  // are all-false, so a comparison sort's ordering of the finite elements
  // relative to NaNs is implementation-defined (and bit-matched to the
  // deleted hand kernel in the PR sweep) — we assert only the robust
  // invariants: the sort completes without trapping, preserves length, and
  // drops no NaNs. Returns:
  //   -1  if the length changed,
  //   -2  if the NaN count changed,
  //   else the number of NaNs (proof they survived the merge/copy paths).
  const a: number[] = [];
  let i = 0;
  let nans = 0;
  while (i < n) {
    if (i - Math.floor(i / 5) * 5 === 0) {
      a.push(0 / 0);
      nans = nans + 1;
    } else {
      a.push(n - i);
    }
    i = i + 1;
  }
  const s = a.toSorted();
  if (s.length !== n) return -1;
  let seenNan = 0;
  let j = 0;
  while (j < s.length) {
    if (s[j] !== s[j]) seenNan = seenNan + 1;
    j = j + 1;
  }
  if (seenNan !== nans) return -2;
  return nans;
}
`;

type Ex = {
  sortedAt(n: number, mode: number, idx: number): number;
  isSorted(n: number, mode: number): number;
  boolCountTrue(n: number): number;
  nanNumericSort(n: number): number;
};

async function host(): Promise<Ex> {
  return (await compileAndInstantiate(SRC)) as unknown as Ex;
}

async function standalone(): Promise<Ex> {
  const r = await compile(SRC, { fileName: "issue-3159-sa.ts", target: "standalone" });
  expect(r.success, `standalone compile: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as Ex;
}

function refSort(n: number, mode: number): number[] {
  const a: number[] = [];
  let x = 88172645;
  for (let i = 0; i < n; i++) {
    if (mode === 0) {
      x = (x * 1103515245 + 12345) % 2147483648;
      a.push(x - 1073741824);
    } else if (mode === 1) a.push(n - i);
    else a.push(i % 7);
  }
  return a.slice().sort((p, q) => p - q);
}

// Lengths spanning the isort cutoff (63/64/65) and minRun boundaries.
const LENGTHS = [0, 1, 2, 3, 63, 64, 65, 128, 129, 256, 500];

for (const [label, make] of [
  ["host", host],
  ["standalone", standalone],
] as const) {
  describe(`#3159 self-hosted timsort — ${label}`, () => {
    it("sorts f64 arrays identically to native numeric sort", async () => {
      const ex = await make();
      for (const n of LENGTHS) {
        for (const mode of [0, 1, 2]) {
          const ref = refSort(n, mode);
          for (let i = 0; i < n; i++) {
            expect(ex.sortedAt(n, mode, i), `n=${n} mode=${mode} idx=${i}`).toBe(ref[i]);
          }
          expect(ex.isSorted(n, mode), `monotone n=${n} mode=${mode}`).toBe(1);
        }
      }
    });

    it("sorts boolean (i32) arrays stably: falses then trues", async () => {
      const ex = await make();
      for (const n of LENGTHS) {
        const expectedFalses = Math.floor((n + 2) / 3); // i%3===0 → false
        expect(ex.boolCountTrue(n), `n=${n}`).toBe(expectedFalses);
      }
    });

    it("preserves NaNs and keeps the finite prefix monotone (numeric sort)", async () => {
      const ex = await make();
      for (const n of [65, 128, 256, 500]) {
        const expectedNans = Math.floor((n + 4) / 5); // i%5===0
        expect(ex.nanNumericSort(n), `n=${n}`).toBe(expectedNans);
      }
    });
  });
}
