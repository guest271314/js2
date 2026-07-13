// #3213 — inline-small must repoint an inlined call-result across ALL blocks,
// not just the block containing the call.
//
// Root cause: `inlineIntoFunction` (src/ir/passes/inline-small.ts) built its
// `callerRename` map (callSite.result → inlined return value) fresh PER BLOCK.
// When an inlined call's result is a CROSS-BLOCK value — `const b = pred(n); if
// (…) …; use b` defines `b` in the entry block but uses it in the then-block +
// continuation — the downstream uses were never repointed to the inlined return
// id, leaving `b` an undefined SSA value. `verifyIrFunction` then reported "use
// of SSA value before def" and the whole function demoted (an IR-first hard
// error, the #3203 "undefined SSA value" overlay). Fix: `callerRename` is
// function-scoped, so a call's rename reaches the blocks that consume its result
// (blocks are visited in dominance order; SSA ids are globally unique).
//
// Distinct from #2977 (that was the lower.ts emission structurizer). This is the
// inline-small pass. These functions are IR-owned; the tests assert IR-vs-legacy
// parity AND that the target is genuinely claimed (anti-vacuity).
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return instance.exports as Record<string, Function>;
}

async function compileBoth(src: string, fileName: string): Promise<{ ir: CompileResult; legacy: CompileResult }> {
  const ir = await compile(src, { fileName, experimentalIR: true });
  const prev = process.env.JS2WASM_IR_FIRST;
  process.env.JS2WASM_IR_FIRST = "0";
  try {
    const legacy = await compile(src, { fileName, experimentalIR: true });
    return { ir, legacy };
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
    else process.env.JS2WASM_IR_FIRST = prev;
  }
}

function noHardErrors(r: CompileResult): void {
  const hard = (r.errors ?? []).filter((e) => e.severity === "error");
  expect(hard.map((e) => e.message)).toEqual([]);
}

describe("#3213 — inline-small cross-block call-result rename", () => {
  it("inlined call-result used in a later block (across a mid-body if) — no undefined-SSA demote", async () => {
    // `b = pred(n)` (inlinable leaf) is defined in the entry block and used in
    // BOTH the then-block (`r = b`) and the continuation (`b * b`). Pre-fix this
    // threw "use of SSA value before def" in the post-inline verify.
    const SRC = `
      function pred(n: number): number { return n * 2 + 1; }
      export function h(n: number): number {
        const b: number = pred(n);
        let r: number = 0;
        if (b > 10) { r = b; }
        let s: number = r * r + b * b;
        return s;
      }`;
    const { ir, legacy } = await compileBoth(SRC, "h.ts");
    noHardErrors(ir);
    // Anti-vacuity: both the inlined callee and the caller are IR-owned.
    expect([...(ir.irFirstSkipped ?? [])]).toContain("h");
    const hi = (await instantiate(ir)).h;
    const hl = (await instantiate(legacy)).h;
    for (const n of [0, 2, 5, 10, 20]) {
      const expected = (() => {
        const b = n * 2 + 1;
        let r = 0;
        if (b > 10) r = b;
        return r * r + b * b;
      })();
      expect(hi(n)).toBe(expected);
      expect(hl(n)).toBe(expected);
    }
  });

  it("inlined call-result used ONLY in a later block (never in its def block)", async () => {
    // `b` is not referenced in the entry block at all — its first use is in the
    // continuation after the guard. Exercises the pure cross-block path.
    const SRC = `
      function twice(n: number): number { return n + n; }
      export function h(n: number): number {
        const b: number = twice(n);
        let acc: number = 0;
        if (n > 0) { acc = 1; }
        return acc + b + b;
      }`;
    const { ir, legacy } = await compileBoth(SRC, "h2.ts");
    noHardErrors(ir);
    expect([...(ir.irFirstSkipped ?? [])]).toContain("h");
    const hi = (await instantiate(ir)).h;
    const hl = (await instantiate(legacy)).h;
    for (const n of [-3, 0, 4]) {
      const expected = (() => {
        const b = n + n;
        let acc = 0;
        if (n > 0) acc = 1;
        return acc + b + b;
      })();
      expect(hi(n)).toBe(expected);
      expect(hl(n)).toBe(expected);
    }
  });

  it("two inlined call-results, both live across the guard", async () => {
    const SRC = `
      function inc(n: number): number { return n + 1; }
      function dbl(n: number): number { return n * 2; }
      export function h(n: number): number {
        const a: number = inc(n);
        const b: number = dbl(n);
        let r: number = 0;
        if (a > b) { r = a; }
        return r + a * a + b * b;
      }`;
    const { ir, legacy } = await compileBoth(SRC, "h3.ts");
    noHardErrors(ir);
    expect([...(ir.irFirstSkipped ?? [])]).toContain("h");
    const hi = (await instantiate(ir)).h;
    const hl = (await instantiate(legacy)).h;
    for (const n of [-2, 0, 1, 3]) {
      const expected = (() => {
        const a = n + 1;
        const b = n * 2;
        let r = 0;
        if (a > b) r = a;
        return r + a * a + b * b;
      })();
      expect(hi(n)).toBe(expected);
      expect(hl(n)).toBe(expected);
    }
  });
});
