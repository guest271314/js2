// #2941 — native SYNC-generator `resumeFuncIdx` is an un-shifted late-import
// side-channel. `ctx.nativeGenerators[].resumeFuncIdx` (read at every
// .next()/.return()/.throw()/for-of/yield* bake site) was a cached plain number
// that no shift pass walked, so a late import landing after the resume function
// was emitted left the cache stale-low → a new bake targeted the wrong function
// ("call[…] need N got 1" invalid module; the ~16 class-static regressions in the
// #2938 no-yield-relax merge_group). Fix: ensureNativeGeneratorResumeFunction
// re-reads funcMap on cached hits, and shiftLateImportIndices walks
// ctx.nativeGenerators.
//
// NB the *observable* class-static desync only manifests with the #2938 relax
// active (those files are no-yield). This test guards the general native-generator
// resume-idx path across a late-import boundary; the authoritative proof is the
// 18/20 (16 invalid→valid) flip on the relax corpus documented in the issue file.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("issue #2941 — native-generator resume-idx across a late-import boundary", () => {
  it("standalone: native sync generator + native strings validates", async () => {
    const src = `
      function mk(n: number): number {
        function* g() { yield n; yield n + 1; }
        const it = g();
        const a = it.next();
        const b = it.next();
        return (a.value ?? 0) + (b.value ?? 0);
      }
      const label = (s: string): string => "v=" + s;
      export function test(): string {
        return label(String(mk(5)));
      }
    `;
    const r = await compile(src, {
      fileName: "issue-2941.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    // Either the shape is accepted (valid module) or it cleanly bails to a
    // compile error — but it must NEVER produce an invalid module.
    if (r.success && r.binary) {
      expect(WebAssembly.validate(r.binary)).toBe(true);
    } else {
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it("gc/host lane compiles unchanged (byte-inert path — no native generators)", async () => {
    const src = `export function add(a: number, b: number): number { return a + b; }`;
    const r = await compile(src, { fileName: "issue-2941-gc.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });
});
