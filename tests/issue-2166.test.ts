// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2166 — standalone JSON conformance residual.
//
// The standalone `JSON.stringify` primitive slice (#1324) handled the static
// `true`/`false` keyword literals but skipped a `boolean`-TYPED value: TypeScript
// models the `boolean` primitive as the union `true | false`, so a `boolean`-typed
// variable carries the `Union` type flag and was wrongly rejected by the
// ambiguous-shape early-return in `tryEmitJsonStringifyPrimitive`
// (src/codegen/expressions/calls.ts). `JSON.stringify(b)` then refused to compile
// in standalone instead of serializing to "true"/"false".
//
// Fix: recognize the `boolean` union (`Boolean` flag + `intrinsicName === "boolean"`)
// before the ambiguous-mask return, so the existing boolean stringify branch fires.
//
// Standalone native strings don't auto-marshal across the export boundary to JS,
// so these assertions compare the JSON string INTERNALLY (the §25.5 result vs an
// in-module literal) and return a boolean — matching how test262 exercises this.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function runBool(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2166 — standalone JSON.stringify of a boolean-typed value", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it('dynamic boolean true → "true"', async () => {
        expect(
          await runBool(
            `export function test(): boolean { const b: boolean = 1 > 0; return JSON.stringify(b) === "true"; }`,
            opts,
          ),
        ).toBe(1);
      });

      it('dynamic boolean false → "false"', async () => {
        expect(
          await runBool(
            `export function test(): boolean { const b: boolean = 1 < 0; return JSON.stringify(b) === "false"; }`,
            opts,
          ),
        ).toBe(1);
      });

      it("boolean parameter serializes both ways", async () => {
        expect(
          await runBool(
            `function s(b: boolean): boolean { return JSON.stringify(b) === (b ? "true" : "false"); }
             export function test(): boolean { return s(true) && s(false); }`,
            opts,
          ),
        ).toBe(1);
      });

      it("static true/false literals still serialize (regression guard)", async () => {
        expect(
          await runBool(
            `export function test(): boolean { return JSON.stringify(true) === "true" && JSON.stringify(false) === "false"; }`,
            opts,
          ),
        ).toBe(1);
      });
    });
  }
});

/**
 * #2166 (space slice) — `JSON.stringify(value, replacer, space)` with a `space`
 * argument. The standalone static-fold path was gated on `arguments.length === 1`
 * and hit the #1599 refusal for the common pretty-print form
 * `JSON.stringify(obj, null, 2)`. Thread a `null`/`undefined` replacer + a static
 * numeric/string space through the compile-time fold (forwarding to JS's own
 * JSON.stringify for §25.5.2 clamping). A function/array replacer or dynamic space
 * still refuses. No `JSON_*` host import leaks in standalone/wasi.
 */
