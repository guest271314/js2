// #2106 S1 / PR-2 — hoisted `var` RegExp-match-array undefined-init retype fix.
//
// Root cause of the dominant flip-ON RegExp regression cluster (231 "illegal
// cast" fails, e.g. built-ins/RegExp/S15.10.2.6_A4_T4.js): a hoisted
// `var e = /re/.exec(s)` (function-scoped `var`, so its static type widens to
// include `undefined`) is hoist-initialized to `undefined` in an externref slot.
// Under the `undefinedSingleton` regime `emitUndefined` produces the tag-1
// `$undefined` singleton — a NON-null `$AnyValue` ref. The declaration then
// retypes the slot from externref to the concrete match-array struct ref
// `(ref null N)` (the sole externref → ref hoist retype; the general #962 guard
// refuses every other). The `local-set-coerce` stack-balance fixup then splices
// an UNGUARDED `any.convert_extern; ref.cast_null N` before the hoist
// `local.set`, which TRAPS "illegal cast" on the non-null singleton at the very
// first instruction of the function.
//
// Fix: a concrete-ref slot cannot represent the singleton anyway (it is not
// `any`), so the hoist emits the flag-OFF `ref.null.extern` value for such a var
// — casting cleanly to `ref.null N`. Byte-inert flag-OFF (gated on the regime).
//
// This test pins the hoisted-var forms — including the try-wrapped form the
// test262 harness produces — passing under flag-ON, while flag-OFF is unchanged.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string, undefinedSingleton: boolean): Promise<number | string> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    undefinedSingleton,
  });
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown"}`);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imp: any = buildImports(result.imports, undefined, (result as any).stringPool, {});
  const { instance }: any = await WebAssembly.instantiate(result.binary, imp);
  if (typeof imp.setExports === "function") imp.setExports(instance.exports);
  const mi = instance.exports.__module_init;
  if (typeof mi === "function") mi();
  return (instance.exports.test as () => number | string)();
}

// Bare hoisted `var e = re.exec(s)` then read `.length` (the union-with-undefined
// receiver that widened the slot and forced the retype).
const VAR_EXEC = `export function test(): number { var e = /\\B\\w\\B/.exec("aXb"); return e === null ? -1 : e.length; }`;

// The try-wrapped form the test262 harness emits (var decl inside a try block —
// the hoist init lives in the ROOT function body, not the try sub-body).
const TRY_WRAPPED = `export function test(): number {
  try { var e = /\\B\\w\\B/.exec("aXb"); if (e.length !== 1) return 5; } catch (x) { throw x; }
  return 0;
}`;

// No-match returns null (distinct from the undefined singleton) — must stay null.
const NO_MATCH = `export function test(): number { var e = /zzz/.exec("aXb"); return e === null ? 42 : e.length; }`;

// Element read off the hoisted match var (compared in-wasm so the result
// marshals as a number, not a native-string struct).
const VAR_MATCH_ELEM = `export function test(): number { var e = /(\\w)/.exec("hi"); return e !== null && e[0] === "h" ? 7 : 0; }`;

describe("#2106 S1 PR-2 — hoisted var RegExp-match undefined-init retype", () => {
  it("var e = exec(); e.length — flag ON (no illegal-cast trap)", async () => {
    expect(await runStandalone(VAR_EXEC, true)).toBe(1);
  });

  it("try-wrapped hoisted var (test262 harness shape) — flag ON", async () => {
    expect(await runStandalone(TRY_WRAPPED, true)).toBe(0);
  });

  it("no-match hoisted var stays null — flag ON", async () => {
    expect(await runStandalone(NO_MATCH, true)).toBe(42);
  });

  it("element read off hoisted match var — flag ON", async () => {
    expect(await runStandalone(VAR_MATCH_ELEM, true)).toBe(7);
  });

  // Flag-OFF control: identical behaviour (byte-inertness is proven separately by
  // a SHA A/B; here we assert the legacy path still produces correct results).
  it("flag OFF legacy path unchanged", async () => {
    expect(await runStandalone(VAR_EXEC, false)).toBe(1);
    expect(await runStandalone(TRY_WRAPPED, false)).toBe(0);
    expect(await runStandalone(NO_MATCH, false)).toBe(42);
    expect(await runStandalone(VAR_MATCH_ELEM, false)).toBe(7);
  });
});
