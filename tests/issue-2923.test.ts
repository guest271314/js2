// (#2923) Dynamic dispatch of an any-typed closure param `fn(...)` must honour
// JS §7.3.14 Call arity semantics: extra args are ignored (truncated), missing
// params are `undefined`-filled — the callback is INVOKED regardless of an
// arg-count mismatch. Previously `tryEmitInlineDynamicCall` (calls.ts) hard-
// filtered candidates on `paramTypes.length < arity`, so a call with MORE args
// than the callback declares (the test262 `testWith*TypedArrayConstructors(fn)`
// harness — `fn(ctor, makeCtorArg)` (2 args) into a `function (TA) {…}` (1
// param)) matched NO candidate and silently lowered to `ref.null.extern` — the
// whole test body was dead (a vacuous pass; 468+ BigInt TypedArray tests).
//
// This exercises EXECUTION directly via the mandated inject-throw probe: a
// `throw` in the callback body makes `test()` trap iff the body actually ran.
// (A return-value probe would conflate "not invoked" with an externref→number
// coercion returning 0, so it is unreliable here.)

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function invoked(source: string, target?: "standalone"): Promise<boolean> {
  const r = await compile(source, target ? { target } : {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports: WebAssembly.Imports = target
    ? {}
    : (buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (!target) (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  try {
    (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
    return false; // returned normally → callback body was DROPPED
  } catch {
    return true; // trapped on the injected throw → callback body EXECUTED
  }
}

// A named top-level callback (so its funcref wrapper is registered as a
// dispatch candidate) whose body throws — proves execution.
const prog = (call: string, cbParams: string) => `// @ts-nocheck
function cb(${cbParams}) { throw 7; }
function driver(fn: any): number { ${call}; return 0; }
export function test(): number { return driver(cb); }`;

describe("#2923 any-typed closure param dispatch — JS arity semantics", () => {
  it("standalone: MORE args than params still invokes (extra args ignored)", async () => {
    // The harness shape: 2 args into a 1-param callback.
    expect(await invoked(prog(`fn(1, 2)`, `TA: any`), "standalone")).toBe(true);
  });

  it("standalone: exact arity still invokes (no regression)", async () => {
    expect(await invoked(prog(`fn(1)`, `TA: any`), "standalone")).toBe(true);
  });

  it("standalone: the spec's BigInt-harness shape executes the body", async () => {
    const harness = `// @ts-nocheck
function __ta_passthrough(x: any): any { return x; }
function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [1, 2];
  for (let i = 0; i < constructors.length; i++) {
    fn(constructors[i], __ta_passthrough);
  }
}
function body(TA: any): void { throw 7; }
export function test(): number { testWithBigIntTypedArrayConstructors(body); return 0; }`;
    expect(await invoked(harness, "standalone")).toBe(true);
  });

  it("gc/host: MORE args than params still invokes", async () => {
    expect(await invoked(prog(`fn(1, 2)`, `TA: any`))).toBe(true);
  });

  it("gc/host: exact arity still invokes (no regression)", async () => {
    expect(await invoked(prog(`fn(1)`, `TA: any`))).toBe(true);
  });
});
