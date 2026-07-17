// (#3343) A block-scoped `for (let i)` loop counter INSIDE a recursive function
// was compiled to a shared MODULE GLOBAL whenever a same-named module-level
// variable existed — so a recursive call's inner loop clobbered the outer
// loop's counter, and an exhaustive recursive walk of a multi-node tree ran
// away (spurious re-iteration / back-edge).
//
// Root cause: `compileForStatement` (src/codegen/statements/loops.ts) bound a
// for-head declaration to `ctx.moduleGlobals.get(name)` whenever the name was
// not already a function local. A `let`/`const` for-head binding is NOT hoisted
// into `localMap` (only `var` is), so the `hasLocalShadow` guard missed it and
// the block-scoped counter aliased the module global. A `for (let i)` ALWAYS
// creates a fresh lexical binding (ECMA-262 §14.7.4); inside a function it must
// be a per-invocation LOCAL and must never alias a module-level `i`.
//
// This is exactly the compiled-acorn E0/E2 runaway (#3308/#2928): acorn has a
// top-level `i` → global `$__mod_i`, so every function's `for (let i)` shared
// one global; a recursive in-Wasm AST walk re-iterated forever once the tree
// had nested arrays (inner length-1 loops leave the shared counter at 1, so the
// outer loop sticks). Faithful reads, corrupted control flow — NOT a $Object
// read bug.
//
// Fix: `compileForStatement` skips the module-global path for a block-scoped
// `let`/`const` for-head binding inside any function (only `__module_init`, the
// module top level, keeps using the module global). `var` is unchanged.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// A recursive walker with a `for (let i)` loop over an array field, in a module
// that ALSO declares a top-level `i` (→ `$__mod_i` global — the acorn trigger).
// Pre-fix the loop counter aliased `$__mod_i`, so `walk` re-iterated a nested
// subtree forever and the budget-guarded count came back wrong (not 13).
const SRC = `
let i: number = 0;                       // module-level i → $__mod_i global
export function tick(): number { i = i + 1; return i; }  // keep i live

let budget: number = 0;
let hit: number = 0;

function w(node: any): number {
  if (budget <= 0) { hit = 1; return 0; }
  budget = budget - 1;
  if (node === null || node === undefined) return 0;
  if (typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let n = 0;
    const len: number = (node as any).length;
    for (let i = 0; i < len; i++) {           // <- the block-scoped counter
      if (budget <= 0) { hit = 1; return n; }
      n = n + w(node[i]);                      // <- recursion clobbered $__mod_i pre-fix
    }
    return n;
  }
  const t = node.type;
  if (typeof t !== "string" || (t as string).length === 0) return 0;
  let n = 1;
  n = n + w(node.body);
  n = n + w(node.expression);
  n = n + w(node.arguments);
  return n;
}

export function walkAst(ast: any, b: number): number {
  budget = b; hit = 0;
  const c = w(ast);
  return hit ? -99999 : c;                     // -99999 = runaway (budget exhausted)
}
`;

async function instantiate(source: string) {
  const result = await compile(source, { fileName: "repro.mts", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, (...a: unknown[]) => unknown>;
}

describe("#3343 for-let loop counter must not alias a module global (recursive-walk runaway)", () => {
  it("exhaustive recursive walk of a multi-statement tree terminates with the correct node count", async () => {
    const exp = await instantiate(SRC);

    // A tree with a length-4 outer array whose children each recurse through a
    // length-1 `arguments` array — the exact nesting that made the shared-global
    // counter stick at index 2 pre-fix.
    const id = { type: "Identifier" };
    const call = { type: "CallExpression", arguments: [id] };
    const stmt = (type: string) => ({ type, expression: call });
    const prog = {
      type: "Program",
      body: [stmt("S0"), stmt("S1"), stmt("S2"), stmt("S3")],
    };

    // Program + 4 statements + 4 calls + 4 identifiers = 13 nodes.
    const count = exp.walkAst(prog, 100000);
    expect(count).toBe(13); // pre-fix: -99999 (runaway) or a wrong re-iterated count
  });

  it("the module-level `i` global still works independently of the loop counters", async () => {
    const exp = await instantiate(SRC);
    expect(exp.tick()).toBe(1);
    expect(exp.tick()).toBe(2);
    expect(exp.tick()).toBe(3);
  });
});
