// #3027 — standalone: `$Object` dynamic-object-property reader residual.
//
// Root cause (narrower than the umbrella hypothesis): the ORIGINAL "$Object
// dynamic reader drops native-string values" substrate bug
// (project_standalone_any_string_value_read_substrate) was already fixed by
// #2861/#2863 — plain `const o: any = {v: "hi"}; o.v.length` and
// `o.v === "hi"` both work correctly standalone as of this issue.
//
// Re-measuring the "Cannot access property on null or undefined" residual
// (test262 standalone lane, host-import-free subset) turned up a genuinely
// DISTINCT, narrower bug sharing the same error text: COMPUTED (bracket)
// property/method access on a string-typed OR String-wrapper-typed receiver
// never dispatches to the native `__str_*` string engine in
// `--nativeStrings` mode (standalone/wasi):
//   - `"str"["length"]` (element read)         → returned 0 instead of the
//     real length (fell through to a generic struct fallback that can't
//     match "length" against the native string struct's len/off/data
//     fields).
//   - `"str"["charAt"](i)` (computed call)      → threw, because the
//     computed-call dispatcher only tries the HOST `string_<method>` import
//     (`ctx.funcMap.get("string_charAt")`), which native-strings mode never
//     registers — so `funcIdx` was always `undefined` and the call fell
//     through to the generic dynamic-dispatch fallback (null receiver call).
//   - `new String("x")["charAt"](i)` (wrapper + computed call) → same throw.
//
// The dot form (`"str".charAt(i)`, `"str".length`) already dispatched
// correctly through the native engine; the fix recompiles a computed
// string-receiver access/call as the equivalent dot form (same receiver, same
// statically-resolved key, same arguments) so it takes that exact,
// already-correct path instead of duplicating the logic.
//
// See `src/codegen/property-access.ts` (`compileElementAccess`, the #3027
// note right before the `objType = compileExpression(...)` line) and
// `src/codegen/expressions/calls.ts` (`compileCallExpression`'s
// ElementAccessExpression-callee branch, the "Try string method" section).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const envImports = r.imports.filter((i) => i.module === "env");
  expect(envImports, `unexpected env imports: ${envImports.map((i) => i.name).join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3027 standalone computed string property/method access", () => {
  it('computed element read: "abc123"["length"] === 6', async () => {
    const src = `export function test(): number {
      return "abc123"["length"] === 6 ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it('computed method call: "abc123"["charAt"](0) === "a"', async () => {
    const src = `export function test(): number {
      return "abc123"["charAt"](0) === "a" ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it('computed method call with a runtime-resolved key: "abc123"[k](5) === "3"', async () => {
    const src = `export function test(): number {
      const k = "charAt";
      return "abc123"[k](5) === "3" ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it('String-wrapper computed call: new String("abc123")["charAt"](2) === "c"', async () => {
    const src = `export function test(): number {
      return new String("abc123")["charAt"](2) === "c" ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it('String-wrapper computed length read: new String("abc123")["length"] === 6', async () => {
    const src = `export function test(): number {
      return new String("abc123")["length"] === 6 ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("dot-form access is unaffected (regression guard)", async () => {
    const src = `export function test(): number {
      const dotCharAt = "abc123".charAt(5) === "3";
      const dotLength = "abc123".length === 6;
      return dotCharAt && dotLength ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  // The exact test262 repro named in the issue (property-accessors/S11.2.1_A3_T3.js).
  it("test262 S11.2.1_A3_T3 repro shape passes standalone", async () => {
    const src = `export function test(): number {
      let fail = 0;
      if ("abc123".charAt(5) !== "3") fail = 1;
      if ("abc123"["charAt"](0) !== "a") fail = 1;
      if ("abc123".length !== 6) fail = 1;
      if ("abc123"["length"] !== 6) fail = 1;
      if (new String("abc123").length !== 6) fail = 1;
      if (new String("abc123")["charAt"](2) !== "c") fail = 1;
      return fail === 0 ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
