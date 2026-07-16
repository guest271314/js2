// #3305 slice 1 — number_toString_radix is SELF-HOSTED: TS source in
// src/stdlib/number-format.ts compiled through the compiler's own IR pipeline
// (legacy (f64,f64)->externref ABI kept by a thunk). Assertions run in-wasm
// (standalone string returns are opaque to JS) against V8-computed literals.
//
// Equivalence oracle note: the conversion was validated BIT-EXACT against the
// deleted hand kernel via a 6,195-case main-vs-branch A/B hash sweep (all
// radices 2..36 × 177 values incl. NaN/±Inf/±0/denormals/traps — see the
// #3305 issue file). V8-exact output is asserted here only for cases the hand
// kernel already matched; the known pre-existing divergence class (full f64
// fraction expansion vs V8's shortest-roundtrip tail, e.g. (0.1).toString(3))
// is inherited unchanged and stays tracked under #1335 Phase 2.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const CASES: [number, number][] = [
  [255, 16],
  [255, 2],
  [-255, 16],
  [0, 2],
  [1, 36],
  [35, 36],
  [1e15, 36],
  [0.5, 2],
  [3.75, 2],
  [-10.625, 16],
  [123.456, 8],
  [1234567, 10],
  [NaN, 16],
  [Infinity, 2],
  [-Infinity, 36],
  [-0, 8],
  [-0.25, 2],
  [4095.9375, 16],
  [255.5, 16],
  [1048575, 32],
  [777, 8],
];

function buildSource(): string {
  let body = "";
  CASES.forEach(([v, radix], i) => {
    const want = v.toString(radix);
    const vLit = Object.is(v, -0) ? "-0" : String(v);
    body += `  if ((${vLit}).toString(${radix}) !== ${JSON.stringify(want)}) { return ${i + 1}; }\n`;
  });
  return `export function t(): number {\n${body}  return 0;\n}\n`;
}

async function runLane(target: "standalone" | "wasi"): Promise<number> {
  const r = await compile(buildSource(), { fileName: `issue-3305-${target}.ts`, target });
  if (!r.success) throw new Error(`${target} compile failed: ${r.errors[0]?.message}`);
  const mod = await WebAssembly.compile(r.binary);
  const imports: Record<string, Record<string, unknown>> = {};
  for (const im of WebAssembly.Module.imports(mod)) {
    imports[im.module] ??= {};
    imports[im.module]![im.name] = () => 0;
  }
  const instance = await WebAssembly.instantiate(mod, imports as WebAssembly.Imports);
  return (instance.exports as { t: () => number }).t();
}

for (const lane of ["standalone", "wasi"] as const) {
  describe(`#3305 self-hosted number_toString_radix — ${lane}`, () => {
    it(`matches V8 on ${CASES.length} exact cases (0 = all pass; N = failing case index)`, async () => {
      expect(await runLane(lane)).toBe(0);
    });
  });
}
