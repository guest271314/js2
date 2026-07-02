// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2972 — proven-in-bounds string element reads on the IR path.
//
// The largest divergence class from #2138's Slice-3 flagged run (14 of 15
// regressions): the selector claims functions containing `s[computedIndex]`
// on a string receiver, but from-ast had no string-receiver element-access
// arm and threw `not in slice 12` post-claim — a silent compile-twice demote
// flag-off, a hard error on a skipped slot under JS2WASM_IR_FIRST.
//
// The fix (see the scoping analysis in plan/issues/2972-*.md for why the
// naive alternatives are unsound):
//   - `stringIndexProvenBelow` (src/ir/capability.ts — the single-source
//     guard): index is a non-negative int literal < len, or `<expr> & K`
//     with a non-negative int32 mask K < len (ToInt32 ⇒ result ∈ [0, K]).
//   - `collectStringLiteralLens` (from-ast): receivers bound once to a
//     string literal and never reassigned (incl. nested-function writes)
//     have a statically known length.
//   - Proven reads delegate to the EXISTING charAt machinery
//     (`s[i] ≡ s.charAt(i)` for integer 0 ≤ i < len — §22.1.3.1/§10.4.3);
//     the `string_charAt`/`__str_charAt` helper is pre-registered by the
//     new element-access arm of the unified collector scan.
//   - UNPROVEN reads keep the demote path (an OOB `s[i]` is `undefined`,
//     charAt is `""` — typing the result `string` would be unsound).
import { describe, expect, it, vi } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { stringIndexProvenBelow } from "../src/ir/capability.js";
import { ts } from "../src/ts-api.js";

// The test262 harness shape (decimalToHexString.js), const-declared so the
// selector's vardecl gate accepts it in .ts mode.
const HARNESS_SRC = `
function decimalToPercentHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  return "%" + hex[(n >> 4) & 0xf] + hex[n & 0xf];
}
export function run(n: number): string {
  return decimalToPercentHexString(n);
}
`;

async function compileFlag(irFirst: boolean, src: string): Promise<CompileResult> {
  vi.stubEnv("JS2WASM_IR_FIRST", irFirst ? "1" : "");
  try {
    return await compile(src, { fileName: "issue-2972.ts" });
  } finally {
    vi.unstubAllEnvs();
  }
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#2972 proven-in-bounds string element read (IR path)", () => {
  it("selector claims the harness shape; IR compiles it with zero post-claim errors", async () => {
    const ast = analyzeSource(HARNESS_SRC);
    const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
    expect(sel.funcs.has("decimalToPercentHexString")).toBe(true);
    const r = await compileFlag(false, HARNESS_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irPostClaimErrors ?? []).toEqual([]);
  });

  it("bit-correct results, flag-off AND under JS2WASM_IR_FIRST (legacy body skipped)", async () => {
    for (const flag of [false, true]) {
      const r = await compileFlag(flag, HARNESS_SRC);
      expect(r.success).toBe(true);
      if (flag) expect(r.irFirstSkipped).toContain("decimalToPercentHexString");
      const exp = await instantiate(r);
      const run = exp.run as (n: number) => string;
      expect(run(0xab)).toBe("%AB");
      expect(run(0)).toBe("%00");
      expect(run(0xff)).toBe("%FF");
      expect(run(0x5)).toBe("%05");
    }
  });

  it("UNPROVEN index shapes keep the sound demote path (no wrong-answer typing)", async () => {
    // Plain param index — could be OOB (s[i] is undefined, charAt is "") —
    // must NOT be claimed into the charAt read. It demotes to legacy, which
    // preserves exact JS semantics including OOB.
    const src = `
export function pick(i: number): string {
  const hex = "0123456789ABCDEF";
  return "" + hex[i];
}
`;
    const r = await compileFlag(false, src);
    expect(r.success).toBe(true);
    const exp = await instantiate(r);
    const pick = exp.pick as (i: number) => string;
    expect(pick(3)).toBe("3");
    expect(pick(99)).toBe("undefined"); // "" + undefined — OOB semantics preserved
  });

  it("proof predicate: literals, masks, and the rejections", () => {
    const sf = ts.createSourceFile(
      "p.ts",
      "const a = s[5]; const b = s[(n >> 4) & 0xf]; const c = s[15 & n]; const d = s[n & 0x1f]; const e = s[n + 1]; const f = s[-1];",
      ts.ScriptTarget.Latest,
      true,
    );
    const idx: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node)) idx.push(node.argumentExpression);
      node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    const [lit5, mask0xf, maskLeft15, mask0x1f, addExpr, negLit] = idx;
    expect(stringIndexProvenBelow(lit5!, 16)).toBe(true); // 5 < 16
    expect(stringIndexProvenBelow(lit5!, 5)).toBe(false); // 5 !< 5
    expect(stringIndexProvenBelow(mask0xf!, 16)).toBe(true); // [0,15] < 16
    expect(stringIndexProvenBelow(maskLeft15!, 16)).toBe(true); // K on the left
    expect(stringIndexProvenBelow(mask0x1f!, 16)).toBe(false); // [0,31] !< 16
    expect(stringIndexProvenBelow(addExpr!, 16)).toBe(false); // unbounded
    expect(stringIndexProvenBelow(negLit!, 16)).toBe(false); // not a non-neg literal
  });

  it("reassigned receiver loses the literal-length fact → demote (still correct)", async () => {
    const src = `
export function swap(n: number): string {
  let hex = "0123456789ABCDEF";
  hex = "abcdef";
  return "" + hex[n & 0x3];
}
`;
    const r = await compileFlag(false, src);
    expect(r.success).toBe(true);
    const exp = await instantiate(r);
    expect((exp.swap as (n: number) => string)(1)).toBe("b"); // reassigned value governs
  });
});
