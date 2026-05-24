// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1588 PR-C — standalone `__str_to_utf8` WTF-16 → UTF-8 transcoder.
//
// `__str_to_utf8(s: ref $AnyString) -> ref $__str_data_u8` is the missing
// pure-Wasm primitive (no JS host call) that converts any WasmGC string —
// NativeString (i16), ConsString rope, or Utf8String (i8) — to a freshly
// allocated UTF-8 byte array. It is the building block the deferred
// Component-Model boundary fast path (Edge B, ADR-0015) will eventually call
// instead of a host `TextEncoder` import, satisfying the "JS host optional"
// architecture rule.
//
// These tests compile a real string program with `--utf8-storage` on (so the
// helper + the i8 backing type are emitted), then splice in an exported
// wrapper that builds a NativeString from baked-in code units, calls
// `__str_to_utf8`, and exposes the result. We assert the emitted bytes match
// Node's `Buffer.from(str, "utf8")` reference encoding, including the WTF-8
// generalization for lone surrogates (the helper is total — it never traps).

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
// Side-effect import: registers compileExpression/compileStatement delegates in
// shared.ts (done lazily; `generateModule` alone does not trigger it).
import "../src/codegen/expressions.js";
import { emitBinary } from "../src/emit/binary.js";
// Post-codegen pass `compile()` runs between generateModule and emitBinary;
// widens non-defaultable ref types to ref_null in locals/params/results.
// Required here for the same reason — without it the shared string helpers
// (e.g. __str_equals) fail Wasm validation.
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import type { Instr, WasmModule, WasmFunction } from "../src/ir/types.js";

const ENV = {
  env: new Proxy({} as Record<string, unknown>, {
    get: () => () => 0,
    has: () => true,
  }),
};

/** Number of imported functions = function index base for module functions. */
function numImportFuncs(mod: WasmModule): number {
  return mod.imports.filter((i) => i.desc.kind === "func").length;
}

function findFunc(mod: WasmModule, name: string): { fn: WasmFunction; index: number } {
  const i = mod.functions.findIndex((f) => f.name === name);
  if (i < 0) throw new Error(`function ${name} not emitted`);
  return { fn: mod.functions[i]!, index: numImportFuncs(mod) + i };
}

function structTypeIdx(mod: WasmModule, name: string): number {
  const i = mod.types.findIndex((t) => "name" in t && (t as { name?: string }).name === name);
  if (i < 0) throw new Error(`type ${name} not registered`);
  return i;
}

/**
 * Compile a string program with utf8-storage on, splice in an exported wrapper
 * `probe(idx: i32) -> i32` that:
 *   - builds a `NativeString` (i16) from `codeUnits`,
 *   - calls `__str_to_utf8` → i8 byte array `b`,
 *   - returns `b.length` when idx < 0, else `b[idx]` (unsigned).
 * Returns the instantiated probe function.
 */
