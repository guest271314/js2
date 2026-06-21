// #1712 — the two root causes behind compiled acorn's tokenizer identity loop.
// acorn's `parseTopLevel` guard `this.type !== types$1.eof` never tripped, so
// the parser looped forever. Bisected to two INDEPENDENT compiler defects, both
// pinned here with minimal repros that mirror acorn's exact shapes:
//
// BUG 1 — dynamic-method struct-field write never reached the WasmGC field.
//   A `this.field = v` inside a fnctor-instance method body went through the
//   host bridge (__extern_set_strict → _safeSet), which writes the SIDECAR but
//   gated the `__sset_<field>` struct-field writeback on the `exports` PARAM —
//   absent on that path (only `callbackState` is passed). A later STATIC
//   `struct.get` read (the guarded-cast struct branch the compiler takes when
//   the receiver ref-tests as the struct type) bypasses the sidecar and reads
//   the raw field, still holding its initializer. So a method write was
//   invisible to a struct-typed read — acorn's `this.type = types.eof` (write)
//   vs `this.type !== types.eof` (guard read) disagreed forever.
//
// BUG 2 — `any`-receiver String.prototype.replace mis-dispatched to a DOM
//   extern class and DROPPED the replacement arg. `value.replace(/re/g, "rep")`
//   on an untyped receiver first-matched CSSStyleSheet.replace(text) (one arg →
//   replacement dropped → host ran replace with `undefined`) or
//   DOMTokenList.replace(a,b) (returns boolean). This broke acorn's
//   `wordsRegexp(words){ return new RegExp("^(?:"+words.replace(/ /g,"|")+")$") }`
//   so keyword recognition failed and every token mis-classified as `name`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#1712 — compiled-acorn tokenizer identity loop root causes", () => {
  it("BUG1: struct value written through a method is read back identical (==)", async () => {
    // Mirrors acorn's `finishToken(type){ this.type = type }` write +
    // `parseTopLevel` read of `this.type` compared against `types.eof`.
    const exp = await run(`
      // @ts-nocheck
      var TokenType = function TokenType(label) { this.label = label; };
      var types = { eof: new TokenType("eof"), name: new TokenType("name") };
      var Box = function Box() { this.t = types.name; };
      var bp = Box.prototype;
      bp.store = function (v) { this.t = v; };
      bp.load = function () { return this.t; };
      export function roundTrip() {
        var b = new Box();
        b.store(types.eof);
        return b.load() === types.eof ? 1 : 0; // identity preserved -> 1
      }
    `);
    expect(exp.roundTrip()).toBe(1);
  });

  it("BUG1: an acorn-shape this.type guard loop TERMINATES (no infinite loop)", async () => {
    // The whole tokenizer loop shape in miniature: an fnctor Parser whose
    // prototype methods set/read `this.type` against a module-global token
    // table. Before the fix this never terminated.
    const exp = await run(`
      // @ts-nocheck
      var TokenType = function TokenType(label) { this.label = label; };
      var types = { eof: new TokenType("eof"), name: new TokenType("name") };
      var Parser = function Parser() { this.type = types.name; this.steps = 0; };
      var pp = Parser.prototype;
      pp.finishToken = function (type) { this.type = type; };
      pp.nextToken = function () {
        if (this.steps >= 1) { return this.finishToken(types.eof); }
        return this.finishToken(types.name);
      };
      pp.run = function () {
        while (this.type !== types.eof) {
          this.steps = this.steps + 1;
          this.nextToken();
          if (this.steps > 100) { break; } // hard cap so a real bug is visible
        }
        return this.steps;
      };
      export function main() { return new Parser().run(); }
    `);
    // Oracle: loop runs exactly once (step 1 -> nextToken sets eof -> guard trips).
    expect(exp.main()).toBe(1);
  });

  it("BUG2: replace(regex, str) on an `any` receiver keeps the replacement arg", async () => {
    // A RegExp literal elsewhere registers DOM extern classes (CSSStyleSheet /
    // DOMTokenList) that also declare `replace`; on an `any` receiver the call
    // must NOT bind to those and drop the replacement.
    const exp = await run(`
      // @ts-nocheck
      function anyReplace(words) { return words.replace(/ /g, "|"); }
      export function viaAny() { return anyReplace("a b c"); } // expect "a|b|c"
    `);
    expect(exp.viaAny()).toBe("a|b|c");
  });

  it("BUG2: acorn's wordsRegexp builds the correct alternation pattern", async () => {
    // The exact acorn construction. Before the fix the source came out as
    // "^(?:varundefinedreturnundefinedif)$" (replacement dropped) or "^(?:false)$".
    const exp = await run(`
      // @ts-nocheck
      function wordsRegexp(words) {
        return new RegExp("^(?:" + words.replace(/ /g, "|") + ")$");
      }
      export function pattern() { return wordsRegexp("var return if").source; }
    `);
    expect(exp.pattern()).toBe("^(?:var|return|if)$");
  });

  it("BUG2: keyword recognition through an instance-field regex works", async () => {
    // readWord shape: `if (this.keywords.test(word)) type = keywords[word]`.
    const exp = await run(`
      // @ts-nocheck
      function wordsRegexp(words) {
        return new RegExp("^(?:" + words.replace(/ /g, "|") + ")$");
      }
      var TokenType = function TokenType(label) { this.label = label; };
      var names = { name: new TokenType("name") };
      var keywords = {};
      keywords["var"] = new TokenType("var");
      var Lexer = function Lexer() { this.keywords = wordsRegexp("var return if"); };
      var lp = Lexer.prototype;
      lp.classify = function (word) {
        var type = names.name;
        if (this.keywords.test(word)) { type = keywords[word]; }
        return type.label;
      };
      export function classifyVar() { return new Lexer().classify("var"); }
    `);
    expect(exp.classifyVar()).toBe("var");
  });
});
