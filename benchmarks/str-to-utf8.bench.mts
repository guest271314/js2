// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1588 PR-C benchmark — standalone (pure-Wasm) `__str_to_utf8` WTF-16 → UTF-8
// transcoder throughput vs. the JS host path (`TextEncoder.prototype.encode`).
//
// Run:  npx tsx benchmarks/str-to-utf8.bench.mts
//
// The benchmark builds a Wasm module that exports `transcodeN(reps: i32) -> i32`:
// it materializes a fixed test string as a NativeString, calls `__str_to_utf8`
// `reps` times, and returns the resulting byte length (so the work cannot be
// optimized away). We time the in-Wasm loop against an equivalent JS loop over
// `TextEncoder.encode`. This measures the transcode kernel itself — the path
// the deferred Component-Model boundary (Edge B, ADR-0015) will call instead of
// a host TextEncoder import, satisfying the "JS host optional" rule.
//
// Note: this is a *kernel* micro-benchmark, not an end-to-end CM-boundary
// measurement (that edge is deferred — see ADR-0015 and the follow-up issue).
// It establishes that a pure-Wasm transcoder is competitive with the host
// encoder, which is the prerequisite for the standalone boundary path to be
// worth taking.

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { emitBinary } from "../src/emit/binary.js";
import "../src/codegen/expressions.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

const ENV = {
  env: new Proxy({} as Record<string, unknown>, { get: () => () => 0, has: () => true }),
};

function numImportFuncs(mod: WasmModule): number {
  return mod.imports.filter((i) => i.desc.kind === "func").length;
}
function funcIndex(mod: WasmModule, name: string): number {
  const i = mod.functions.findIndex((f) => f.name === name);
  if (i < 0) throw new Error(`function ${name} not emitted`);
  return numImportFuncs(mod) + i;
}
function typeIdx(mod: WasmModule, name: string): number {
  const i = mod.types.findIndex((t) => "name" in t && (t as { name?: string }).name === name);
  if (i < 0) throw new Error(`type ${name} not registered`);
  return i;
}

/**
 * Build a module exporting `transcodeN(reps) -> byteLen`: builds `text` as a
 * NativeString once per rep, runs __str_to_utf8, accumulates the byte length.
 */
async function buildTranscoder(text: string): Promise<(reps: number) => number> {
  const codeUnits: number[] = [];
  for (let i = 0; i < text.length; i++) codeUnits.push(text.charCodeAt(i));

  const ast = analyzeSource(`export function seed(): number { return "x".length; }`);
  const { module: mod, errors } = generateModule(ast, {
    experimentalIR: true,
    nativeStrings: true,
    utf8Storage: true,
  });
  const hard = errors.filter((e) => e.severity !== "warning");
  if (hard.length) throw new Error(hard.map((e) => e.message).join("; "));

  const toUtf8 = funcIndex(mod, "__str_to_utf8");
  const nativeStrIdx = typeIdx(mod, "NativeString");
  const strDataIdx = typeIdx(mod, "__str_data");
  const anyStrIdx = typeIdx(mod, "AnyString");

  const wrapperTypeIdx = mod.types.length;
  mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });

  // locals: reps(0)=param, i(1), acc(2)
  const I = 1;
  const ACC = 2;
  const buildStr: Instr[] = [
    { op: "i32.const", value: codeUnits.length },
    { op: "i32.const", value: 0 },
    ...codeUnits.map((c) => ({ op: "i32.const", value: c }) as Instr),
    { op: "array.new_fixed", typeIdx: strDataIdx, length: codeUnits.length } as Instr,
    { op: "struct.new", typeIdx: nativeStrIdx } as Instr,
    { op: "ref.cast", typeIdx: anyStrIdx } as Instr,
    { op: "call", funcIdx: toUtf8 } as Instr,
    { op: "array.len" } as Instr,
  ];

  const body: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: ACC },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: 0 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // acc += byteLen(transcode(text))
            { op: "local.get", index: ACC },
            ...buildStr,
            { op: "i32.add" },
            { op: "local.set", index: ACC },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: ACC },
  ] as Instr[];

  const wrapperIndex = numImportFuncs(mod) + mod.functions.length;
  mod.functions.push({
    name: "transcodeN",
    typeIdx: wrapperTypeIdx,
    locals: [
      { name: "i", type: { kind: "i32" } },
      { name: "acc", type: { kind: "i32" } },
    ],
    body,
    exported: true,
  });
  mod.exports.push({ name: "transcodeN", desc: { kind: "func", index: wrapperIndex } });

  widenNonDefaultableTypes(mod);
  const { instance } = await WebAssembly.instantiate(emitBinary(mod), ENV);
  return instance.exports.transcodeN as (reps: number) => number;
}

function timeIt(label: string, reps: number, fn: () => number): { ms: number; result: number } {
  // warmup
  fn();
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(20)} ${ms.toFixed(2)} ms  (${(reps / (ms / 1000) / 1e6).toFixed(2)} M ops/s)`);
  return { ms, result };
}

const CASES: { name: string; text: string }[] = [
  { name: "ascii (1B/char)", text: "The quick brown fox jumps over the lazy dog. ".repeat(8) },
  { name: "latin-1 (2B accents)", text: "café déjà vu naïve résumé Köln Москва ".repeat(8) },
  { name: "cjk (3B/char)", text: "日本語のテキストエンコーディングのベンチマーク".repeat(8) },
  { name: "astral (4B emoji)", text: "😀🚀🎉🔥💯".repeat(16) },
];

const REPS = 20000;

console.log(`\n#1588 PR-C — __str_to_utf8 (pure-Wasm) vs TextEncoder (JS host)`);
console.log(`reps per case: ${REPS}\n`);

const enc = new TextEncoder();

for (const c of CASES) {
  console.log(`${c.name}  (${c.text.length} code units, ${enc.encode(c.text).length} UTF-8 bytes):`);
  const transcodeN = await buildTranscoder(c.text);

  const wasm = timeIt("wasm __str_to_utf8", REPS, () => transcodeN(REPS));
  const js = timeIt("js TextEncoder", REPS, () => {
    let acc = 0;
    for (let i = 0; i < REPS; i++) acc += enc.encode(c.text).length;
    return acc;
  });

  // sanity: both must agree on total byte length
  if (wasm.result !== js.result) {
    throw new Error(`byte-length mismatch for "${c.name}": wasm=${wasm.result} js=${js.result}`);
  }
  const ratio = js.ms / wasm.ms;
  console.log(`  → wasm is ${ratio.toFixed(2)}x ${ratio >= 1 ? "faster" : "slower"} than TextEncoder\n`);
}
