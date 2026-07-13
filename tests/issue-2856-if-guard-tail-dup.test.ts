// #2856 — from-ast overlay bug: a mid-body non-terminating statement-`if`
// followed by trailing `let` declarations that read a MULTI-USE local.
//
// Root cause (lower.ts structurizer): the non-terminating mid-body `if (cond)
// { <side effect> } <rest>` rewrite (from-ast `lowerStatementList`) lowers to a
// `br_if` whose continuation block holding `<rest>` is reached from BOTH the
// then-block's `br` and the `br_if`'s false edge. The structurizer
// tail-DUPLICATES that continuation into each arm of the wasm `if`. An
// intra-block MULTI-USE value defined in the continuation (`let t = f*f; let t2
// = t*t`) is lazily materialized (`local.tee`) on first use — but the
// `materialized` bookkeeping set was function-GLOBAL, so the then-arm copy
// marked the value materialized and the else-arm copy then read a local the
// else path never set (silent 0, or an "undefined SSA value" throw for a
// cross-block def). The two arms are separate runtime paths, so `materialized`
// must be snapshotted at the branch and restored before each arm.
//
// This was the "from-ast mis-scopes a let after a non-returning statement-if
// into the then-branch" bug flagged from PRs #2966/#3203 (the `classify`
// "undefined SSA value" overlay) and #2972/#3204 (Math.log `log(2.414)`
// returned `log(2)`, worked around with ternary-init locals).
//
// These functions are CLAIMED by the IR path (skipped under the IR-first
// default). Before the fix they compiled to wrong output; the tests assert
// IR-on vs IR-off (legacy) parity AND that the function is genuinely IR-owned
// (anti-vacuity — a demote-to-legacy would keep the test green while NOT
// exercising the fixed path).
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

describe("#2856 — mid-body non-terminating if + trailing multi-use local", () => {
  it("recomputes the continuation's multi-use local on BOTH if arms", async () => {
    // `t = f*f` is used TWICE by `t2 = t*t`, and lives in the continuation
    // that is tail-duplicated into both arms of the `if`. Pre-fix: the else
    // path (branch not taken) read t as 0 -> t2 = 0.
    const SRC = `
      export function g(x: number): number {
        let f: number = x;
        if (f > 1.4) { f = f * 0.5; }
        let t: number = f * f;
        let t2: number = t * t;
        return t2;
      }`;
    const { ir, legacy } = await compileBoth(SRC, "g.ts");
    noHardErrors(ir);
    // Anti-vacuity: the function is genuinely IR-owned, not demoted to legacy.
    expect([...(ir.irFirstSkipped ?? [])]).toContain("g");
    const gi = (await instantiate(ir)).g;
    const gl = (await instantiate(legacy)).g;
    for (const x of [1.2, 2.0, 3.0, 10, 0.5]) {
      // branch-not-taken (x<=1.4) is the regressing path; branch-taken too.
      const expected = (() => {
        let f = x;
        if (f > 1.4) f = f * 0.5;
        const t = f * f;
        return t * t;
      })();
      expect(gi(x)).toBe(expected);
      expect(gl(x)).toBe(expected);
    }
  });

  it("matches legacy for the Math.log range-reduction shape (loops + guard + poly)", async () => {
    // The exact #3204 shape: two while loops mutate f/e, a non-terminating
    // `if (f > sqrt2)` guard, then a chain of trailing lets (t, t2, p) that
    // each read a prior multi-use local.
    const SRC = `
      export function logish(x: number): number {
        let e: number = 0;
        let f: number = x;
        while (f >= 2) { f = f * 0.5; e = e + 1; }
        while (f < 0.5) { f = f * 2; e = e - 1; }
        if (f > 1.4142135623730951) { f = f * 0.5; e = e + 1; }
        let t: number = (f - 1) / (f + 1);
        let t2: number = t * t;
        let p: number = (t2 + 1) * t * 2;
        return p + e * 0.6931471805599453;
      }`;
    const { ir, legacy } = await compileBoth(SRC, "logish.ts");
    noHardErrors(ir);
    expect([...(ir.irFirstSkipped ?? [])]).toContain("logish");
    const fi = (await instantiate(ir)).logish;
    const fl = (await instantiate(legacy)).logish;
    for (const x of [0.7, 1.0, 1.2, 2.0, 2.414, 5.0, 100, 0.1]) {
      expect(fi(x)).toBe(fl(x)); // bit-for-bit IR-vs-legacy parity
    }
  });

  it("nested non-terminating ifs each followed by trailing multi-use lets", async () => {
    const SRC = `
      export function h(n: number): number {
        let a: number = n;
        if (a > 1) { a = a + 1; }
        if (a > 5) { a = a * 2; }
        let q: number = a * a;
        let z: number = q * q;
        return z;
      }`;
    const { ir, legacy } = await compileBoth(SRC, "h.ts");
    noHardErrors(ir);
    expect([...(ir.irFirstSkipped ?? [])]).toContain("h");
    const hi = (await instantiate(ir)).h;
    const hl = (await instantiate(legacy)).h;
    for (const n of [0, 3, 6, 10]) {
      const expected = (() => {
        let a = n;
        if (a > 1) a = a + 1;
        if (a > 5) a = a * 2;
        const q = a * a;
        return q * q;
      })();
      expect(hi(n)).toBe(expected);
      expect(hl(n)).toBe(expected);
    }
  });

  it("single-use trailing local after the guard stays correct (control)", async () => {
    // The single-use path was never broken (inlined at use site, never
    // materialized) — lock it so a future change can't regress it.
    const SRC = `
      export function g(x: number): number {
        let f: number = x;
        if (f > 1.4) { f = f * 0.5; }
        let t: number = f + 1;
        return t;
      }`;
    const { ir } = await compileBoth(SRC, "g2.ts");
    noHardErrors(ir);
    expect([...(ir.irFirstSkipped ?? [])]).toContain("g");
    const g = (await instantiate(ir)).g;
    expect(g(1.0)).toBe(2.0);
    expect(g(3.0)).toBe(2.5);
  });
});
