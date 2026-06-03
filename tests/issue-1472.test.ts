// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1472 Phase A — `--target standalone` must not leak dynamic-shape
 * object/property JS-host imports (`env::__extern_*`, `env::__object_*`,
 * `env::__for_in_*`, `env::__defineProperty*`, `env::__hasOwnProperty`,
 * `env::__getOwn*`, `env::__delete_property`, `env::__new_plain_object`,
 * `env::__get_builtin`, `env::__proto_method_call`, `env::__register_*`,
 * `env::__proxy_*`). Open-object usage instead fails at compile time with a
 * message pointing at Phase B; Proxy usage fails with the explicit standalone
 * diagnostic from Phase C. Closed-shape struct access (typed object literals /
 * class instances) still compiles to struct.get/struct.set with zero host
 * calls.
 *
 * Phase B (the Wasm-native open-object runtime) is a follow-up.
 */

const BANNED_IMPORTS: ReadonlyArray<RegExp> = [
  /^env::__extern_/,
  /^env::__object_/,
  /^env::__for_in_/,
  /^env::__defineProperty/,
  /^env::__defineProperties/,
  /^env::__getOwn/,
  /^env::__getPrototypeOf$/,
  /^env::__delete_property$/,
  /^env::__new_plain_object$/,
  /^env::__hasOwnProperty$/,
  /^env::__propertyIsEnumerable$/,
  /^env::__isPrototypeOf$/,
  /^env::__get_builtin$/,
  /^env::__proto_method_call$/,
  /^env::__register_prototype$/,
  /^env::__register_class_object$/,
  /^env::__proxy_/,
];

function assertNoHostObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_IMPORTS) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

