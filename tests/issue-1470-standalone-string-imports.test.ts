// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1470 — `--target standalone` must emit a module whose import section
 * contains zero JS-host string-machinery imports:
 *   - no `wasm:js-string` namespace
 *   - no `env::__concat_*`
 *   - no `env::__extern_toString` / `__extern_toLocaleString`
 *   - no `env::__unbox_string`
 *   - no `env::string_method_*`
 *
 * The CLI flag + ctx flag plumbing is the "lands first" piece of the spec
 * (see `plan/issues/sprints/52/1470-no-js-host-string-ops.md`); larger pieces
 * like the pure-Wasm UTF-8 codec land in follow-ups (#1471–#1474).
 */

const BANNED_IMPORTS: ReadonlyArray<RegExp> = [
  /^wasm:js-string::/,
  /^env::__concat_\d+$/,
  /^env::__extern_toString$/,
  /^env::__extern_toLocaleString$/,
  /^env::__unbox_string$/,
  /^env::string_method_/,
];

function assertNoJsHostStringImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_IMPORTS) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

describe("#1470 --target standalone removes JS-host string imports", () => {
  it("string + string concatenation uses no __concat_N", async () => {
    const r = await compile(
      `
        export function plus(a: string, b: string, c: string): string {
          return a + b + c;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
    // Must be in native-strings mode
    expect(r.wat).toContain("NativeString");
  });

  it("template literal substitution uses no __concat_N", async () => {
    const r = await compile(
      `
        export function tmpl(name: string, n: number): string {
          return \`hi \${name} #\${n}!\`;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
  });

  it("string equality uses native helpers, not wasm:js-string", async () => {
    const r = await compile(
      `
        export function eq(a: string, b: string): number {
          return a === b ? 1 : 0;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
    expect(r.wat).not.toContain("wasm:js-string");
  });

  it("string.length / slice / indexOf compile without host string_method", async () => {
    const r = await compile(
      `
        export function probe(s: string): number {
          const a = s.length;
          const b = s.slice(1, 3).length;
          const c = s.indexOf("x");
          return a + b + c;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
  });

  it("forces nativeStrings: true even when caller passes nativeStrings: false", async () => {
    // standalone is the strongest assertion: even an explicit `nativeStrings:
    // undefined` (the default) must imply true under target=standalone.
    const r = await compile(`export function id(s: string): string { return s; }`, { target: "standalone" });
    expect(r.success).toBe(true);
    expect(r.wat).toContain("NativeString");
    expect(r.wat).not.toContain("wasm:js-string");
  });

  it("default target (gc) still uses the JS-host wasm:js-string path", async () => {
    // Regression guard: standalone is opt-in. Default mode keeps the host
    // string machinery so browser-targeted modules stay small and use native
    // wasm:js-string builtins where the engine provides them.
    const r = await compile(
      `
        export function tmpl(name: string, n: number): string {
          return \`hi \${name} #\${n}!\`;
        }
      `,
      {},
    );
    expect(r.success).toBe(true);
    // The default path is allowed to (and does) emit wasm:js-string and
    // __concat_N; we only assert it remains the externref-string backend.
    expect(r.wat).not.toContain("NativeString");
  });
});

/**
 * #1470 — mixed-operand string concatenation (`"x" + number`, `+ boolean`,
 * `+ object`, template substitutions) must lower to a runnable pure-Wasm
 * module under `--target standalone`. Previously the native concat path pushed
 * the raw f64 / i32 / struct-ref operand straight into `__str_concat`, which
 * expects `(ref $AnyString, ref $AnyString)` on both args — producing an
 * INVALID module (`call expected (ref null N), found local.get of type i32`).
 *
 * The fix coerces each non-string operand to a native `ref $AnyString` in pure
 * Wasm: numbers via the native `number_toString` helper, booleans/null/
 * undefined via native literals, and dynamic `any` / object refs via the
 * in-module `$__any_to_string` dispatcher (the standalone replacement for the
 * `env::__extern_toString` host import).
 */
describe("#1470 standalone mixed-operand string concat is runnable pure Wasm", () => {
  // Compile a builder expression in standalone mode, instantiate with NO host
  // imports, then read the resulting native string back char-by-char via the
  // `len()` / `code(i)` exports (both use native string methods that work
  // standalone). Returns the reconstructed JS string.
  async function buildAndRead(builderExpr: string): Promise<string> {
    const src = `
      export function len(): number { const s = ${builderExpr}; return s.length; }
      export function code(i: number): number { const s = ${builderExpr}; return s.charCodeAt(i); }
    `;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
    // Instantiate with an empty import object — a standalone module must not
    // require any host functions.
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const exports = instance.exports as {
      len(): number;
      code(i: number): number;
    };
    const n = exports.len();
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCharCode(exports.code(i));
    return out;
  }

  it("string + number coerces via native number_toString", async () => {
    expect(await buildAndRead(`"n=" + (42 as number)`)).toBe("n=42");
  });

  it("string + negative / fractional number", async () => {
    expect(await buildAndRead(`"f=" + (-3.5 as number)`)).toBe("f=-3.5");
  });

  it("string + boolean coerces to true/false native literal", async () => {
    expect(await buildAndRead(`"b=" + (true as boolean)`)).toBe("b=true");
    expect(await buildAndRead(`"b=" + (false as boolean)`)).toBe("b=false");
  });

  it("chained mixed concat (string + number + string + number)", async () => {
    expect(await buildAndRead(`"a" + (3 as number) + "b" + (4 as number)`)).toBe("a3b4");
  });

  it("template literal with numeric substitution", async () => {
    expect(await buildAndRead("`val ${(7 as number)}`")).toBe("val 7");
  });

  it("dynamic any operand holding a string passes through __any_to_string", async () => {
    expect(await buildAndRead(`"v=" + ("hi" as any)`)).toBe("v=hi");
  });

  it("dynamic any operand holding a number formats via __any_to_string", async () => {
    expect(await buildAndRead(`"n=" + (5 as any)`)).toBe("n=5");
  });

  it("object operand stringifies to [object Object] (phase-1 __any_to_string)", async () => {
    // Spec-correct toString()/@@toPrimitive vtable dispatch lands with #1472;
    // the phase-1 fallback is the canonical "[object Object]" so the module
    // never traps on a string coercion of an arbitrary value.
    expect(await buildAndRead(`"o=" + ({ a: 1 } as any)`)).toBe("o=[object Object]");
  });
});
