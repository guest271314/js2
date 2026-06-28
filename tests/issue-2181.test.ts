import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

// #2181 — per-builtin representation scaffold (carried forward from #2088).
//
// The scaffold that this issue tracks landed on `main` via #2088
// (`src/codegen/builtin-scaffold.ts`): a single `StringRepr` strategy plus the
// shared `emitStringJoinFold` / `allocJoinFoldLocals` (`join`) and
// `emitVariadicStringConcat` (`fromCharCode` / `fromCodePoint`) primitives.
// Each builtin lane now supplies only the genuinely per-representation element
// load; the separator placement, the empty-array→"" fallback (the #1968 bug),
// and the variadic concat structure are defined exactly once.
//
// This file is the named cross-lane anchor for #2181 (acceptance-(2)): it pins
// BOTH the host JS-string lane and the standalone native-string lane of `join`
// and `fromCharCode`/`fromCodePoint` to the same observable behaviour. A
// deliberate bug introduced into the shared lowering regresses at least one
// assertion in EVERY lane here — the structural guarantee the issue asks for.
// (The element-load seam stays per-rep by design, and the externref-receiver
// `__array_join_any` fallback is intentionally NOT routed through the scaffold —
// a single host delegation with nothing to drift.)

async function host(expr: string): Promise<unknown> {
  const exports = await compileToWasm(`export function test(): string { return ${expr}; }`);
  return (exports as { test: () => unknown }).test();
}

function envImports(imports: ReadonlyArray<{ module: string; name: string }>): string[] {
  return imports.filter((i) => i.module === "env").map((i) => i.name);
}

// Compile a standalone (zero-host-import) module and return a numeric probe of
// the produced string. Returning a number rather than the string keeps the
// boundary host-free, so this genuinely exercises the native-string lane.
async function standaloneNum(body: string): Promise<number> {
  const r = await compile(`export function run(): number { ${body} }`, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = envImports(r.imports);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2181 join — one shared definition across lanes", () => {
  // ── host JS-string lane (hostStringRepr + emitStringJoinFold) ──
  it("host: string[] join content", async () => {
    expect(await host(`["a","b","c"].join("-")`)).toBe("a-b-c");
  });
  it("host: number[] join coerces each element (#1998)", async () => {
    expect(await host(`[1,2,3].join(",")`)).toBe("1,2,3");
  });
  it("host: empty array joins to '' not 'null' (#1968)", async () => {
    expect(await host(`([] as number[]).join(",")`)).toBe("");
  });
  it("host: default separator is ','", async () => {
    expect(await host(`[10,20].join()`)).toBe("10,20");
  });

  // ── standalone native-string lane (nativeStringRepr + emitStringJoinFold) ──
  it("standalone: string[] join length + separator content", async () => {
    // "a-b-c" → length 5; index 1 is the '-' separator (char code 45).
    expect(await standaloneNum(`const a: string[] = ["a","b","c"]; return a.join("-").length;`)).toBe(5);
    expect(await standaloneNum(`const a: string[] = ["a","b","c"]; return a.join("-").charCodeAt(1);`)).toBe(45);
  });
  it("standalone: number[] join coerces each element", async () => {
    // "1,2,3" → length 5; index 0 is '1' (49), index 1 is ',' (44).
    expect(await standaloneNum(`const a: number[] = [1,2,3]; return a.join(",").length;`)).toBe(5);
    expect(await standaloneNum(`const a: number[] = [1,2,3]; return a.join(",").charCodeAt(1);`)).toBe(44);
  });
});

describe("#2181 fromCharCode / fromCodePoint — one shared variadic concat", () => {
  // ── host lane (hostStringRepr + emitVariadicStringConcat) ──
  it("host: fromCharCode keeps ALL args (#2122 / #1955)", async () => {
    expect(await host(`String.fromCharCode(104,105,33)`)).toBe("hi!");
  });
  it("host: fromCodePoint keeps ALL args incl. surrogate pair", async () => {
    expect(await host(`String.fromCodePoint(97, 0x1F600)`)).toBe("a\u{1F600}");
  });

  // ── standalone native lane (nativeStringRepr + emitVariadicStringConcat) ──
  it("standalone: fromCharCode keeps all args (length + content)", async () => {
    // "hi!" → length 3; index 1 is 'i' (105).
    expect(await standaloneNum(`return String.fromCharCode(104,105,33).length;`)).toBe(3);
    expect(await standaloneNum(`return String.fromCharCode(104,105,33).charCodeAt(1);`)).toBe(105);
  });
  it("standalone: fromCodePoint keeps all args incl. surrogate pair", async () => {
    // "a" (1 unit) + U+1F600 (2 surrogate units) = 3 UTF-16 units.
    expect(await standaloneNum(`return String.fromCodePoint(97, 0x1F600).length;`)).toBe(3);
  });
});