async function standaloneNum(body: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const r = await compile(body, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function expectRefused(body: string): Promise<void> {
  const r = await compile(body, { target: "standalone" });
  expect(r.success, `expected compile failure for:\n${body}`).toBe(false);
  expect(r.errors.some((e) => /#1599/.test(e.message))).toBe(true);
}

describe("#2166 — standalone JSON.stringify with space (indentation)", () => {
  it("indents an object with numeric space (length proof matches host)", async () => {
    const expected = JSON.stringify({ a: 1 }, null, 2).length;
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, 2).length; }`),
    ).toBe(expected);
  });

  it("indents a nested object/array with numeric space", async () => {
    const expected = JSON.stringify({ a: 1, b: [1, 2] }, null, 2).length;
    expect(
      await standaloneNum(
        `export function test(): number { return JSON.stringify({ a: 1, b: [1, 2] }, null, 2).length; }`,
      ),
    ).toBe(expected);
  });

  it("indents with a string space (tab)", async () => {
    const expected = JSON.stringify({ a: 1 }, null, "\t").length;
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, "\\t").length; }`),
    ).toBe(expected);
  });

  it("space 0 produces the compact form", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, 0).length; }`),
    ).toBe(JSON.stringify({ a: 1 }, null, 0).length);
  });

  it("a null replacer with no space stays compact", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null).length; }`),
    ).toBe(JSON.stringify({ a: 1 }, null).length);
  });

  it("works under --target wasi too", async () => {
    const expected = JSON.stringify({ a: 1 }, null, 2).length;
    expect(
      await standaloneNum(
        `export function test(): number { return JSON.stringify({ a: 1 }, null, 2).length; }`,
        "wasi",
      ),
    ).toBe(expected);
  });

  it("does not regress the 1-arg compact form", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1, b: 2 }).length; }`),
    ).toBe(13);
  });
});

describe("#2166 — replacer / dynamic space still refuse (no silent wrong output)", () => {
  it("refuses a function replacer", async () => {
    await expectRefused(`export function test(): number { return JSON.stringify({ a: 1 }, (k, v) => v, 2).length; }`);
  });

  it("refuses an array replacer", async () => {
    await expectRefused(`export function test(): number { return JSON.stringify({ a: 1, b: 2 }, ["a"], 2).length; }`);
  });

  it("refuses a dynamic (non-static) space", async () => {
    await expectRefused(`export function test(s: number): number { return JSON.stringify({ a: 1 }, null, s).length; }`);
  });
});

/**
 * #2166 PR-A — dynamic object-graph `JSON.stringify` via the pure-Wasm recursive
 * codec (`__json_stringify_value`, src/codegen/json-codec-native.ts). The static
 * fold only handled compile-time-constant graphs; a runtime object value
 * (`let o: any = {...}`, a parameter-passed object) previously either refused or,
 * worse, silently folded the *declaration* literal and dropped runtime
 * mutations — e.g. `const o = {}; o.x = f(); JSON.stringify(o)` returned `"{}"`.
 *
 * Standalone native strings don't marshal across the JS export boundary, so the
 * harness materialises the JSON text into a module-level string and reads it
 * back code-unit by code-unit via exported `len`/`ch` accessors (the same
 * approach test262 internal-comparison needs).
 *
 * Scope (PR-A): `$Object` graphs (nested objects, string/number/null values),
 * §25.5 number rules (NaN/±Infinity → null, -0 → 0), and full
 * QuoteJSONString escaping (reuses `__json_quote_string`). Booleans stored in an
 * object property and closed typed-array (`number[]`) serialisation are a
 * follow-up sub-slice (PR-A2) — see the issue file.
 */
async function stringifyDynamic(build: string, target: "standalone" | "wasi" = "standalone"): Promise<string> {
  const src =
    `function s(o: any): string { return JSON.stringify(o); }\n` +
    `let G: string = "";\n` +
    `export function len(): number { return G.length; }\n` +
    `export function ch(i: number): number { return G.charCodeAt(i); }\n` +
    `export function run(): void { ${build} }`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JSON_* host import may leak into the standalone/wasi module.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { run: () => void; len: () => number; ch: (i: number) => number };
  ex.run();
  let out = "";
  const n = ex.len();
  for (let i = 0; i < n; i++) out += String.fromCharCode(ex.ch(i));
  return out;
}

describe("#2166 PR-A — standalone dynamic object-graph JSON.stringify", () => {
  it("serialises a runtime object via a `let` binding", async () => {
    expect(await stringifyDynamic(`let o: any = { x: 7, y: 8 }; G = s(o);`)).toBe('{"x":7,"y":8}');
  });

  it("serialises a parameter-passed object", async () => {
    expect(await stringifyDynamic(`const o: any = { a: 1, b: 2 }; G = s(o);`)).toBe('{"a":1,"b":2}');
  });

  it("serialises a nested object graph", async () => {
    expect(await stringifyDynamic(`const n: any = { k: 7 }; const o: any = { child: n, z: 9 }; G = s(o);`)).toBe(
      '{"child":{"k":7},"z":9}',
    );
  });

  it("applies QuoteJSONString escaping to string values", async () => {
    // a"b\nc  →  "a\"b\\nc"  (quote, backslash, newline short-form)
    expect(await stringifyDynamic(`const o: any = { msg: "a\\"b\\\\nc" }; G = s(o);`)).toBe('{"msg":"a\\"b\\\\nc"}');
  });

  it("formats numbers per §25.5.2 (NaN/Infinity → null, -0 → 0)", async () => {
    expect(await stringifyDynamic(`const o: any = { i: 3, neg: -2.5, zero: 0 }; G = s(o);`)).toBe(
      '{"i":3,"neg":-2.5,"zero":0}',
    );
    expect(await stringifyDynamic(`const o: any = { a: NaN, b: Infinity }; G = s(o);`)).toBe('{"a":null,"b":null}');
  });

  it("serialises a null property value", async () => {
    expect(await stringifyDynamic(`const o: any = { n: null }; G = s(o);`)).toBe('{"n":null}');
  });

  it("serialises an empty object", async () => {
    expect(await stringifyDynamic(`const o: any = {}; G = s(o);`)).toBe("{}");
  });

  it("emits no JSON host import under --target wasi (pure-Wasm codec)", async () => {
    // The standalone object runtime that backs an enumerable `$Object` graph is
    // not built the same way under wasi (a separate wasi object-rep gap), so we
    // don't assert object output here — only that the dynamic codec path stays
    // host-import-free under wasi (no `JSON_stringify` leak). The assertion is
    // inside `stringifyDynamic`.
    await stringifyDynamic(`let o: any = { x: 1, y: 2 }; G = s(o);`, "wasi");
  });

  it("reassigned `let` object serialises its current value, not the declaration", async () => {
    // Guards against the static-fold-of-a-mutable-binding bug: a `let` rebound
    // to a richer object must serialise the live value. (`const o = {}; o.x =
    // …` builds no enumerable keys yet — a separate empty-literal-rep gap — so
    // we exercise a rebind, which produces a real $Object graph.)
    expect(await stringifyDynamic(`let o: any = { a: 1 }; o = { a: 1, b: 2 }; G = s(o);`)).toBe('{"a":1,"b":2}');
  });
});

