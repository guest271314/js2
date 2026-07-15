import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";

// #3284 RC2 — a top-level `Promise.resolve(x).then(cb)` callback must fire.
//
// ROOT CAUSE (see plan/issues/3284-...md, `## Diagnosis`): the `.then` reaction
// is scheduled during the wasm `(start)` section. Its microtask then drains
// while the async instantiate helper is still `await`-ing `WebAssembly.instantiate`
// — BEFORE the caller wires `setExports`. The `callback_maker` host bridge
// (`__make_callback` → `exports.__cb_<id>`) resolves exports lazily at fire time,
// but at that instant `getExports()` is still undefined, so the callback
// silently no-ops and never runs.
//
// FIX: when the callback fires with exports not yet wired, park it via
// `deferToExports` and replay it the moment `setExports` wires the instance —
// the same #2128 mechanism used for `getter_callback_maker` setters. This is
// additive: callbacks whose reactions fire AFTER `setExports` (every wrapTest /
// equivalence body runs inside an exported function the host calls post-wiring)
// never hit the new branch.

/** Run a program's top-level code (which executes in the wasm `(start)` section),
 *  wire setExports afterward (as every real host does), then drain microtasks. */
async function runTopLevelCapturingLog(source: string): Promise<string[]> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  try {
    const result = await compile(source, { fileName: "test.ts", target: "gc" });
    if (!result.success) {
      throw new Error(`Compile failed:\n${result.errors.map((e) => e.message).join("\n")}`);
    }
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      new Uint8Array(result.binary),
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    // The `.then` microtask has already drained (unfired) by the time
    // instantiateWasm resolves; setExports replays the parked callback.
    if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
    // Let any remaining microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    console.log = orig;
  }
  return logs;
}

describe("Issue #3284 RC2: top-level Promise.then callback fires", () => {
  it("runs a top-level `Promise.resolve(42).then(cb)` callback", async () => {
    const src = `
      console.log('before promise');
      Promise.resolve(42).then(function (v) {
        console.log('in then, v=', v);
      });
      console.log('after promise setup');
    `;
    const logs = await runTopLevelCapturingLog(src);
    // The callback fired (was: never fired) — regardless of multi-arg formatting.
    expect(logs.some((l) => l.includes("in then, v="))).toBe(true);
    expect(logs.some((l) => l.includes("42"))).toBe(true);
    // The synchronous top-level lines still print, in order, before the callback.
    expect(logs.some((l) => l.includes("before promise"))).toBe(true);
    expect(logs.some((l) => l.includes("after promise setup"))).toBe(true);
  });

  it("runs a top-level async function's `.then` continuation", async () => {
    const src = `
      async function f() { return 7; }
      f().then(function (v) { console.log('async result', v); });
    `;
    const logs = await runTopLevelCapturingLog(src);
    expect(logs.some((l) => l.includes("async result"))).toBe(true);
    expect(logs.some((l) => l.includes("7"))).toBe(true);
  });
});
