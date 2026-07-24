// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3592 RC2 — an UNDER-APPLIED call through the in-Wasm `__apply_closure` bridge
 * must actually happen.
 *
 * `fillApplyClosure` dispatched on the raw argument count, but
 * `__call_fn_method_N` only carries closures whose declared formal count is
 * `<= N`. So an arity-3 closure called with 2 args matched no arm and fell
 * through to the bridge's undefined sentinel — the call SILENTLY DID NOT HAPPEN.
 * That is the shape of the entire test262 assert harness
 * (`assert.sameValue(found, expected, message)` invoked with two args), which is
 * why every under-applied `assert.*` scored a VACUOUS PASS in standalone.
 *
 * The probe uses a NUMERIC channel rather than exception rendering: the module
 * records the outcome in a global and exposes it as an export, so a false
 * "it threw" can't come from the harness.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** 1 = callee returned normally (VACUOUS), 2 = callee threw (CORRECT). */
async function outcome(setup: string, call: string): Promise<number> {
  const source = `${setup}
var q = 0;
try { ${call}; q = 1; } catch (e) { q = 2; }
export function probeQ() { return q; }
`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "arity.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return Number((exports.probeQ as () => number)());
}

const THROWER = `function Host() {}
Host.m3 = function (a, b, c) { throw new Error("fired"); };
Host.m1 = function (a) { throw new Error("fired"); };`;

describe("#3592 RC2 — __apply_closure dispatches at max(argc, declaredArity)", () => {
  it("invokes a 3-formal function-object static called with 2 args", async () => {
    expect(await outcome(THROWER, `Host.m3(1, 2)`)).toBe(2);
  });

  it("invokes a 1-formal function-object static called with 0 args", async () => {
    expect(await outcome(THROWER, `Host.m1()`)).toBe(2);
  });

  it("keeps the exact-arity call working", async () => {
    expect(await outcome(THROWER, `Host.m3(1, 2, 3)`)).toBe(2);
  });

  it("keeps over-application working (extra args dropped, not refused)", async () => {
    expect(await outcome(THROWER, `Host.m1(1, 2, 3)`)).toBe(2);
  });

  it("reads a missing formal as undefined rather than a stale argument", async () => {
    const setup = `function Host2() {}
Host2.m = function (a, b, c) { if (c === undefined) { throw new Error("c is undefined"); } };`;
    expect(await outcome(setup, `Host2.m(1, 2)`)).toBe(2);
  });

  it("leaves arguments.length clamped to the formals (no synthetic extras)", async () => {
    const setup = `function Host3() {}
Host3.m = function (a, b, c) { if (arguments.length !== 3) { throw new Error("argc=" + arguments.length); } };`;
    // #820l convention: __argc is the callee's formal count, so an
    // under-applied call must report 3, never the highest dispatcher arity.
    expect(await outcome(setup, `Host3.m(1, 2)`)).toBe(1);
  });
});
