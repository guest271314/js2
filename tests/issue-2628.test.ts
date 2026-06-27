import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2628 — method call on a `__construct_closure`-constructed instance.
//
// `new this(...)` inside a function-constructor (fnctor) static method routes
// through the #56/#2608 `__construct_closure` host bridge, which returns a
// host-built instance object. Before the fix that object was a bare `{}` with no
// `[[Prototype]]` link and no `_fnctorInstanceCtor` registration, so a
// subsequent prototype-method call on it (`new this(...).m()` — acorn's
// `new this(options, input).parse()` shape) threw "m is not a function", even
// though the identifier form `new Parser(...).m()` resolved.
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as any)[fn](...args);
}

const PARSER_SRC = `
var Parser = function Parser(opts: any, input: any) {
  this.input = String(input);
};
Parser.prototype.getLen = function () {
  return this.input.length;
};
Parser.prototype.twice = function () {
  return this.getLen() * 2;
};

Parser.parseViaThis = function (input: any): number {
  var p: any = new this({}, input);
  return p.getLen();
};
Parser.parseViaIdent = function (input: any): number {
  var p: any = new Parser({}, input);
  return p.getLen();
};
Parser.chainViaThis = function (input: any): number {
  var p: any = new this({}, input);
  return p.twice();
};

export function viaThis(): number { return Parser.parseViaThis("hello"); }
export function viaIdent(): number { return Parser.parseViaIdent("hello"); }
export function chainViaThis(): number { return Parser.chainViaThis("hello"); }
`;

describe("#2628 — method call on a __construct_closure-constructed instance", () => {
  it("resolves a prototype method on a `new this(...)`-built instance (acorn parse shape)", async () => {
    expect(await run(PARSER_SRC, "viaThis")).toBe(5);
  });

  it("still resolves on an identifier-constructed instance (no regression)", async () => {
    expect(await run(PARSER_SRC, "viaIdent")).toBe(5);
  });

  it("resolves a method that itself calls another prototype method via `this`", async () => {
    expect(await run(PARSER_SRC, "chainViaThis")).toBe(10);
  });
});
