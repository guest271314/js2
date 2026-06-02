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

  it("dynamic property add on an any-typed object refuses with a #1472 Phase B error", async () => {
    const r = await compile(
      `
        export function leak(): number {
          const o: any = { x: 1 };
          o.y = 2;
          return o.y;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    const joined = r.errors.map((e) => e.message).join("\n");
    expect(joined).toMatch(/standalone/);
    expect(joined).toMatch(/#1472 Phase B/);
    // The refusal must NOT leak the host import into the module.
    assertNoHostObjectImports(r.imports);
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
