// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Regression guard for #1808 — "Binary emit error: offset is out of bounds".
//
// At baseline f52502e9 (2026-06-03) a cluster of 292 default-lane test262 tests
// crashed identically at module binary-emit time with
//   `L1:1 Binary emit error: offset is out of bounds`
// — i.e. the module we constructed was malformed and the binary writer choked
// while serializing it (the failure is not source-position-specific; all 292
// share the same L1:1 message). The root cause was upstream invalid-module
// construction at type/coercion boundaries, not a writer bug per se; it was
// resolved by the sprint-59 cluster of fixes that corrected module shape
// (#1623 type/coercion-boundary invalid Wasm, #1788 boolean i32 struct fields,
// #1798 IR return-tail coercion, #1320 box-helper registration ordering, …).
//
// This test pins representative samples spanning every affected directory so
// the emit crash cannot silently return. We compile each via the same wrapping
// the test262 runner uses and assert that compilation never surfaces the
// `offset is out of bounds` / `Binary emit error` string, and that any
// successfully-emitted module is well-formed Wasm. Whether a given sample then
// passes/fails at the *semantic* level is out of scope here — only the
// emit-layer crash is guarded.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { wrapTest, parseMeta } from "./test262-runner.ts";
import { compile } from "../src/index.ts";

const TEST262_ROOT = join(__dirname, "..", "test262");

// One representative per affected directory (see issue #1808 "Affected surface"
// table). Each of these carried the identical `offset is out of bounds` emit
// crash at baseline f52502e9.
const SAMPLES = [
  "test/built-ins/TypedArray/prototype/slice/detached-buffer.js",
  "test/built-ins/TypedArray/prototype/subarray/return-abrupt-from-end-symbol.js",
  "test/built-ins/DataView/prototype/setFloat32/index-check-before-value-conversion.js",
  "test/built-ins/Set/prototype/union/converts-negative-zero.js",
  "test/built-ins/Map/prototype/Symbol.toStringTag.js",
  "test/language/eval-code/direct/non-definable-function-with-function.js",
  "test/built-ins/Array/prototype/includes/tolength-length.js",
  "test/built-ins/Date/prototype/setHours/arg-coercion-order.js",
];

const EMIT_CRASH = /offset is out of bounds|Binary emit error/i;

describe("#1808 — emit 'offset is out of bounds' crash does not recur", () => {
  for (const rel of SAMPLES) {
    it(`compiles ${rel} without an emit-layer crash`, async () => {
      const abs = join(TEST262_ROOT, rel);
      if (!existsSync(abs)) {
        // test262 submodule slice may not include every path in all checkouts;
        // skip rather than fail so the guard is portable.
        return;
      }
      const source = readFileSync(abs, "utf-8");
      const meta = parseMeta(source);
      const { source: wrapped } = wrapTest(source, meta);

      // Mirror the runner's compile options. A throw, or an error message
      // matching EMIT_CRASH, is the #1808 regression we are guarding against.
      let result: Awaited<ReturnType<typeof compile>>;
      try {
        result = await compile(wrapped, {
          fileName: "test.ts",
          sourceMap: true,
          emitWat: false,
          skipSemanticDiagnostics: true,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg, `#1808 emit crash recurred for ${rel}`).not.toMatch(EMIT_CRASH);
        return; // a non-emit throw is a different (acceptable, out-of-scope) failure
      }

      const errMsgs = (result.errors ?? []).map((e) => e.message).join("\n");
      expect(errMsgs, `#1808 emit crash recurred for ${rel}`).not.toMatch(EMIT_CRASH);

      // When compilation succeeded, the emitted module must be valid Wasm —
      // a malformed-but-non-throwing module is exactly the failure mode that
      // used to trip the writer.
      if (result.success && result.binary && result.binary.length > 0) {
        expect(WebAssembly.validate(result.binary), `emitted module for ${rel} must validate`).toBe(true);
      }
    });
  }
});
