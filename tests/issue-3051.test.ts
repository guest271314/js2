/**
 * #3051 — RegExp `[@@replace]` / `[@@split]` result-array coercion protocol.
 *
 * Mirrors the `built-ins/RegExp/prototype/Symbol.replace/result-coerce-*`
 * cluster from test262. A user overrides `regexp.exec` with a compiled
 * function that returns a plain object literal used as the match result:
 *
 *   r.exec = function() { return { 0: '…', index: {valueOf(){…}}, length: … }; };
 *
 * V8's native `RegExp.prototype[@@replace]` (which we delegate to via the
 * `__regex_symbol_call` host import) reads the result through the ordinary
 * `Get(result, "0" | "index" | "length" | "groups")` + `ToString` /
 * `ToIntegerOrInfinity` / `ToLength` protocol (spec §22.2.6.11). The compiled
 * object literal is an opaque WasmGC struct, so before #3051 V8 read every
 * field as `undefined` and the coercions never ran. The fix wraps a
 * `regexp.exec` override's RETURN value in `_wrapForHost` (see `__extern_set` /
 * `extern_set_strict` in src/runtime.ts) so the native protocol observes the
 * struct's fields and dispatches the nested `valueOf` / `toString` closures.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports as never as Record<string, () => unknown>)[fn]!();
}

describe("#3051 — RegExp @@replace result-array coercion", { timeout: 30000 }, () => {
  it("coerces result 'index' via ToIntegerOrInfinity (index is an object with valueOf)", async () => {
    // test262: Symbol.replace/result-coerce-index.js
    const out = await run(`
      export function test(): string {
        const coercibleIndex: any = {
          length: 1,
          0: "",
          index: { valueOf: function(): number { return 2.9; } },
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleIndex; };
        const replacer = function(_m: string, position: number): number { return position; };
        return (r as any)[Symbol.replace]("abcd", replacer) as string;
      }
    `);
    expect(out).toBe("ab2cd");
  });

  it("coerces result[0] (matched) via ToString (matched is an object with toString)", async () => {
    // test262: Symbol.replace/result-coerce-matched.js
    const out = await run(`
      export function test(): string {
        const coercibleValue: any = {
          length: 1,
          0: { toString: function(): string { return "toString value"; } },
          index: 0,
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleValue; };
        return (r as any)[Symbol.replace]("", "foo[$&]bar") as string;
      }
    `);
    expect(out).toBe("foo[toString value]bar");
  });

  it("coerces result 'length' via ToLength (length is an object with valueOf)", async () => {
    // test262: Symbol.replace/result-coerce-length.js
    const out = await run(`
      export function test(): string {
        const coercibleIndex: any = {
          length: { valueOf: function(): number { return 3.9; } },
          0: "",
          1: "foo",
          2: "bar",
          3: "baz",
          index: 0,
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleIndex; };
        return (r as any)[Symbol.replace]("", "$1$2$3") as string;
      }
    `);
    expect(out).toBe("foobar$3");
  });

  it("coerces each capture via ToString (result-coerce-capture)", async () => {
    // test262: Symbol.replace/result-coerce-capture.js
    const out = await run(`
      export function test(): string {
        const coercibleValue: any = {
          length: 2,
          0: "",
          1: { toString: function(): string { return "toString value"; } },
          index: 0,
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleValue; };
        return (r as any)[Symbol.replace]("", "[$1]") as string;
      }
    `);
    expect(out).toBe("[toString value]");
  });

  it("reads an overridden exec result array back into wasm (round-trip)", async () => {
    const out = await run(`
      export function test(): string {
        const r = /x/;
        (r as any).exec = function(): any { return ["hello", "cap1"]; };
        const m: any = (r as any).exec("xyz");
        return (m[0] as string) + "|" + (m[1] as string) + "|len=" + (m.length as number);
      }
    `);
    expect(out).toBe("hello|cap1|len=2");
  });
});