async function buildProbe(codeUnits: number[]): Promise<(idx: number) => number> {
  // Any string program forces `ensureNativeStringHelpers`, which emits
  // `__str_to_utf8` because utf8Storage is on.
  const ast = analyzeSource(`export function seed(): number { return "x".length; }`);
  const { module: mod, errors } = generateModule(ast, {
    experimentalIR: true,
    nativeStrings: true,
    utf8Storage: true,
  });
  const hardErrors = errors.filter((e) => e.severity !== "warning");
  if (hardErrors.length) throw new Error(`codegen errors: ${hardErrors.map((e) => e.message).join("; ")}`);

  const toUtf8 = findFunc(mod, "__str_to_utf8");
  const nativeStrIdx = structTypeIdx(mod, "NativeString");
  const strDataIdx = structTypeIdx(mod, "__str_data");
  const u8DataIdx = structTypeIdx(mod, "__str_data_u8");
  const anyStrIdx = structTypeIdx(mod, "AnyString");

  // Wrapper type: (i32) -> i32.
  const wrapperTypeIdx = mod.types.length;
  mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });

  // Build a NativeString(len, off=0, data=array.new_fixed[...codeUnits]),
  // call __str_to_utf8, branch on idx.
  const buildStr: Instr[] = [
    { op: "i32.const", value: codeUnits.length }, // len
    { op: "i32.const", value: 0 }, // off
    ...codeUnits.map((c) => ({ op: "i32.const", value: c }) as Instr),
    { op: "array.new_fixed", typeIdx: strDataIdx, length: codeUnits.length } as Instr,
    { op: "struct.new", typeIdx: nativeStrIdx } as Instr,
    // upcast ref $NativeString -> ref $AnyString for the call
    { op: "ref.cast", typeIdx: anyStrIdx } as Instr,
    { op: "call", funcIdx: toUtf8.index } as Instr,
    { op: "local.set", index: 1 } as Instr, // out: ref $__str_data_u8
  ];

  const body: Instr[] = [
    ...buildStr,
    // if idx < 0: return out.length
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: 1 }, { op: "array.len" }],
      else: [
        // out[idx] unsigned
        { op: "local.get", index: 1 },
        { op: "local.get", index: 0 },
        { op: "array.get_u", typeIdx: u8DataIdx },
      ],
    } as Instr,
  ];

  const wrapperIndex = numImportFuncs(mod) + mod.functions.length;
  mod.functions.push({
    name: "probe",
    typeIdx: wrapperTypeIdx,
    locals: [{ name: "out", type: { kind: "ref", typeIdx: u8DataIdx } }],
    body,
    exported: true,
  });
  mod.exports.push({ name: "probe", desc: { kind: "func", index: wrapperIndex } });

  widenNonDefaultableTypes(mod);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary, ENV);
  return instance.exports.probe as (idx: number) => number;
}

/** Read the full byte array out of the probe. */
async function encode(str: string): Promise<number[]> {
  const codeUnits = Array.from(str, () => 0); // placeholder length, replaced below
  codeUnits.length = 0;
  for (let i = 0; i < str.length; i++) codeUnits.push(str.charCodeAt(i));
  const probe = await buildProbe(codeUnits);
  const len = probe(-1);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(probe(i));
  return out;
}

describe("#1588 PR-C — __str_to_utf8 standalone transcoder", () => {
  const ASCII = "Hello, World!";
  const TWO_BYTE = "café";
  const THREE_BYTE = "日本語";
  const ASTRAL = "a😀b";
  const MIXED = "x—é😀z"; // ascii + em-dash (3B) + é (2B) + astral (4B) + ascii

  for (const s of [ASCII, TWO_BYTE, THREE_BYTE, ASTRAL, MIXED, ""]) {
    it(`encodes ${JSON.stringify(s)} identically to Buffer UTF-8`, async () => {
      const got = await encode(s);
      const expected = Array.from(Buffer.from(s, "utf8"));
      expect(got).toEqual(expected);
    });
  }

  it("byteLen matches the Buffer length for a multi-byte string", async () => {
    const probe = await buildProbe(Array.from(THREE_BYTE, (c) => c.charCodeAt(0)));
    expect(probe(-1)).toBe(Buffer.from(THREE_BYTE, "utf8").length);
  });

  it("lone high surrogate is encoded as 3-byte WTF-8 (total, never traps)", async () => {
    // U+D800 → WTF-8 ED A0 80. Node's Buffer substitutes U+FFFD, so compare to
    // the WTF-8 expectation directly rather than to Buffer.
    const got = await encode("\uD800");
    expect(got).toEqual([0xed, 0xa0, 0x80]);
  });

  it("lone low surrogate is encoded as 3-byte WTF-8", async () => {
    // U+DC00 → WTF-8 ED B0 80.
    const got = await encode("\uDC00");
    expect(got).toEqual([0xed, 0xb0, 0x80]);
  });

  it("ascii surrounding a lone surrogate round-trips the ascii bytes", async () => {
    const got = await encode("a\uD800b");
    expect(got).toEqual([0x61, 0xed, 0xa0, 0x80, 0x62]);
  });
});
