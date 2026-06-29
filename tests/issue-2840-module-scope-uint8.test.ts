// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2840 — module-scope `Uint8Array` must NOT be classified linear-safe.
 *
 * A top-level `const win = new Uint8Array(n)` becomes a wasm GLOBAL. The #1886
 * linear backing (`tryEmitLinearU8New`) allocates the `(ptr,len)` pair as
 * locals of the function the `new` is compiled in (here: module-init) and
 * registers them in that function's per-function `fctx.linearU8Buffers`. Those
 * locals are unreachable from every OTHER function that references the binding,
 * and the module-global GC storage is skipped — so a module-scope buffer
 * classified linear-safe is wholly inaccessible. When such a buffer is then
 * threaded into a helper whose param the analysis rewrote to `(ptr,len)`, the
 * call site cannot supply the pair and codegen raised
 * "linear Uint8Array helper argument is not backed by linear memory (#1886)".
 * This was hit only on the `.ts`-direct compile of the
 * `nm_js2wasm_node_process` Native-Messaging host (full type info → the analysis
 * runs); the `.js`/dynamic path types `Uint8Array` as `any`, so it never seeds.
 *
 * Fix: the analysis only seeds FUNCTION-LOCAL `new Uint8Array(...)` bindings as
 * linear candidates. Module-scope buffers stay on the GC path (a wasm global),
 * exactly as the dynamic path already does.
 */
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeLinearUint8 } from "../src/codegen/linear-uint8-analysis.js";
import { compile } from "../src/index.js";

function analyze(src: string): { safeNames: Set<string>; linearParamFns: Map<string, number[]> } {
  const fileName = "test.ts";
  const sourceFileObj = ts.createSourceFile(fileName, src, ts.ScriptTarget.ES2022, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) =>
      name === fileName ? sourceFileObj : ts.createSourceFile(name, "", ts.ScriptTarget.ES2022, true),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (n) => n === fileName || n === "lib.d.ts",
    readFile: (n) => (n === fileName ? src : ""),
  };
  const program = ts.createProgram([fileName], { noLib: true, target: ts.ScriptTarget.ES2022 }, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(fileName)!;
  const result = analyzeLinearUint8(checker, sf);
  const safeNames = new Set<string>();
  for (const sym of result.safeBindings) safeNames.add(sym.name);
  const linearParamFns = new Map<string, number[]>();
  for (const [fnSym, idxs] of result.linearParams) linearParamFns.set(fnSym.name, [...idxs].sort());
  return { safeNames, linearParamFns };
}

async function compileWasi(source: string): Promise<{ ok: boolean; errors: string }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  return { ok: result.success, errors: result.errors?.map((e) => e.message).join("; ") ?? "" };
}

describe("#2840 — module-scope Uint8Array is not linear-safe", () => {
  it("does NOT seed a module-scope `new Uint8Array` as linear-safe", () => {
    const { safeNames } = analyze(`
      const win: Uint8Array = new Uint8Array(16);
      function rd(b: Uint8Array): number { return b[0]; }
      export function main(): void { win[0] = 1; rd(win); }
    `);
    expect(safeNames.has("win")).toBe(false);
  });

  it("still seeds a FUNCTION-LOCAL `new Uint8Array` as linear-safe (unchanged)", () => {
    const { safeNames } = analyze(`
      export function main(): void {
        const buf = new Uint8Array(16);
        buf[0] = 1;
      }
    `);
    expect(safeNames.has("buf")).toBe(true);
  });

  it("demotes a helper param fed ONLY a module-scope buffer (no linear rewrite)", () => {
    const { safeNames, linearParamFns } = analyze(`
      const win: Uint8Array = new Uint8Array(16);
      function rd(b: Uint8Array): number { return b[0]; }
      export function main(): void { win[0] = 1; rd(win); }
    `);
    // `win` is module-scope → not safe; `rd`'s only arg is `win`, so its param
    // is demoted and the function signature is not linear-rewritten.
    expect(safeNames.has("win")).toBe(false);
    expect(linearParamFns.has("rd")).toBe(false);
  });

  it("compiles a module-scope buffer threaded into a one-level helper without the #1886 error", async () => {
    // This is the reduced nm_js2wasm_node_process shape: a module-global window
    // written directly + read via a one-level parameter helper. On the .ts path
    // (full type info) the analysis used to seed `win` linear-safe and then fail
    // the helper-arg threading. It must now compile cleanly (GC path).
    const src = `
      const win: Uint8Array = new Uint8Array(8);
      function emit(w: Uint8Array, n: number): void {
        let k = 0;
        while (k < n) { process.stdout.write(new Uint8Array([w[k]])); k = k + 1; }
      }
      function onData(chunk: string): void {
        let i = 0;
        while (i < chunk.length && i < 8) { win[i] = chunk.charCodeAt(i) & 0xff; i = i + 1; }
        emit(win, i);
      }
      function main(): void {
        process.stdin.setEncoding("latin1");
        process.stdin.on("data", (chunk: string) => { onData(chunk); });
      }
      main();
    `;
    const { ok, errors } = await compileWasi(src);
    expect(errors).not.toContain("#1886");
    expect(errors).not.toContain("not backed by linear memory");
    expect(ok).toBe(true);
  });
});
