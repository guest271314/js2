import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";

// #3284 RC1 — invariant test, SKIPPED pending the fix.
//
// This captures the raw, unmodified-test262-harness shape: a function declared
// then given a callable property via `obj.prop = fn` afterward, and called at
// TOP LEVEL. It currently fails on `origin/main` with
// "sameValue is not a function".
//
// ROOT CAUSE (see plan/issues/3284-...md, `## Diagnosis (2026-07-15)`): the
// top-level store AND call both run in the wasm `(start)` / `__module_init`
// function, which executes DURING `WebAssembly.instantiate` — before the host
// can wire `setExports(instance.exports)`. Without wired exports the host
// closure-wrap/dispatch glue can't invoke the `__fn_wrap` value. Standalone
// mode already dispatches this natively and is unaffected — it is the reference
// implementation for the host-mode fix (option A in the issue file).
//
// The exact same code inside an `export function test(){…}` the host calls
// AFTER `setExports` already works, so this is NOT a call-dispatch codegen bug.
//
// Un-skip this when implementing the host-mode native-dispatch fix.

async function runTopLevel(source: string): Promise<{ threw: string | null; logs: string[] }> {
  const logs: string[] = [];
  const result = await compile(source, { fileName: "test.ts", target: "gc" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  const imports = buildImports(
    result.imports,
    {
      // Record host console output so the test can assert the program ran to completion.
      console: { log: (...a: unknown[]) => logs.push(a.map(String).join(" ")) },
    },
    result.stringPool,
  );
  const binary = new Uint8Array(result.binary);
  try {
    // The top-level code executes here, inside the `(start)` section, before
    // `setExports` — which is exactly where the bug bites.
    const { instance } = await instantiateWasm(
      binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
    return { threw: null, logs };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e), logs };
  }
}

describe.skip("Issue #3284 RC1: calling a property-assigned function at top level", () => {
  it("dispatches assert.sameValue(...) added after declaration, at top level", async () => {
    const src = `
      function assert(mustBeTrue, message) {
        if (mustBeTrue === true) return;
        throw new Error("assert failed: " + message);
      }
      assert.sameValue = function (actual, expected, message) {
        if (actual === expected) return;
        throw new Error("sameValue failed: " + message);
      };
      console.log(typeof assert.sameValue); // "function"
      assert.sameValue(1, 1, "should be equal"); // must NOT throw
      console.log("RC1 OK");
    `;
    const { threw, logs } = await runTopLevel(src);
    expect(threw).toBeNull(); // currently: "sameValue is not a function"
    expect(logs).toContain("function");
    expect(logs).toContain("RC1 OK");
  });
});
