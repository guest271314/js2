// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

// #1807 — residual of #1776. The test262 harness helper `isSameValue(a, b)`
// compiles both params to `externref`, so its `a === b` / `a !== a` comparisons
// take the standalone Wasm-native externref equality path, which bakes
// `call` instructions to the union helpers `__typeof_number` / `__unbox_number`
// / `__typeof_boolean` / `__unbox_boolean` by their `ctx.funcMap` index.
//
// For ~277 async-generator tests the module ALSO registers host imports
// (`__make_callback`, the generator-bridge imports `__create_async_generator`
// & co, plus the late imports `__extern_is_undefined` / `__get_undefined`).
// Some of those imports were added BETWEEN the native-string helper emission
// (which snapshots `nativeStrHelperImportBase` at that instant) and the union
// helper emission, so the union helpers were registered at a HIGHER import
// count. `reconcileNativeStrFinalizeShift` applies a SINGLE uniform
// `(numImportFuncs - base)` delta to every defined function, which over-shifted
// the union helpers by exactly `(importsAddedBeforeUnionBlock)`. After dead
// import elimination compacted the index space that surfaced as:
//
//   WebAssembly.instantiate(): Compiling function #N:"isSameValue" failed:
//   call[0] expected type i32, found local.get of type externref
//
// (a stale call into the adjacent boxing helper `__box_boolean`, which expects
// i32). The fix flushes the pending native-string finalize shift before the
// union helpers are registered so both groups share one consistent base.

/**
 * Compile a test262-shaped async-generator body under `--target standalone`
 * and assert the module VALIDATES — `WebAssembly.compile` checks every function
 * body's call signatures without needing the imports to be resolvable, so the
 * `isSameValue` call-type mismatch surfaces here. Returns the per-function
 * error message on failure for triage.
 */
async function validateStandalone(body: string): Promise<void> {
  const meta = parseMeta(body);
  const { source } = wrapTest(body, meta);
  const r = await compile(source, {
    fileName: "issue-1807.ts",
    target: "standalone",
    // Match the standalone test262 lane (skips TS semantic diagnostics so the
    // async-generator-shaped test bodies compile through to codegen).
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
}

describe("#1807 standalone isSameValue funcMap drift with async-generator imports", () => {
  it("validates an async-generator + assert.sameValue module (no isSameValue call-type mismatch)", async () => {
    await validateStandalone(`
      var callCount = 0;
      async function* f(x = 1) {
        callCount = callCount + 1;
      }
      f();
      assert.sameValue(callCount, 0, 'generator function body not evaluated');
    `);
  });

  it("validates the dflt-params-ref-self shape (assert.throws + late imports)", async () => {
    // This shape additionally registers the late imports __extern_is_undefined /
    // __get_undefined, reproducing the exact import layout where the union
    // helper indices were over-shifted by one.
    await validateStandalone(`
      var x = 0;
      var callCount = 0;
      async function* f(x = x) {
        callCount = callCount + 1;
      }
      assert.throws(ReferenceError, function() {
        f();
      });
      assert.sameValue(callCount, 0, 'generator function body not evaluated');
    `);
  });

  it("isSameValue helper itself emits no stale call into a boxing helper", async () => {
    // Compile the same shape and inspect the emitted WAT for isSameValue: its
    // `call` targets must point at the externref→i32 typeof helpers, never at
    // a `(param i32)` boxing helper (the off-by-one symptom).
    const body = `
      var callCount = 0;
      async function* f(x = 1) {
        callCount = callCount + 1;
      }
      f();
      assert.sameValue(callCount, 0);
    `;
    const meta = parseMeta(body);
    const { source } = wrapTest(body, meta);
    const r = await compile(source, {
      fileName: "issue-1807.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // The whole module must validate — the strongest single assertion.
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });
});
