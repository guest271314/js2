import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3263 — behaviour-preserving god-file split: the TextEncoder/TextDecoder UTF-8
// runtime helpers (`ensureTextEncodingHelpers` + its private
// `ensureEncodeIntoResultStruct`) moved verbatim from
// src/codegen/native-strings.ts into src/codegen/text-encoding-native.ts.
//
// Smoke test for the relocated subsystem: compiling a program that uses
// `TextEncoder.encode` / `TextDecoder.decode` (which drive the moved
// `__textencoder_encode` / `__textdecoder_decode_u8` runtime functions) and
// `TextEncoder.encodeInto` (which drives the moved `TextEncoderEncodeIntoResult`
// struct) must still succeed, emit those native helpers from the new module,
// take the standalone native path (no host imports), and produce a structurally
// valid WebAssembly module. This proves the module still links and emits after
// the move. (Numeric runtime output is covered by tests/issue-1780.test.ts; it
// is asserted here only at the compile/emit level so the smoke test is not
// coupled to the local WasmGC engine's execution support.)

type Target = "standalone" | "wasi";

async function compileOk(src: string, target: Target, fileName: string) {
  const result = await compile(src, { fileName, target });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

describe("#3263 TextEncoder/TextDecoder subsystem after native-strings split", () => {
  for (const target of ["standalone", "wasi"] as const) {
    it(`emits the native encode/decode helpers from the relocated module (${target})`, async () => {
      const r = await compileOk(
        `export function e(): number {
          const b = new TextEncoder().encode("Aé你😀");
          return new TextDecoder().decode(b).length;
        }`,
        target,
        `issue-3263-roundtrip-${target}.ts`,
      );
      const wat = r.wat ?? "";
      // The moved `ensureTextEncodingHelpers` registered these runtime helpers.
      expect(wat).toContain("__textencoder_encode");
      expect(wat).toContain("__textdecoder_decode_u8");
      // Native standalone path — no TextEncoder_* host imports (#1780 acceptance).
      expect(wat).not.toContain("TextEncoder_");
      // Emitted binary is structurally valid.
      expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
    });

    it(`resolves encodeInto's result struct without host imports (${target})`, async () => {
      // `encodeInto` writes inline into the caller's buffer, so it does not pull
      // in `__textencoder_encode` (DCE strips it). What it DOES exercise is the
      // relocated `ensureEncodeIntoResultStruct`: member access on the result
      // (`.written`) must resolve to a WasmGC `struct.get`, NOT the generic
      // `env.__extern_get` host import (unavailable standalone/WASI) — the #1780
      // acceptance, preserved after the move.
      const r = await compileOk(
        `export function written(): number {
          const d = new Uint8Array(10);
          return new TextEncoder().encodeInto("ABC", d).written;
        }`,
        target,
        `issue-3263-encodeinto-${target}.ts`,
      );
      const wat = r.wat ?? "";
      expect(wat).not.toContain("TextEncoder_");
      const importNames = WebAssembly.Module.imports(new WebAssembly.Module(r.binary)).map(
        (i) => `${i.module}.${i.name}`,
      );
      expect(importNames).not.toContain("env.__extern_get");
    });
  }
});
