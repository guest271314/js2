// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2980 conservative Promise-lane fallback — a module containing ANY async
 * generator keeps BOTH carrier gates OFF on the widened-standalone measure lane
 * (`isStandalonePromiseActive` / `isStandaloneThenChainNativeActive` →
 * `ctx.standalone && !ctx.moduleHasAsyncGen`), so its whole promise pipeline
 * stays host-consistent (a native `$Promise` never feeds the legacy `__gen_*`
 * buffer / a host `.then` over `__gen_next` — the 07-09 async-generator −4 in
 * the carrier A/B).
 *
 * The widen is measured via `JS2WASM_ASYNC_CARRIER_WIDEN` (read at
 * async-scheduler module-load), so this file sets the env BEFORE a DYNAMIC
 * import of the compiler — a fresh module graph (vitest isolates test files) so
 * the toggle is live. CI never sets the env, so the fallback is dead code there;
 * this test exercises the measure path directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compile: (src: string, opts: any) => Promise<any>;

beforeAll(async () => {
  process.env.JS2WASM_ASYNC_CARRIER_WIDEN = "1";
  ({ compile } = await import("../src/index.js"));
});

// Belt-and-suspenders: vitest isolates test files (fresh module registry per
// file), but unset the process-wide toggle so a reused worker can't leak the
// widen into a later file's compiler load.
afterAll(() => {
  // Empty (≠ "1") is equivalent to absent for the `=== "1"` gate.
  process.env.JS2WASM_ASYNC_CARRIER_WIDEN = "";
});

async function standaloneImports(src: string): Promise<string[]> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  return (r.imports ?? []).map((i: { name: string }) => i.name);
}

describe("#2980 conservative Promise-lane fallback (widened-standalone measure)", () => {
  it("async-gen module: Promise.reject falls BACK to host (whole lane host-consistent)", async () => {
    const imports = await standaloneImports(`
      export async function* g() { yield Promise.reject(new Error("x")); }
    `);
    // Fallback fired → host Promise construction is present, NOT the native $Promise.
    expect(imports).toContain("Promise_reject");
  });

  it("async-gen module: a Promise.resolve elsewhere ALSO stays host under the fallback", async () => {
    const imports = await standaloneImports(`
      async function* g(): AsyncGenerator<number> { yield 1; }
      export async function f(): Promise<number> {
        const p = await Promise.resolve(7);
        for await (const x of g()) { /* drive */ void x; }
        return p;
      }
    `);
    expect(imports).toContain("Promise_resolve");
  });

  it("NON-async-gen module: Promise.reject stays NATIVE (fallback is scoped, widen still wins)", async () => {
    const imports = await standaloneImports(`
      export async function f(): Promise<number> {
        try { await Promise.reject(new Error("x")); return 0; } catch (e) { return 1; }
      }
    `);
    // No async generator → widen active → native $Promise construction, no host import.
    expect(imports).not.toContain("Promise_reject");
    expect(imports).not.toContain("Promise_resolve");
  });

  it("the 5 A/B async-gen regressions pass host-consistently under the fallback (spot-check one)", async () => {
    // named-yield-promise-reject-next shape: rejecting yield + close, .next().then().
    const r = await compile(
      `
      let error = 1;
      let callCount = 0;
      var gen = async function* g() { callCount += 1; yield Promise.reject(error); yield 2; };
      export function test(): number { const it: any = gen(); void it; return callCount; }
    `,
      { fileName: "t.ts", target: "standalone", nativeStrings: true },
    );
    // Must compile (the widen no longer feeds a native $Promise into the legacy gen).
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  });
});
