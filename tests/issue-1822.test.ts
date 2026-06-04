import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports, instantiateWasm } from "./src/runtime.js";

// #1822 — native String#replace / #replaceAll must expand `$` substitution
// patterns in the replacement (ECMAScript §22.1.3.19 GetSubstitution,
// string-search variant): $$ → "$", $& → matched, $` → prefix, $' → suffix.
// Other `$X` (incl. $1..$9 with no captures) stay literal. Empty-search
// replaceAll interleaves the replacement before every code unit and at the end.

// Read a native-string result by exposing length + per-index charCode.
async function runStr(expr: string): Promise<string> {
  const src = `
    export function len(): number { return (${expr}).length; }
    export function code(i: number): number { return (${expr}).charCodeAt(i); }
  `;
  const result = await compile(src, { fast: true });
  if (!result.success) {
    throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  const exp = instance.exports as { len: () => number; code: (i: number) => number };
  const len = exp.len();
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(exp.code(i));
  return s;
}

describe("#1822 — replace/replaceAll $ substitution", () => {
  it("$& → matched substring", async () => {
    expect(await runStr(`"abc".replace("b", "$&$&")`)).toBe("abbc");
  });

  it("$$ → literal dollar", async () => {
    expect(await runStr(`"a-b".replace("-", "$$")`)).toBe("a$b");
  });

  it("$` → text before the match", async () => {
    expect(await runStr('"abc".replace("b", "[$`]")')).toBe("a[a]c");
  });

  it("$' → text after the match", async () => {
    expect(await runStr(`"abc".replace("b", "[$']")`)).toBe("a[c]c");
  });

  it("replaceAll expands $& at every occurrence", async () => {
    expect(await runStr(`"a.b.c".replaceAll(".", "$&$&")`)).toBe("a..b..c");
  });

  it("unrecognised $X stays literal", async () => {
    expect(await runStr(`"x".replace("x", "a$z")`)).toBe("a$z");
    // $1 with no capture groups (string search) is literal
    expect(await runStr(`"x".replace("x", "$1")`)).toBe("$1");
  });

  it("plain replacement (no $) unchanged — regression guard", async () => {
    expect(await runStr(`"hello world".replace("world", "there")`)).toBe("hello there");
  });

  it("empty-search replaceAll interleaves replacement", async () => {
    expect(await runStr(`"ab".replaceAll("", "-")`)).toBe("-a-b-");
  });
});