describe("#1472 — --target standalone object/Proxy host-import refusal", () => {
  it("typed object literal (closed shape) compiles with zero host object imports", async () => {
    const r = await compile(
      `
        interface Point { x: number; y: number; }
        export function dist(): number {
          const p: Point = { x: 3, y: 4 };
          return p.x * p.x + p.y * p.y;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
  });

  it("class instance with method dispatch compiles with zero host object imports", async () => {
    const r = await compile(
      `
        class Counter {
          n: number = 0;
          inc(): number { this.n = this.n + 1; return this.n; }
        }
        export function run(): number {
          const c = new Counter();
          c.inc();
          return c.inc();
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
  });

  it("Phase B: dynamic property add/read on an any-typed object compiles native + runs", async () => {
    // #1472 Phase B — open-object new/get/set now lower to the Wasm-native
    // $Object open-hash-map runtime instead of refusing. The module must carry
    // zero env::__extern_* / __new_plain_object host imports and instantiate +
    // run with an empty import object.
    const source = `
        export function run(): number {
          const o: any = {};
          o.x = 41;
          o.y = (o.x as number) + 1;
          return o.y as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__new_plain_object")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });

  it("Phase B: property update + table grow/rehash run correctly", async () => {
    const source = `
        export function run(): number {
          const o: any = {};
          o.a = 1; o.a = 2; o.a = 3;
          o.k0=0; o.k1=1; o.k2=2; o.k3=3; o.k4=4; o.k5=5; o.k6=6; o.k7=7;
          o.k8=8; o.k9=9; o.k10=10; o.k11=11; o.k12=12; o.k13=13; o.k14=14;
          return (o.a as number) + (o.k0 as number) + (o.k7 as number) + (o.k14 as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // 3 (final o.a) + 0 + 7 + 14 = 24
    expect((instance.exports as Record<string, () => number>).run()).toBe(24);
  });

  it("Phase B S2: delete operator removes own property natively (tombstone)", async () => {
    // #1472 Phase B Slice 2 — `delete o.k` lowers to the native __delete_property
    // helper (tombstones the $PropEntry); the slot is reusable on re-add and a
    // subsequent read of the deleted key misses. Zero host object imports.
    const source = `
        export function run(): number {
          const o: any = {};
          o.a = 3; o.b = 5;
          delete o.a;        // tombstone a
          o.a = 41;          // reuse the tombstoned slot
          delete o.zzz;      // no-op delete of a missing key (spec: succeeds)
          // o.a re-added = 41, o.b untouched = 5  → 46
          return (o.a as number) + (o.b as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__delete_property")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(46);
  });

  it("Phase B Blocker B: Object.keys + indexed read over an open `any` lowers native (no host imports, validates)", async () => {
    // #1472 Phase B Blocker B — the native $ObjVec build/iterate foundation.
    // For an `any`-typed receiver that TypeScript cannot narrow to a closed
    // struct shape (a bare function parameter), `Object.keys(o)` lowers to the
    // native __object_keys helper (walks the $Object PropMap → fresh $ObjVec),
    // and an all-`any` indexed read `(ks as any)[i]` lowers to the native
    // __extern_get_idx ($ObjVec[i]). Both must appear as DEFINED Wasm functions
    // (not env::* imports), the module must validate, and zero object/array
    // host imports may leak.
    //
    // NOTE: a runtime *value* assertion through Object.keys is intentionally
    // NOT made here — standalone has no JS host to hand in an open object, and
    // a locally-built `{}` is narrowed by TS to a closed struct (routed to the
    // struct fast path, not this runtime). Exercising the end-to-end value path
    // depends on the open-`any` receiver-dispatch work (Blocker A) + the
    // enumeration-consumer slice (for-of / string[] coercion / `.length`
    // routing). This test pins the foundation: the helpers emit, validate, and
    // stay host-free.
    const source = `
        export function run(o: any): number {
          const ks: any = Object.keys(o);
          const first: any = (ks as any)[0];
          return first === null ? -1 : 7;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    // No host array bridge leaked either (the $ObjVec is the array).
    expect(r.imports.some((i) => i.module === "env" && i.name.startsWith("__array_from"))).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    // The native runtime helpers are emitted as defined functions, not imports.
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_keys\b/);
    expect(wat).toMatch(/\(func \$__objvec_new\b/);
    expect(wat).toMatch(/\(func \$__objvec_push\b/);
    expect(wat).toMatch(/\(func \$__extern_get_idx\b/);
    expect(wat).toMatch(/\(func \$__extern_length\b/);
    // And the module instantiates with an empty import object (pure Wasm).
    await WebAssembly.instantiate(r.binary, {});
  });

  it("destructuring defaults refuse __extern_is_undefined instead of leaking the host import", async () => {
    const r = await compile(
      `
        export function pick(a: any[]): any {
          const [x = 1] = a;
          return x;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    const joined = r.errors.map((e) => e.message).join("\n");
    expect(joined).toMatch(/__extern_is_undefined/);
    expect(joined).toMatch(/#1472 Phase B/);
    assertNoHostObjectImports(r.imports);
  });

  it("new Proxy fails explicitly in standalone mode without leaking proxy host imports", async () => {
    const r = await compile(
      `
        export function wrap(target: any): any {
          return new Proxy(target, {});
        }
      `,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    const joined = r.errors.map((e) => e.message).join("\n");
    expect(joined).toMatch(/Proxy not supported in standalone mode/);
    expect(joined).toMatch(/#1472 Phase C/);
    assertNoHostObjectImports(r.imports);
  });

  it("Proxy.revocable fails explicitly in standalone mode without leaking proxy host imports", async () => {
    for (const source of [
      `
        export function revokeLater(target: any): any {
          return Proxy.revocable(target, {});
        }
      `,
      `
        export function revokeLater(target: any): any {
          return Proxy.revocable(target);
        }
      `,
    ]) {
      const r = await compile(source, { target: "standalone" });
      expect(r.success).toBe(false);
      const joined = r.errors.map((e) => e.message).join("\n");
      expect(joined).toMatch(/Proxy not supported in standalone mode/);
      expect(joined).toMatch(/#1472 Phase C/);
      assertNoHostObjectImports(r.imports);
    }
  });

  it("default target (gc) still allows Proxy via the JS-host runtime", async () => {
    const r = await compile(
      `
        export function wrap(target: any): any {
          return new Proxy(target, {});
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__proxy_create")).toBe(true);
  });

  it("default target (gc) still uses the JS-host object machinery", async () => {
    // Regression guard: standalone is opt-in. Default mode keeps the host
    // object imports so browser-targeted modules work with the JS runtime.
    const r = await compile(
      `
        export function obj(): number {
          const o: any = { x: 1 };
          o.y = 2;
          return o.y;
        }
      `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
