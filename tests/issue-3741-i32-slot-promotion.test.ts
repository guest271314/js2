// #3741 — native-i32 slot storage for provably-int32 mutable locals on the IR path.
//
// Two things are asserted here:
//
//  1. SHAPE — the landing-page `loop.ts` benchmark body
//     (`let s = 0; for (let i = 0; i < 1000000; i++) s = (s + i) | 0;`) must
//     compile through the IR front-end to the same native-i32 loop legacy
//     produces: `i32.add` / `i32.lt_s`, with NO ToInt32 bit-manipulation
//     (`i64.reinterpret_f64` & friends) and NO f64 arithmetic in the loop.
//     Before #3741 the IR path emitted an f64 add plus a ~25-instruction
//     JS-ToInt32 sequence per iteration and ran ~16x slower than legacy.
//
//  2. EQUIVALENCE — IR, legacy and real JavaScript must agree on every value,
//     including the wrap / overflow / negative-zero / uint32 edges that make
//     i32 promotion unsound when applied too eagerly (#1236, #2789, #1120's
//     `>>>` follow-up). A wrong arithmetic answer is the failure mode this
//     optimisation must never have.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(source: string, experimentalIR: boolean): Promise<WebAssembly.Exports> {
  const r = await compile(source, { nativeStrings: true, experimentalIR });
  if (!r.success) {
    throw new Error(
      `${experimentalIR ? "IR" : "legacy"} compile failed:\n${r.errors.map((e) => e.message).join("\n")}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(r.binary, buildImports(r.imports, undefined, r.stringPool));
  return instance.exports;
}

/** The `$<name>` function body out of a full-module WAT. */
function funcBody(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start, `function $${name} not found in WAT`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < wat.length; i++) {
    if (wat[i] === "(") depth++;
    else if (wat[i] === ")") {
      depth--;
      if (depth === 0) return wat.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced WAT for $${name}`);
}

const BENCH_SRC = `
export function run(): number {
  let s = 0;
  for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
  return s;
}
`;

describe("#3741 — i32 slot promotion (shape)", () => {
  it("the loop.ts benchmark compiles to a native-i32 loop with no ToInt32 and no f64 arithmetic", async () => {
    const r = await compile(BENCH_SRC, { emitWat: true });
    expect(r.success).toBe(true);
    const body = funcBody(r.wat, "run");

    // Both locals are stored as i32 (the whole point — a loop-carried
    // f64<->i32 round trip costs as much as the ToInt32 it would replace).
    expect(body).toMatch(/\(local \$\$slot_s i32\)/);
    expect(body).toMatch(/\(local \$\$slot_i i32\)/);

    // Native i32 loop ops, exactly like legacy.
    expect(body).toContain("i32.add");
    expect(body).toContain("i32.lt_s");

    // No JS-ToInt32 bit manipulation (#3739's i64 fast path) anywhere.
    for (const op of ["i64.reinterpret_f64", "i64.shr_u", "i32.wrap_i64", "i32.trunc_sat_f64_s"]) {
      expect(body, `unexpected ${op} in the promoted loop`).not.toContain(op);
    }

    // No f64 arithmetic at all: the only f64 op left is the single
    // `f64.convert_i32_s` that widens the result for the `number` return.
    for (const op of ["f64.add", "f64.sub", "f64.mul", "f64.lt", "f64.const"]) {
      expect(body, `unexpected ${op} in the promoted loop`).not.toContain(op);
    }
    expect(body).toContain("f64.convert_i32_s");
  });

  it("an indexed read loop does not pay a convert/truncate round trip for the promoted counter", async () => {
    const r = await compile(
      `export function total(): number {
         const arr: number[] = [1, 2, 3];
         let t = 0;
         for (let i = 0; i < arr.length; i++) t = t + arr[i];
         return t;
       }`,
      { emitWat: true },
    );
    expect(r.success).toBe(true);
    const body = funcBody(r.wat, "total");
    // `arr[i]` must consume the i32 slot directly — the promotion widens on
    // read, and without the `trunc_sat(convert(x)) === x` cancellation in
    // `IrFunctionBuilder.emitUnary` this loop would be SLOWER than before.
    expect(body).not.toContain("i32.trunc_sat_f64_s");
    expect(body).toContain("array.get");
  });
});

