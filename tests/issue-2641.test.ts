/**
 * Issue #2641 — function/class-method/ctor/generator-method local `let`/`const`
 * that shadows a same-named MODULE-level variable was never allocated a Wasm
 * local, so every read/write fell through to the module global of the same name.
 *
 * Two defects together (see plan/issues/2641-*.md):
 *  1. `walkStmtForLetConst` (src/codegen/index.ts) skipped allocating a local
 *     for any name colliding with a module global (`moduleGlobals.has(name)`).
 *  2. class-bodies.ts method / constructor / generator-method / accessor bodies
 *     never ran the hoist passes at all.
 *
 * Symptom with native strings + class-struct types: a `global.set` against the
 * module-struct global is fed a native-string-tree value → INVALID Wasm. With
 * matching types: the module variable is silently clobbered (a miscompilation).
 *
 * These are validity + correctness tests; the shared per-process hoist/scope
 * path means batch/test262 validation is also required (done in CI), but the
 * targeted cases below pin the exact behaviors.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileToWasm } from "./equivalence/helpers.ts";

/** Compile to a binary and assert WebAssembly accepts it, for a given target. */
async function expectValid(source: string, target?: "wasi"): Promise<void> {
  const opts: Record<string, unknown> = {};
  if (target) opts.target = target;
  const r = await compile(source, opts as never);
  expect(r.binary && r.binary.length > 0).toBe(true);
  // WebAssembly.compile surfaces the precise validation error (validate() only
  // returns a boolean). The #2641 bug produced a global.set type mismatch here.
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
}

describe("#2641 lexical shadowing of module variables in function/class bodies", () => {
  // ── Validity: native-string × class-struct shadowing must emit VALID Wasm ──

  it("class METHOD: local string `s` shadowing a module var typed as a class struct → VALID (wasi)", async () => {
    const src = `
class R {
  buf: string = "";
  build(n: number): void {
    let s = "";
    let i = 0;
    while (i < n) { s += String.fromCharCode(65 + i); i = i + 1; }
    this.buf = s;
  }
}
let g: R | null = null;
function get(): R { if (g === null) g = new R(); return g; }
const s = get();
s.build(3);
`;
    await expectValid(src, "wasi");
    await expectValid(src); // default gc/JS-host target — also affected
  });

  it("class CONSTRUCTOR: local string `s` shadowing a module struct var → VALID (wasi + gc)", async () => {
    const src = `
class R {
  buf: string = "";
  constructor(n: number) {
    let s = "";
    let i = 0;
    while (i < n) { s += String.fromCharCode(65 + i); i = i + 1; }
    this.buf = s;
  }
}
let g: R | null = null;
function get(): R { if (g === null) g = new R(2); return g; }
const s = get();
`;
    await expectValid(src, "wasi");
    await expectValid(src);
  });

  it("GENERATOR method: local string `s` shadowing a module struct var → VALID (gc)", async () => {
    // The bug reproduced on the default gc/JS-host target too; assert validity
    // there. (Under --target wasi, String.fromCharCode trips a pre-existing,
    // unrelated `global_String` allowlist limitation — not #2641.)
    const src = `
class R {
  *build(n: number): Generator<string> {
    let s = "";
    let i = 0;
    while (i < n) { s += String.fromCharCode(65 + i); yield s; i = i + 1; }
  }
}
let g: R | null = null;
function get(): R { if (g === null) g = new R(); return g; }
const s = get();
`;
    await expectValid(src);
  });

  it("GENERATOR method: numeric local shadowing a module struct var → VALID (wasi + gc)", async () => {
    // String-free variant so it also holds under --target wasi.
    const src = `
class R {
  *build(n: number): Generator<number> {
    let s = 0;
    let i = 0;
    while (i < n) { s = s + i; yield s; i = i + 1; }
  }
}
let g: R | null = null;
function get(): R { if (g === null) g = new R(); return g; }
const s = get();
`;
    await expectValid(src, "wasi");
    await expectValid(src);
  });

  it("STATIC method: local string `s` shadowing a module struct var → VALID (wasi)", async () => {
    const src = `
class R {
  static build(n: number): string {
    let s = "";
    let i = 0;
    while (i < n) { s += String.fromCharCode(65 + i); i = i + 1; }
    return s;
  }
}
let g: R | null = null;
function get(): R { if (g === null) g = new R(); return g; }
const s = get();
const out = R.build(2);
`;
    await expectValid(src, "wasi");
  });

  // ── Correctness: matching-type silent aliasing must NOT clobber the module var ──

  it("free function: local `let s` shadowing a module `let s` does NOT clobber the module var", async () => {
    const src = `
function f(): number { let s = 0; s = 41; s = s + 1; return s; }
let s = 100;
export function test(): number {
  const r = f();        // f() returns 42 via its OWN local s
  return r * 1000 + s;  // module s must remain 100  →  42100
}
`;
    const exports = await compileToWasm(src);
    // Before the fix, the free-function local aliased the module global, so the
    // module `s` was clobbered to 42 → result 42042. After the fix: 42100.
    expect((exports as { test(): number }).test()).toBe(42100);
  });

  it("class method: local `let s` shadowing a module `let s` does NOT clobber the module var", async () => {
    const src = `
let s = 100;
class C {
  run(): number { let s = 0; s = 7; return s; }
}
export function test(): number {
  const c = new C();
  const r = c.run();    // 7, via the method's own local
  return r * 1000 + s;  // module s must remain 100  →  7100
}
`;
    const exports = await compileToWasm(src);
    expect((exports as { test(): number }).test()).toBe(7100);
  });

  // ── Negative control: NO shadowing — module globals must read/write normally ──

  it("negative control: module-level `let a; let b` with no function shadow still works", async () => {
    const src = `
let a = 5;
let b = 7;
export function test(): number {
  a = a + b;   // 12
  b = a - b;   // 5
  return a * 100 + b;  // 1205
}
`;
    const exports = await compileToWasm(src);
    expect((exports as { test(): number }).test()).toBe(1205);
  });

  it("negative control: function local with NO module collision still works", async () => {
    const src = `
export function test(): number {
  let local = 0;
  for (let i = 0; i < 5; i = i + 1) { local = local + i; }
  return local;  // 0+1+2+3+4 = 10
}
`;
    const exports = await compileToWasm(src);
    expect((exports as { test(): number }).test()).toBe(10);
  });

  // ── TDZ: a shadowing let accessed before its decl still throws ReferenceError ──

  it("TDZ: method-local `let s` shadowing a module var, read before decl, throws ReferenceError", async () => {
    const src = `
let s = 100;
class C {
  run(): number {
    // Access the LOCAL s before its declaration — TDZ must throw, and must
    // NOT silently fall through to the module global (which the bug allowed).
    const before = (s as number);
    let s = 5;
    return s + before;
  }
}
export function test(): number {
  const c = new C();
  try { return c.run(); } catch (e) { return -1; }
}
`;
    const exports = await compileToWasm(src);
    // TDZ access throws → caught → -1 (NOT 105 which would mean it read the module global).
    expect((exports as { test(): number }).test()).toBe(-1);
  });
});
