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

/*
 * #2166 PR-B — dynamic object-graph `JSON.stringify(value, null, space)` with
 * §25.5.2 indentation. PR-A serialised dynamic graphs *compactly* only; a
 * `space` argument forced the #1599 refusal (the static-fold path owns the
 * static-value-static-space form, but a runtime-built graph never reaches it).
 *
 * PR-B threads a per-level indent unit ("gap") through the pure-Wasm recursive
 * codec (`__json_stringify_root_indent`). A *static* number/string `space` is
 * resolved at compile time to the gap (`min(10, floor(n))` spaces, or the first
 * 10 chars of a string; ≤0/"" → compact). A function/array replacer or a
 * *dynamic* space still keeps the refusal.
 *
 * Standalone native strings don't marshal across the export boundary, so the
 * result is read back char-by-char and compared to Node's own
 * `JSON.stringify(value, null, space)` — exact §25.5.2 parity.
 */
async function stringifyDynamicSpace(
  build: string,
  sBody: string,
  target: "standalone" | "wasi" = "standalone",
): Promise<string> {
  const src =
    `function s(o: any): string { return ${sBody}; }\n` +
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

describe("#2166 PR-B — standalone dynamic object-graph JSON.stringify indentation", () => {
  it("indents a flat object with numeric space 2", async () => {
    const want = JSON.stringify({ x: 7, y: 8 }, null, 2);
    expect(await stringifyDynamicSpace(`let o: any = { x: 7, y: 8 }; G = s(o);`, `JSON.stringify(o, null, 2)`)).toBe(
      want,
    );
  });

  it("indents a nested object graph (per-level indent grows with depth)", async () => {
    const want = JSON.stringify({ child: { k: 7 }, z: 9 }, null, 2);
    expect(
      await stringifyDynamicSpace(
        `const n: any = { k: 7 }; const o: any = { child: n, z: 9 }; G = s(o);`,
        `JSON.stringify(o, null, 2)`,
      ),
    ).toBe(want);
  });

  it("indents a deeply nested graph with space 2", async () => {
    const want = JSON.stringify({ b: { c: { d: 4 } }, e: 5 }, null, 2);
    expect(
      await stringifyDynamicSpace(
        `const a: any = { d: 4 }; const b: any = { c: a }; const o: any = { b: b, e: 5 }; G = s(o);`,
        `JSON.stringify(o, null, 2)`,
      ),
    ).toBe(want);
  });

  it("uses a string space (tab) as the indent unit", async () => {
    const want = JSON.stringify({ a: 1, b: 2 }, null, "\t");
    expect(
      await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o, null, "\\t")`),
    ).toBe(want);
  });

  it("uses a multi-char string space", async () => {
    const want = JSON.stringify({ a: 1, b: 2 }, null, "xy");
    expect(
      await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o, null, "xy")`),
    ).toBe(want);
  });

  it("clamps a numeric space > 10 to 10 spaces (§25.5.2)", async () => {
    const want = JSON.stringify({ x: 1 }, null, 15);
    expect(await stringifyDynamicSpace(`let o: any = { x: 1 }; G = s(o);`, `JSON.stringify(o, null, 15)`)).toBe(want);
  });

  it("space 0 produces the compact form (no indentation)", async () => {
    const want = JSON.stringify({ a: 1, b: 2 }, null, 0);
    expect(await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o, null, 0)`)).toBe(
      want,
    );
    expect(want).toBe('{"a":1,"b":2}');
  });

  it("indents a null property value", async () => {
    const want = JSON.stringify({ n: null, x: 1 }, null, 2);
    expect(
      await stringifyDynamicSpace(`let o: any = { n: null, x: 1 }; G = s(o);`, `JSON.stringify(o, null, 2)`),
    ).toBe(want);
  });

  it("keeps an empty object compact even with a space (§25.5.2)", async () => {
    const want = JSON.stringify({ a: {}, b: 2 }, null, 2);
    expect(
      await stringifyDynamicSpace(`const e: any = {}; let o: any = { a: e, b: 2 }; G = s(o);`, `JSON.stringify(o, null, 2)`),
    ).toBe(want);
  });

  it("stays host-import-free under --target wasi with a space arg", async () => {
    // As with PR-A, the wasi object-rep differs, so only assert no host-import
    // leak (the assertion lives inside stringifyDynamicSpace).
    await stringifyDynamicSpace(`let o: any = { x: 1, y: 2 }; G = s(o);`, `JSON.stringify(o, null, 2)`, "wasi");
  });

  it("a 1-arg dynamic stringify stays compact (PR-A regression guard)", async () => {
    expect(await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o)`)).toBe(
      '{"a":1,"b":2}',
    );
  });
});
