import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #3064 — pure-Wasm legacy escape() (§B.2.1.1) / unescape() (§B.2.1.2) for the
// standalone / WASI (no-JS-host) lane. #3063 added the host-mode env import but
// left standalone falling through to `null`; this completes the dual-mode pair
// with a WasmGC-native lowering (mirrors uri-encoding-native.ts). We verify the
// transform in-Wasm (string `===` on the native string result, returned as a
// 1/0 number) so no host string-marshalling is involved.

async function eq(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // No imports object — a genuine standalone module must instantiate host-free.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

// `escape(call) === expected` (or unescape) evaluated inside the module.
const check = (call: string, expected: string): string =>
  `export function test(): number { return (${call}) === (${expected}) ? 1 : 0; }`;

describe("#3064 standalone escape()", () => {
  it("encodes a space to %20", async () => {
    expect(await eq(check(`escape("a b")`, `"a%20b"`))).toBe(1);
  });

  it("leaves the unescaped set A-Za-z0-9 @*_+-./ unchanged", async () => {
    expect(await eq(check(`escape("azAZ09@*_+-./")`, `"azAZ09@*_+-./"`))).toBe(1);
  });

  it("emits %XX (uppercase) for code units < 256", async () => {
    expect(await eq(check(`escape("~")`, `"%7E"`))).toBe(1);
    expect(await eq(check(`escape("\\x00\\x01\\x02\\x03")`, `"%00%01%02%03"`))).toBe(1);
    expect(await eq(check(`escape(",")`, `"%2C"`))).toBe(1);
  });

  it("emits %uWXYZ (uppercase) for code units >= 256", async () => {
    expect(await eq(check(`escape("\\u0100\\u0101\\u0102")`, `"%u0100%u0101%u0102"`))).toBe(1);
    expect(await eq(check(`escape("\\ufffd\\ufffe\\uffff")`, `"%uFFFD%uFFFE%uFFFF"`))).toBe(1);
  });

  it("treats surrogates as individual code units", async () => {
    expect(await eq(check(`escape("\\ud834\\udf06")`, `"%uD834%uDF06"`))).toBe(1);
  });

  it("returns the empty string for the empty string", async () => {
    expect(await eq(check(`escape("")`, `""`))).toBe(1);
  });
});

describe("#3064 standalone unescape()", () => {
  it("decodes %XX", async () => {
    expect(await eq(check(`unescape("%41")`, `"A"`))).toBe(1);
    expect(await eq(check(`unescape("a%20b")`, `"a b"`))).toBe(1);
  });

  it("decodes %uXXXX", async () => {
    expect(await eq(check(`unescape("%u0041")`, `"A"`))).toBe(1);
  });

  it("matches hex digits case-insensitively", async () => {
    expect(await eq(check(`unescape("%2a")`, `"*"`))).toBe(1);
    expect(await eq(check(`unescape("%2A")`, `"*"`))).toBe(1);
    expect(await eq(check(`unescape("%u00e9")`, `"\\u00e9"`))).toBe(1);
    expect(await eq(check(`unescape("%u00E9")`, `"\\u00e9"`))).toBe(1);
  });

  it("leaves a lone or malformed % as a literal", async () => {
    expect(await eq(check(`unescape("%")`, `"%"`))).toBe(1);
    expect(await eq(check(`unescape("%0")`, `"%0"`))).toBe(1);
    expect(await eq(check(`unescape("%zz")`, `"%zz"`))).toBe(1);
    expect(await eq(check(`unescape("%GG")`, `"%GG"`))).toBe(1);
    expect(await eq(check(`unescape("%u004")`, `"%u004"`))).toBe(1);
  });

  it("honours the %XX / %uXXXX boundary conditions (§B.2.1.2)", async () => {
    // %0 is not a valid %XX (one hex digit, next unit is '%'); %29 is.
    expect(await eq(check(`unescape("%0%2900")`, `"%0)00"`))).toBe(1);
    // %u0029 embedded: the first %0 is literal, then %u0029 decodes.
    expect(await eq(check(`unescape("%0%u00290")`, `"%0)0"`))).toBe(1);
  });

  it("round-trips unescape(escape(s))", async () => {
    expect(await eq(check(`unescape(escape("Hello, World! \\u00e9 / +"))`, `"Hello, World! \\u00e9 / +"`))).toBe(1);
  });
});

describe("#3064 standalone escape/unescape are host-free", () => {
  it("emits no env import", async () => {
    const r = await compile(`export function test(): string { return unescape(escape("x %20 y")); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(true);
    // A genuine standalone module must carry no JS-host `env` imports.
    const envImports = (r.imports ?? []).filter((i: { module?: string }) => i.module === "env");
    expect(envImports).toEqual([]);
  });

  it("does not shadow a user-declared escape function", async () => {
    const r = await compile(
      `function escape(x: number): number { return x + 1; } export function test(): number { return escape(41); }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(42);
  });
});
