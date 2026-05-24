// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1666 — `--target wasi` (and `--target standalone`) must emit a module that
 * **passes `WebAssembly.compile` validation** for the constructs the audit
 * (#1662) flagged as "INVALID WASM": classes/super, closures, array
 * .map/.filter/.reduce, number→string (toString/String()/template), and
 * typed-array .set.
 *
 * Two root causes were fixed:
 *
 *  A. **Func-index drift in helper bodies.** `finalizeUnifiedCollector` emits
 *     the native-string helpers into `ctx.mod.functions`, then adds late func
 *     imports (`__make_callback`, `number_toString*`, `__call_*`). `addImport`
 *     bumped the function index space but did NOT patch the already-emitted
 *     helper bodies' `call` indices, so `__str_flatten` / `__str_to_extern`
 *     ended up calling the wrong callee ("call[k] expected type <T>, found
 *     <U>"). Fixed by an eager func-index fixup in `addImport` (mirroring the
 *     long-standing global-index fixup in `addStringConstantGlobal`).
 *
 *  B. **Unbound late global (`global.get -1`).** Under nativeStrings (auto-on
 *     for wasi/standalone) string constants carry the `-1` sentinel instead of
 *     a `string_constants` global. Many dynamic-dispatch sites pushed
 *     `global.get <idx>` directly; with `idx === -1` that is an unbound global
 *     (`Invalid global index: 4294967295`). Fixed by materializing the constant
 *     inline (`stringConstantExternrefInstrs`) at every such site.
 *
 * Validity is independent of leak-elimination: number→string still legitimately
 * needs the `number_toString*` host import (#1335) and typed-array `.set` still
 * needs `__extern_get` (#1664) — those are tracked separately. This test
 * asserts the modules VALIDATE; the genuinely-standalone constructs (classes /
 * closures / array methods) additionally instantiate and return correct values
 * with an EMPTY import object.
 */

const TARGETS = ["wasi", "standalone"] as const;

async function compileAndValidate(src: string, target: (typeof TARGETS)[number]): Promise<Uint8Array> {
  const r = compile(src, { target });
  expect(r.success, `compile failed (${target}):\n${r.errors.map((e) => e.message).join("\n")}`).toBe(true);
  // The core #1666 assertion: the emitted bytes must pass WASM validation.
  await expect(
    WebAssembly.compile(r.binary),
    `module failed WebAssembly.compile validation under --target ${target}`,
  ).resolves.toBeInstanceOf(WebAssembly.Module);
  return r.binary;
}

/** Names of the `env` (JS-host) imports the module still requires. */
async function envImports(binary: Uint8Array): Promise<string[]> {
  const m = await WebAssembly.compile(binary);
  return WebAssembly.Module.imports(m)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

describe("#1666 --target wasi/standalone emits valid (compilable) Wasm", () => {
  describe("Signature A — native helper call-index drift", () => {
    it("closure capturing a local validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(`export function test(): number { let n = 5; const f = () => n * 2; return f(); }`, t);
      }
    });

    it("class with extends/super validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(
          `class A { x: number; constructor(x: number){ this.x = x; } get(){ return this.x; } }
           class B extends A { constructor(x: number){ super(x); } }
           export function test(): number { return new B(5).get(); }`,
          t,
        );
      }
    });

    it("array .map/.filter/.reduce validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(
          `export function test(): number { return [1,2,3].map(x => x*2).reduce((a,b)=>a+b, 0); }`,
          t,
        );
      }
    });

    it("template literal with number substitution validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(`export function test(x: number): string { return \`val=\${x}\`; }`, t);
      }
    });
  });

  describe("Signature B — unbound late global (global.get -1)", () => {
    it("(255).toString(16) validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(`export function test(): string { return (255).toString(16); }`, t);
      }
    });

    it("String(42) validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(`export function test(): string { return String(42); }`, t);
      }
    });

    it("(3.14159).toFixed(2) validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(`export function test(): string { return (3.14159).toFixed(2); }`, t);
      }
    });

    it("Uint8Array .set validates", async () => {
      for (const t of TARGETS) {
        await compileAndValidate(
          `export function test(): number { const a = new Uint8Array(4); a.set([1,2,3]); return a[0]+a[1]+a[2]; }`,
          t,
        );
      }
    });
  });

  describe("fully-standalone constructs instantiate with no JS host and run correctly", () => {
    it("closure: f()=n*2 returns 10 with zero env imports", async () => {
      const bin = await compileAndValidate(
        `export function test(): number { let n = 5; const f = () => n * 2; return f(); }`,
        "wasi",
      );
      expect(await envImports(bin)).toEqual([]);
      const { instance } = await WebAssembly.instantiate(bin, {});
      expect((instance.exports.test as () => number)()).toBe(10);
    });

    it("class new B(5).get() returns 5 with zero env imports", async () => {
      const bin = await compileAndValidate(
        `class A { x: number; constructor(x: number){ this.x = x; } get(){ return this.x; } }
         class B extends A { constructor(x: number){ super(x); } }
         export function test(): number { return new B(5).get(); }`,
        "wasi",
      );
      expect(await envImports(bin)).toEqual([]);
      const { instance } = await WebAssembly.instantiate(bin, {});
      expect((instance.exports.test as () => number)()).toBe(5);
    });

    it("array [1,2,3].map(x=>x*2).reduce(...) returns 12 with zero env imports", async () => {
      const bin = await compileAndValidate(
        `export function test(): number { return [1,2,3].map(x => x*2).reduce((a,b)=>a+b, 0); }`,
        "wasi",
      );
      expect(await envImports(bin)).toEqual([]);
      const { instance } = await WebAssembly.instantiate(bin, {});
      expect((instance.exports.test as () => number)()).toBe(12);
    });
  });

  describe("regression guard: default (gc) mode unchanged", () => {
    it("the same constructs still validate in gc mode", async () => {
      const srcs = [
        `export function test(): number { let n = 5; const f = () => n * 2; return f(); }`,
        `export function test(): number { return [1,2,3].map(x => x*2).reduce((a,b)=>a+b, 0); }`,
        `export function test(): string { return (255).toString(16); }`,
        `export function test(x: number): string { return \`val=\${x}\`; }`,
      ];
      for (const src of srcs) {
        const r = compile(src, {});
        expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
        await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
      }
    });
  });
});
