// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3006 — GENUINE, identity-stable reified builtin CONSTRUCTOR objects (standalone).
 *
 * Extends #2963's "reify builtins as first-class values" substrate to
 * `<Builtin>.prototype.constructor === <Builtin>`. Round-5 leak analysis (#2999)
 * flagged 9 standalone passes whose sole `env::` import was
 * `Object_get_constructor` — all `<Builtin>.prototype.constructor === <Builtin>`
 * (Set / WeakMap / WeakRef / WeakSet / RegExp / FinalizationRegistry /
 * DisposableStack / SuppressedError) plus instance forms.
 *
 * The SUPERSEDED approach (#2537) folded `.constructor` to `ref.null.extern`,
 * which passed only via a null≡null tautology — `Set.prototype.constructor === Map`
 * ALSO passed (both null). This PR instead routes BOTH the bare builtin identifier
 * (`… === Set`) AND the `.constructor` read to the SAME per-name
 * `__builtin_ctor_<Name>` `$Object` singleton, so identity is GENUINE: same builtin
 * → same object (true), distinct builtins → distinct objects (false).
 *
 * The comparisons below use inline `===` (concrete-ref `ref.eq` path) and a CLEAN
 * SameValue helper (`if (a===b) return true`) — both of which genuinely exercise
 * WasmGC reference identity. (The verbatim test262 `assert._isSameValue`, which
 * contains `1/a === 1/b`, has a SEPARATE, pre-existing lowering bug that ToNumber-
 * coerces `any` operands and makes `a===b` collapse for ALL objects — reproducible
 * with plain `{}`/`{}` object literals and untouched by this PR — so it is not a
 * faithful identity oracle. The 9 test262 files still PASS regardless, since they
 * only assert the TRUE case; see the issue file's honest-accounting note.)
 */

async function standaloneImports(src: string): Promise<string[]> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r.imports.map((i) => `${i.module}::${i.name}`);
}

async function runStandalone(src: string): Promise<number> {
  const full = `function isSameValue(a: any, b: any): boolean { if (a === b) { return true; } return a !== a && b !== b; }\nexport function test(): number { ${src} }`;
  const r = await compile(full, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

const HOST_IMPORT = "env::Object_get_constructor";
const CTORS = [
  "Set",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "RegExp",
  "FinalizationRegistry",
  "DisposableStack",
  "SuppressedError",
] as const;

describe("#3006 — genuine reified builtin-constructor identity (standalone)", () => {
  for (const c of CTORS) {
    it(`${c}.prototype.constructor === ${c} is GENUINELY true, host-free`, async () => {
      const src = `return isSameValue(${c}.prototype.constructor, ${c}) ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
      const imports = await standaloneImports(
        `export function test(): number { const c: any = ${c}.prototype.constructor; return c ? 1 : 0; }`,
      );
      expect(imports, `leaked ${HOST_IMPORT}`).not.toContain(HOST_IMPORT);
    });
  }

  // The genuine-correctness guard (memory
  // `project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous`): a
  // wrong-builtin cross-check MUST be false — the #2537 null-fold made it true.
  it("swap-wrong-builtin: Set.prototype.constructor === Map is GENUINELY false", async () => {
    expect(await runStandalone(`return isSameValue(Set.prototype.constructor, Map) ? 1 : 0;`)).toBe(0);
  });

  it("swap-wrong-builtin: WeakMap.prototype.constructor === Set is GENUINELY false", async () => {
    expect(await runStandalone(`return isSameValue(WeakMap.prototype.constructor, Set) ? 1 : 0;`)).toBe(0);
  });

  it("bare builtin identifiers have distinct genuine identity (Set !== Map, Set === Set)", async () => {
    expect(await runStandalone(`return isSameValue(Set, Set) ? 1 : 0;`)).toBe(1);
    expect(await runStandalone(`return isSameValue(Set, Map) ? 1 : 0;`)).toBe(0);
    // inline (concrete-ref ref.eq path)
    const r = await compile(`export function test(): number { return ((Set as any) === (Map as any)) ? 1 : 0; }`, {
      target: "standalone",
      nativeStrings: true,
    });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(0);
  });

  it("instance-form (new WeakMap()).constructor === WeakMap is genuinely true; === Set is false", async () => {
    expect(await runStandalone(`return isSameValue((new WeakMap()).constructor, WeakMap) ? 1 : 0;`)).toBe(1);
    expect(await runStandalone(`return isSameValue((new WeakMap()).constructor, Set) ? 1 : 0;`)).toBe(0);
  });

  it("regexp-literal instance .constructor === RegExp is genuinely true; === Set is false; host-free", async () => {
    expect(await runStandalone(`const re = /[^a]*/; return isSameValue(re.constructor, RegExp) ? 1 : 0;`)).toBe(1);
    expect(await runStandalone(`const re = /[^a]*/; return isSameValue(re.constructor, Set) ? 1 : 0;`)).toBe(0);
    const imports = await standaloneImports(
      `export function test(): number { const re = /a/; const c: any = re.constructor; return c ? 1 : 0; }`,
    );
    expect(imports).not.toContain(HOST_IMPORT);
  });

  it("gc/host lane keeps the real Object_get_constructor read (fold is standalone-only)", async () => {
    const r = await compile(
      `export function test(): number { const a: any = Set.prototype.constructor; const b: any = Set; return a === b ? 1 : 0; }`,
      { skipSemanticDiagnostics: true },
    );
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.map((i) => `${i.module}::${i.name}`)).toContain(HOST_IMPORT);
  });
});