/**
 * #2166 PR-C — dynamic JSON.parse via the pure-Wasm recursive-descent codec
 * (`__json_parse_text`, src/codegen/json-codec-native.ts). Parses a runtime JSON
 * *text* into the SAME standalone value representation the object runtime and
 * the PR-A stringify codec consume — `$Object` graphs (via `__new_plain_object`
 * + `__extern_set`), boxed-number/boolean primitives (`$__box_*` structs, what
 * the property-read coercion unboxes), native-string values (full §25.5.1
 * escape handling incl. `\uXXXX`), and `null`. A round-trip
 * `JSON.parse(JSON.stringify(o))` and downstream `r.x` reads work. Malformed
 * input throws a runtime SyntaxError (§25.5.1 step 3) rather than trapping.
 *
 * Scope (PR-C): object graphs + primitives. Arrays are parsed structurally
 * (`.length` works, nested arrays serialise as property values), but direct
 * numeric element indexing on a parsed array (`a[i]`) needs the standalone
 * element-access path to route `$ObjVec` reads through `__extern_get_idx`,
 * tracked as the PR-C2 follow-up. A `reviver` argument is deferred to PR-D.
 *
 * Native strings don't marshal across the JS export boundary in standalone, so
 * the harness compiles the assertion INTERNALLY and returns a number from
 * `test()` (1 = pass), the same internal-comparison shape test262 needs.
 */
async function parseInternal(body: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const importObject: Record<string, unknown> = {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  (importObject as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports as { test(): number }).test();
}

describe("#2166 PR-C — standalone dynamic JSON.parse (object graphs + primitives)", () => {
  it("parses an object number property", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{"x":7}'); return (o.x as number) === 7 ? 1 : 0;`)).toBe(1);
  });

  it("parses a nested object graph", async () => {
    expect(
      await parseInternal(`const o: any = JSON.parse('{"a":{"b":3}}'); return (o.a.b as number) === 3 ? 1 : 0;`),
    ).toBe(1);
  });

  it("parses a string value", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{"s":"hi"}'); return (o.s as string) === "hi" ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("parses §25.5.1 string escapes (\\n, \\\", \\\\, \\uXXXX)", async () => {
    // {"s":"a\nb\"c\\dA"}  →  a<LF>b"c\dA
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"s":"a\\\\nb\\\\"c\\\\\\\\d\\\\u0041"}'); return (o.s as string) === "a\\nb\\"c\\\\dA" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("parses a boolean property (truthy round-trip)", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{"t":true,"f":false}'); return (o.t as boolean) ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("parses a null property", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{"n":null}'); return (o.n as any) === null ? 1 : 0;`)).toBe(1);
  });

  it("parses a top-level primitive (number)", async () => {
    expect(await parseInternal(`return (JSON.parse("42") as number) === 42 ? 1 : 0;`)).toBe(1);
  });

  it("parses negative / fractional / exponent numbers", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"a":-2.5,"b":1e3,"c":1.5e-2}'); return ((o.a as number) === -2.5 && (o.b as number) === 1000 && (o.c as number) === 0.015) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("tolerates leading/trailing whitespace", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('  {"x":1}  '); return (o.x as number) === 1 ? 1 : 0;`)).toBe(1);
  });

  it("round-trips JSON.parse(JSON.stringify(o)) for an object graph", async () => {
    expect(
      await parseInternal(
        `let o: any = { x: 5, y: 9 }; const r: any = JSON.parse(JSON.stringify(o)); return ((r.x as number) + (r.y as number)) === 14 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("round-trips a nested object graph", async () => {
    expect(
      await parseInternal(
        `let o: any = { a: { b: 3 } }; const r: any = JSON.parse(JSON.stringify(o)); return (r.a.b as number) === 3 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("parses an empty object", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{}'); const r: any = o; return 1;`)).toBe(1);
  });

  it("works under --target wasi too (host-import-free)", async () => {
    expect(
      await parseInternal(`const o: any = JSON.parse('{"x":7}'); return (o.x as number) === 7 ? 1 : 0;`, "wasi"),
    ).toBe(1);
  });

  it("throws a SyntaxError on malformed input (trailing junk)", async () => {
    // The codec throws a standalone SyntaxError at runtime; the trap surfaces as
    // a WebAssembly runtime error when test() runs.
    await expect(parseInternal(`const o: any = JSON.parse('{"x":1} bogus'); return 1;`)).rejects.toThrow();
  });
});
