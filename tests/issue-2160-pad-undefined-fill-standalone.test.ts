import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2160 — Standalone String.prototype.padStart / padEnd with an explicit
//   `undefined` (or `void 0`) fillString argument.
//
//   §22.1.4.1 StringPad step 2: "If fillString is undefined, let filler be the
//   String value consisting solely of the code unit 0x0020 (SPACE)." So
//   `"abc".padEnd(5, undefined)` is spec-equivalent to `"abc".padEnd(5)` →
//   "abc  ".
//
//   The native padStart/padEnd lowering (src/codegen/string-ops.ts) took the
//   `arguments.length > 1` branch for an explicit-undefined arg and compiled it
//   via `compileExpression(undefined) + emitFlatten()`, which flattens a null
//   ref and traps with "dereferencing a null pointer in __str_flatten" in
//   standalone. Fix: treat a statically-undefined fillString as omission
//   (default single space), reusing the existing default-space emission and the
//   existing `isStaticUndefinedArg` predicate — no new #2108 coercion site.
//
//   Substrate-independent: typed string-literal receiver, no dynamic/boxed
//   `this`. `skipSemanticDiagnostics` mirrors the test262 runner.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  // Standalone output must instantiate with an EMPTY import object — any leaked
  // host import would throw here.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function runGc(src: string): Promise<unknown> {
  const r = await compile(src, { skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2160 standalone padStart/padEnd with explicit-undefined fillString", () => {
  it("padEnd(5, undefined) defaults fill to space (=== 'abc  ')", async () => {
    expect(
      await runStandalone(`export function test(): number { return "abc".padEnd(5, undefined) === "abc  " ? 1 : 0; }`),
    ).toBe(1);
  });

  it("padStart(5, undefined) defaults fill to space (=== '  abc')", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return "abc".padStart(5, undefined) === "  abc" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("padEnd(5, void 0) (void-expression form) defaults fill to space", async () => {
    expect(
      await runStandalone(`export function test(): number { return "abc".padEnd(5, void 0) === "abc  " ? 1 : 0; }`),
    ).toBe(1);
  });

  it("padStart(5, void 0) (void-expression form) defaults fill to space", async () => {
    expect(
      await runStandalone(`export function test(): number { return "abc".padStart(5, void 0) === "  abc" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("omitted fillString still works (=== 'abc  ' / '  abc')", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return "abc".padEnd(5) === "abc  " && "abc".padStart(5) === "  abc" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("explicit non-undefined fillString is unchanged (=== 'abc**' / '**abc')", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return "abc".padEnd(5, "*") === "abc**" && "abc".padStart(5, "*") === "**abc" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("multi-char fill plus undefined-fill mix (length + content)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return "x".padEnd(4, undefined).length === 4 && "x".padEnd(4, "ab") === "xaba" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("no host-import leak for the undefined-fill pad path (standalone)", async () => {
    const r = await compile(`export function test(): number { return "abc".padEnd(5, undefined).length; }`, {
      target: "standalone",
      skipSemanticDiagnostics: true,
    } as never);
    expect(r.success).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    for (const re of [/^env::__/, /^wasm:js-string::/]) {
      expect(
        labels.some((l) => re.test(l)),
        `leaked ${re.source} (imports: ${labels.join(", ")})`,
      ).toBe(false);
    }
  });

  it("gc-mode no-regression: padEnd/padStart with undefined fill still default to space", async () => {
    expect(
      await runGc(
        `export function test(): number { return "abc".padEnd(5, undefined) === "abc  " && "abc".padStart(5, undefined) === "  abc" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
