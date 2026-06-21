import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2503 — standalone ToPrimitive on operator receivers (the forward `string ==
// object/any` shape, the §7.2.15 string⇄boolean step, and `string == wrapper`).
//
// In standalone mode (`--target standalone`, nativeStrings, no JS host) the
// abstract-equality `==`/`!=` lowering used to short-circuit a static-string LEFT
// operand against an `any`/object/wrapper RIGHT into a pure native-string content
// compare (`compileStringBinaryOp`), bypassing §7.2.15 ToPrimitive/ToNumber. That
// returned a spurious `false` for the entire `string == object` cluster (the
// "Cannot convert object to primitive value" / loose-eq residual). The fix routes
// these through the native abstract-equality cascade, which boxes the string ref
// to externref and dispatches on the runtime tag (string⇄string content compare,
// string⇄number / string⇄boolean ToNumber, Object→`__to_primitive`).
//
// The reverse shape (`any == "lit"`) was already correct via #2503b; these tests
// lock the FORWARD shape and the wrapper/boolean steps so they cannot regress.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2503 standalone ToPrimitive on == receivers", () => {
  it("string == object with user valueOf reduces to its primitive", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = {valueOf: () => "x"}; return ("x" == (o as any)) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("string == object with user toString (no primitive valueOf) reduces", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = {toString: () => "x"}; return ("x" == (o as any)) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("string == any-param holding a number ToNumber-compares (§7.2.15 4-7)", async () => {
    expect(
      await runStandalone(
        `function f(x: any) { return ("5.0" == x) ? 1 : 0; } export function test(): number { return f(5); }`,
      ),
    ).toBe(1);
  });

  it("string == any holding a non-numeric string is false (no spurious coerce)", async () => {
    expect(
      await runStandalone(
        `function f(x: any) { return ("ab" == x) ? 1 : 0; } export function test(): number { return f("cd"); }`,
      ),
    ).toBe(0);
  });

  it("string == any holding null is false (§7.2.15 never coerces a nullish)", async () => {
    expect(
      await runStandalone(
        `function f(x: any) { return ("ab" == x) ? 1 : 0; } export function test(): number { return f(null as any); }`,
      ),
    ).toBe(0);
  });

  it("string == new String wrapper reduces via [[PrimitiveValue]]", async () => {
    expect(await runStandalone(`export function test(): number { return ("x" == new String("x")) ? 1 : 0; }`)).toBe(1);
  });

  it("string == new Number wrapper ToNumber-compares", async () => {
    expect(await runStandalone(`export function test(): number { return ("-1" == new Number(-1)) ? 1 : 0; }`)).toBe(1);
  });

  it("string == new Boolean wrapper reduces then String⇄Boolean ToNumber (§7.2.15 step 8)", async () => {
    expect(await runStandalone(`export function test(): number { return ("1" == new Boolean(true)) ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("number == object with user valueOf reduces", async () => {
    expect(
      await runStandalone(`export function test(): number { return (1 == ({valueOf: () => 1} as any)) ? 1 : 0; }`),
    ).toBe(1);
  });

  it("boolean == object with user valueOf reduces (ToNumber both)", async () => {
    expect(
      await runStandalone(`export function test(): number { return (true == ({valueOf: () => 1} as any)) ? 1 : 0; }`),
    ).toBe(1);
  });

  it("two new String wrappers compare by identity (not content) — false", async () => {
    expect(
      await runStandalone(`export function test(): number { return (new String("x") == new String("x")) ? 1 : 0; }`),
    ).toBe(0);
  });

  it("strict === string vs object stays false (no coercion)", async () => {
    expect(
      await runStandalone(
        `function f(x: any) { return ("x" === x) ? 1 : 0; } export function test(): number { return f({valueOf: () => "x"}); }`,
      ),
    ).toBe(0);
  });
});
