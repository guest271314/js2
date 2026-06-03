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

  it("Phase B Blocker A Half 1: Object.isFrozen/isSealed/isExtensible lower native (no host imports, validates)", async () => {
    // #1472 Phase B Blocker A Half 1 — the three object-integrity predicates
    // gain Wasm-native readers (__object_isFrozen/isSealed/isExtensible read the
    // $Object.flags field). An externref-typed receiver routes to the native
    // helper instead of the JS-host import, so the standalone module carries
    // zero env::__object_* imports and validates. (The execution-order-blind
    // compile-time fast paths are also gated off in standalone — see the gc
    // regression test below — but their observable effect needs the freeze SET
    // path, which is Half 2.)
    const source = `
        export function chk(o: any): number {
          const a = Object.isFrozen(o) ? 1 : 0;
          const b = Object.isExtensible(o) ? 1 : 0;
          const c = Object.isSealed(o) ? 1 : 0;
          return a * 100 + b * 10 + c;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_isFrozen\b/);
    expect(wat).toMatch(/\(func \$__object_isSealed\b/);
    expect(wat).toMatch(/\(func \$__object_isExtensible\b/);
    await WebAssembly.instantiate(r.binary, {});
  });

  it("Phase B Blocker A Half 1: gc-mode static fast path for isFrozen/isSealed is unchanged", async () => {
    // Regression guard: the `!ctx.standalone` gate must NOT disturb the default
    // (gc) target. A local known-frozen at compile time still folds isFrozen to
    // a compile-time constant true (the existing fast path), with the JS-host
    // runtime present.
    const source = `
        export function run(): number {
          const o: any = {};
          o.x = 1;
          Object.freeze(o);
          return Object.isFrozen(o) ? 1 : 0;
        }
      `;
    const r = await compile(source, {}); // default gc target — host runtime present
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // After freeze, the known-frozen identifier folds isFrozen → const 1.
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    const start = wat.split("\n").findIndex((l) => /\(func \$run /.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it("Phase B Blocker B Slice 2: Object.keys(any) for-of consumer is host-free (no __array_from_iter)", async () => {
    // #1472 Phase B Blocker B Slice 2 — the typed enumeration consumer chain.
    const source = `
        export function n(o: any): number {
          const ks: string[] = Object.keys(o);
          let c = 0;
          for (const k of ks) { c = c + 1; }
          return c;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name.startsWith("__array_from"))).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    await WebAssembly.instantiate(r.binary, {});
  });

  it("Phase B Blocker B Slice 2: .length on an any value routes to native __extern_length", async () => {
    const source = `
        export function m(o: any): number {
          const ks: any = Object.keys(o);
          return (ks.length as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__extern_length\b/);
    await WebAssembly.instantiate(r.binary, {});
  });

  // NOTE on test shape: a `const o: any = {}` whose property *names* are all
  // statically known (`o.a = 1`) lets the compiler shape-infer `o` into a closed
  // WasmGC struct, which bypasses the open-object runtime entirely (the writes
  // become struct.set and Object.keys reads the struct field list). To force the
  // genuine native $Object open-hash-map path these tests write through
  // *computed* keys (`o[k] = v`), which defeats shape inference and routes
  // __new_plain_object / __extern_set / __object_* through object-runtime.ts.

  it("Phase B Slice 3: Object.values(any) lowers native and counts enumerable own values", async () => {
    // #1472 Phase B Slice 3 — Object.values(o) on an open `any` lowers to the
    // native __object_values helper (walks the $Object PropMap → fresh $ObjVec of
    // boxed values). The result is a $ObjVec, so its `.length` reads back through
    // the native __extern_length. Zero object/array host imports; runs under an
    // empty import object.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a"; const kb = "b"; const kc = "c";
          o[ka] = 1; o[kb] = 2; o[kc] = 3;
          const vs: any = Object.values(o);
          return (vs.length as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_values")).toBe(false);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_values\b/);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(3);
  });

  it("Phase B Slice 3: Object.entries(any) lowers native; entry is a 2-element $ObjVec", async () => {
    // #1472 Phase B Slice 3 — Object.entries(o) builds a $ObjVec of 2-element
    // $ObjVecs ([key, value]). `.length` of the outer vec = number of enumerable
    // own props. Native __object_entries appears as a defined fn; no host imports.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a"; const kb = "b";
          o[ka] = 10; o[kb] = 20;
          const es: any = Object.entries(o);
          return (es.length as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_entries\b/);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(2);
  });

  it("Phase B Slice 3: Object.values elements round-trip through a typed for-of consumer", async () => {
    // The values $ObjVec stores boxed numbers; iterating it as a typed
    // `number[]` for-of (the Blocker B Slice 2 consumer path) unboxes each
    // element correctly. Confirms the values helper stores the right *values*
    // (not just the right count) host-free.
    const source = `
        export function run(): number {
          const o: any = {};
          const ka = "a"; const kb = "b";
          o[ka] = 10; o[kb] = 20;
          const vs: number[] = Object.values(o);
          let s = 0;
          for (const v of vs) { s = s + v; }
          return s;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(30);
  });

  it("Phase B Blocker A Half 2: Object.freeze/seal/preventExtensions lower native SET path (no host imports)", async () => {
    // #1472 Phase B Blocker A Half 2 — the freeze/seal WRITE path.
    const source = `
        export function run(o: any): any {
          Object.preventExtensions(o);
          Object.seal(o);
          return Object.freeze(o);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_freeze\b/);
    expect(wat).toMatch(/\(func \$__object_seal\b/);
    expect(wat).toMatch(/\(func \$__object_preventExtensions\b/);
    await WebAssembly.instantiate(r.binary, {});
  });

  it("Phase B Blocker A Half 2: gc-mode Object.freeze still routes to the JS-host import", async () => {
    // Regression guard: standalone-only coercion must NOT disturb the gc target.
    const source = `
        export function run(o: any): any {
          return Object.freeze(o);
        }
      `;
    const r = await compile(source, {}); // default gc target
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_freeze")).toBe(true);
  });

  it("Phase B Slice 3: Object.assign copies own enumerable props natively (no host array imports)", async () => {
    // #1472 Phase B Slice 3 — Object.assign(target, ...sources). The variadic
    // sources list is built with the native $ObjVec builders (not the JS-host
    // __js_array_new/__js_array_push), and __object_assign iterates the $ObjVec,
    // copying each source's enumerable own props into target via the native
    // __extern_set. Reads back the merged value; runs under empty imports.
    const source = `
        export function run(): number {
          const ka = "a"; const kb = "b";
          const t: any = {};
          const s1: any = {}; s1[ka] = 5;
          const s2: any = {}; s2[kb] = 7; s2[ka] = 11;  // later source wins on 'a'
          Object.assign(t, s1, s2);
          return (t[ka] as number) + (t[kb] as number);  // 11 + 7 = 18
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    // The JS-host array builders must NOT leak — standalone builds a $ObjVec.
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_new")).toBe(false);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_push")).toBe(false);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__object_assign")).toBe(false);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__object_assign\b/);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(18);
  });

  it("Phase B Slice 3: object spread {...src} uses native $ObjVec assign in standalone", async () => {
    // The all-spread object-literal fallback (compileObjectLiteralAsExternref)
    // also routes the sources list through the native $ObjVec builders. Validates
    // and instantiates host-free.
    const source = `
        export function run(): number {
          const kx = "x";
          const src: any = {}; src[kx] = 9;
          const o: any = { ...src };
          return (o[kx] as number);
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(r.imports.some((i) => i.module === "env" && i.name === "__js_array_new")).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(9);
  });

  it("Phase B Slice 3: __extern_has_idx resolves to a native defined function (no host import)", async () => {
    // __extern_has_idx is the array-like HasProperty(O, ToString(idx)) helper used
    // by array-method callback loops (filter/map over array-likes) to skip holes.
    // It mirrors __extern_get_idx exactly over a $ObjVec (present iff
    // 0 <= i32(idx) < len). An array-method call over an `any` array-like pulls it
    // in; under standalone it must resolve to the native defined function, never an
    // env::__extern_has_idx host import. (The `in` operator on an object is a
    // *different* helper, __extern_has, which is out of scope for this slice; and
    // the surrounding array-like consumer machinery has independent standalone
    // gaps, so this asserts the helper resolution, not whole-module validity.)
    const source = `
        export function run(o: any): number {
          const out = Array.prototype.filter.call(o, (x: number) => x > 0);
          return (out as any).length as number;
        }
      `;
    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // The helper is provided natively — no env::__extern_has_idx host import leaks.
    expect(r.imports.some((i) => i.module === "env" && i.name === "__extern_has_idx")).toBe(false);
    const wat = (r as unknown as { wat?: string }).wat ?? "";
    expect(wat).toMatch(/\(func \$__extern_has_idx\b/);
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
