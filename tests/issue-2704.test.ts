import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #2704 — `arguments.length` (and `arguments[i]`) was wrong when a method was
// called through an *aliased / indirect* reference (`var ref = obj.m; ref(42)`)
// rather than directly (`obj.m(42)`). The multi-funcref-type indirect dispatch
// path in compileCallExpression built each `self + args + funcref` call arm but
// never set the `__argc` / `__extras_argv` globals the callee's `arguments`
// object reads, so the callee fell back to its formal-param count — yielding 0
// for the 0-formal methods that read `arguments` (the async-gen-meth /
// static-async-gen test262 trailing-comma forms). The single-funcref arm
// already plumbed argc; this brings the multi-funcref arm to parity.

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join(" | "));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if ((imports as { setExports?: (e: unknown) => void }).setExports) {
    (imports as { setExports: (e: unknown) => void }).setExports(exports);
  }
  let ret = exports.test();
  if (ret && typeof (ret as { then?: unknown }).then === "function") ret = await ret;
  return ret;
}

describe("#2704 arguments.length on aliased / indirect method calls", () => {
  it("aliased async-generator method observes the true call-site arg count", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { async *m() { log = arguments.length; yield 1; } };
         export function test(): number { var ref = o.m; ref(42).next(); return log; }`,
      ),
    ).toBe(1);
  });

  it("aliased async-generator method counts multiple args", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { async *m() { log = arguments.length; yield 1; } };
         export function test(): number { var ref = o.m; ref(42, 99).next(); return log; }`,
      ),
    ).toBe(2);
  });

  it("aliased plain method observes the true call-site arg count", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { m() { log = arguments.length; } };
         export function test(): number { var ref = o.m; ref(42); return log; }`,
      ),
    ).toBe(1);
  });

  it("aliased sync-generator method observes the true call-site arg count", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { *m() { log = arguments.length; yield 1; } };
         export function test(): number { var ref = o.m; ref(42).next(); return log; }`,
      ),
    ).toBe(1);
  });

  it("aliased async method observes the true call-site arg count", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { async m() { log = arguments.length; } };
         export function test(): number { var ref = o.m; ref(42); return log; }`,
      ),
    ).toBe(1);
  });

  it("aliased call exposes arguments[i] values (extras region)", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { async *m() { log = arguments[1] as number; yield 1; } };
         export function test(): number { var ref = o.m; ref(42, 99).next(); return log; }`,
      ),
    ).toBe(99);
  });

  it("aliased static async-generator class method observes the arg count", async () => {
    expect(
      await run(
        `let log = -1;
         class C { static async *m() { log = arguments.length; yield 1; } }
         export function test(): number { var ref = C.m; ref(42).next(); return log; }`,
      ),
    ).toBe(1);
  });

  it("no-arg aliased call yields arguments.length 0 (no stale extras)", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { async *m() { log = arguments.length; yield 1; } };
         export function test(): number { var ref = o.m; ref().next(); return log; }`,
      ),
    ).toBe(0);
  });

  it("direct method call is unaffected", async () => {
    expect(
      await run(
        `let log = -1;
         var o = { async *m() { log = arguments.length; yield 1; } };
         export function test(): number { o.m(42).next(); return log; }`,
      ),
    ).toBe(1);
  });

  it("a sequence of aliased calls does not leak a stale arg count", async () => {
    // The first call (2 args) must not bleed __argc/__extras into the second
    // (0 args) — the reset-after in the multi-funcref dispatch guards this.
    expect(
      await run(
        `let calls = 0; let len2 = -1;
         var o = { async *m() { calls = calls + 1; if (calls === 2) len2 = arguments.length; yield 1; } };
         export function test(): number {
           var ref = o.m;
           ref(1, 2).next();
           ref().next();
           return len2;
         }`,
      ),
    ).toBe(0);
  });
});