interface Case {
  readonly name: string;
  readonly source: string;
  readonly fn: string;
  readonly args: readonly number[];
  /** Reference implementation, evaluated in real JS. */
  readonly js: (...a: number[]) => number;
}

const CASES: readonly Case[] = [
  {
    name: "loop.ts benchmark accumulator (wraps past 2^31)",
    source: BENCH_SRC,
    fn: "run",
    args: [],
    js: () => {
      let s = 0;
      for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
      return s;
    },
  },
  {
    name: "accumulator that wraps NEGATIVE",
    source: `export function f(): number {
      let s = 0;
      for (let i = 0; i < 200; i++) s = (s - 30000000) | 0;
      return s;
    }`,
    fn: "f",
    args: [],
    js: () => {
      let s = 0;
      for (let i = 0; i < 200; i++) s = (s - 30000000) | 0;
      return s;
    },
  },
  {
    name: "iterative fibonacci — the #1120 motivating shape",
    source: `export function fib(n: number): number {
      let a = 0;
      let b = 1;
      for (let i = 0; i < n; i++) {
        const next = (a + b) | 0;
        a = b;
        b = next;
      }
      return a;
    }`,
    fn: "fib",
    args: [90],
    js: (n) => {
      let a = 0;
      let b = 1;
      for (let i = 0; i < n; i++) {
        const next = (a + b) | 0;
        a = b;
        b = next;
      }
      return a;
    },
  },
  {
    name: "FNV-style mixer — xor + shift compounds",
    source: `export function h(n: number): number {
      let x = 2166136261 | 0;
      for (let i = 0; i < n; i++) {
        x = x ^ i;
        x = (x << 5) | 0;
        x = x ^ (x >> 7);
      }
      return x;
    }`,
    fn: "h",
    args: [50],
    js: (n) => {
      let x = 2166136261 | 0;
      for (let i = 0; i < n; i++) {
        x = x ^ i;
        x = (x << 5) | 0;
        x = x ^ (x >> 7);
      }
      return x;
    },
  },
  {
    name: "bitwise compound assignments",
    source: `export function g(n: number): number {
      let x = 0;
      for (let i = 0; i < n; i++) {
        x |= i;
        x ^= 0x5a5a;
        x &= 0xffff;
        x <<= 1;
        x >>= 1;
      }
      return x;
    }`,
    fn: "g",
    args: [17],
    js: (n) => {
      let x = 0;
      for (let i = 0; i < n; i++) {
        x |= i;
        x ^= 0x5a5a;
        x &= 0xffff;
        x <<= 1;
        x >>= 1;
      }
      return x;
    },
  },
  {
    name: "`>>>` is NOT promotable — its uint32 value exceeds int32",
    source: `export function u(): number {
      let x = 0;
      x = (-1 >>> 0) | 0;
      let y = 0;
      y = -1 >>> 0;
      return y - x;
    }`,
    fn: "u",
    args: [],
    js: () => {
      let x = 0;
      x = (-1 >>> 0) | 0;
      let y = 0;
      y = -1 >>> 0;
      return y - x;
    },
  },
  {
    name: "accumulator that must STAY f64 (`+=` — the #1236 saturation trap)",
    source: `export function s(n: number): number {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += i;
      return acc;
    }`,
    fn: "s",
    args: [1000000],
    js: (n) => {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += i;
      return acc;
    },
  },
  {
    name: "promoted counter read into f64 arithmetic and back",
    source: `export function m(n: number): number {
      let total = 0;
      for (let i = 0; i < n; i++) total = total + i * 0.5;
      return total;
    }`,
    fn: "m",
    args: [11],
    js: (n) => {
      let total = 0;
      for (let i = 0; i < n; i++) total = total + i * 0.5;
      return total;
    },
  },
  {
    name: "counter stepping by a literal (`i += 3`)",
    source: `export function st(n: number): number {
      let hits = 0;
      for (let i = 0; i < n; i += 3) hits = (hits + i) | 0;
      return hits;
    }`,
    fn: "st",
    args: [40],
    js: (n) => {
      let hits = 0;
      for (let i = 0; i < n; i += 3) hits = (hits + i) | 0;
      return hits;
    },
  },
  {
    name: "descending counter (`i--`)",
    source: `export function d(n: number): number {
      let acc = 0;
      for (let i = n; i > 0; i--) acc = (acc + i) | 0;
      return acc;
    }`,
    fn: "d",
    args: [25],
    js: (n) => {
      let acc = 0;
      for (let i = n; i > 0; i--) acc = (acc + i) | 0;
      return acc;
    },
  },
  {
    name: "promoted counter as an array index",
    source: `export function idx(): number {
      const arr: number[] = [10, 20, 30, 40];
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = (t + arr[i]) | 0;
      return t;
    }`,
    fn: "idx",
    args: [],
    js: () => {
      const arr = [10, 20, 30, 40];
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = (t + arr[i]) | 0;
      return t;
    },
  },
  {
    name: "promoted counter as an element STORE index",
    source: `export function store(): number {
      const arr: number[] = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) arr[i] = (i * 7) | 0;
      let t = 0;
      for (let j = 0; j < 4; j++) t = (t + arr[j]) | 0;
      return t;
    }`,
    fn: "store",
    args: [],
    js: () => {
      const arr = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) arr[i] = (i * 7) | 0;
      let t = 0;
      for (let j = 0; j < 4; j++) t = (t + arr[j]) | 0;
      return t;
    },
  },
  {
    name: "early return from inside the loop reads the promoted local",
    source: `export function er(n: number): number {
      let s = 0;
      for (let i = 0; i < 1000; i++) {
        s = (s + i) | 0;
        if (i === n) return s;
      }
      return -1;
    }`,
    fn: "er",
    args: [12],
    js: (n) => {
      let s = 0;
      for (let i = 0; i < 1000; i++) {
        s = (s + i) | 0;
        if (i === n) return s;
      }
      return -1;
    },
  },
  {
    name: "negative-zero is not observable through a promoted local",
    source: `export function nz(): number {
      let z = 0;
      z = (z - 0) | 0;
      return 1 / (z === 0 ? z : 1);
    }`,
    fn: "nz",
    args: [],
    js: () => {
      let z = 0;
      z = (z - 0) | 0;
      return 1 / (z === 0 ? z : 1);
    },
  },
  {
    name: "comparison of two promoted locals",
    source: `export function cmp(n: number): number {
      let a = 0;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        a = (a + 3) | 0;
        if (a > i) hits = (hits + 1) | 0;
      }
      return hits;
    }`,
    fn: "cmp",
    args: [30],
    js: (n) => {
      let a = 0;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        a = (a + 3) | 0;
        if (a > i) hits = (hits + 1) | 0;
      }
      return hits;
    },
  },
];

describe("#3741 — i32 slot promotion (IR == legacy == JS)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const expected = c.js(...c.args);
      const [legacy, ir] = await Promise.all([instantiate(c.source, false), instantiate(c.source, true)]);
      const legacyValue = (legacy[c.fn] as (...a: number[]) => number)(...c.args);
      const irValue = (ir[c.fn] as (...a: number[]) => number)(...c.args);
      expect(legacyValue, "legacy vs JS").toBe(expected);
      expect(irValue, "IR vs JS").toBe(expected);
    });
  }
});
