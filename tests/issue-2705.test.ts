import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2705 — for-in head lexical scope (let/const TDZ during receiver eval +
// post-loop restore), LHS non-simple targets, var-head visibility.
//
// These exercise the scoping/dispatch fixes in `compileForInStatement`
// (src/codegen/statements/loops.ts), the `var x;` redeclaration no-op
// (src/codegen/statements/variables.ts), the boxed-TDZ `typeof` runtime path
// (src/codegen/typeof-delete.ts), and the receiver-closure TDZ classification
// (src/codegen/closures.ts). Compiled in `--target standalone` so the binary
// instantiates with NO host imports; results are numeric so no native-string
// readback is needed.
async function run(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2705 for-in head lexical scope / LHS targets / var visibility", () => {
  it("var-head: body `var x;` redeclaration does not clobber the enumerated key", async () => {
    // The body `var x;` is a runtime no-op (§14.3.2.1); it must NOT reset the
    // loop variable to undefined. Pre-fix it re-emitted __get_undefined.
    expect(
      await run(`let r = 0;
for (var x in { attr: 1 }) { var x; if (x === 'attr') r = 1; }
export function test(): number { return r; }`),
    ).toBe(1);
  });

  it("parenthesized identifier head `for ((x) in obj)` binds the key", async () => {
    expect(
      await run(`let r = 0; let x = '';
for ((x) in { attr: 1 }) { if (x === 'attr') r = 1; }
export function test(): number { return r; }`),
    ).toBe(1);
  });

  it("null receiver yields zero iterations (no invalid Wasm / trap)", async () => {
    expect(
      await run(`let r = 5;
for (var k in (null as any)) { r = 0; }
export function test(): number { return r; }`),
    ).toBe(5);
  });

  it("head `let` binding is in TDZ while the receiver is evaluated (ReferenceError)", async () => {
    // Reading the head `x` (here via a computed key) inside the receiver must
    // throw, observing the head TDZ binding, not the outer `let x = 1`.
    expect(
      await run(`function f(): number {
  let x = 1;
  try { for (let x in ({ [x]: 1 } as any)) {} return 0; } catch (e) { return 1; }
}
export function test(): number { return f(); }`),
    ).toBe(1);
  });

  it("head `const` binding is in TDZ while the receiver is evaluated (ReferenceError)", async () => {
    expect(
      await run(`function f(): number {
  let x = 1;
  try { for (const x in ({ [x]: 1 } as any)) {} return 0; } catch (e) { return 1; }
}
export function test(): number { return f(); }`),
    ).toBe(1);
  });

  it("a closure built in the receiver captures the head binding's TDZ (typeof throws)", async () => {
    // §14.7.5.6: the receiver's closure captures the never-initialized head
    // binding; calling it later must throw — `typeof x` must NOT static-fold.
    expect(
      await run(`function f(): number {
  let probe: any;
  for (let x in ({ ['k']: (probe = function () { typeof x; }) } as any)) {}
  try { probe(); return 0; } catch (e) { return 1; }
}
export function test(): number { return f(); }`),
    ).toBe(1);
  });

  it("head let/const binding does not leak past the loop", async () => {
    // After the loop the outer `x` must read 'outside', not the loop binding.
    // (`as any` routes through the dynamic enumeration path the fix covers; the
    // closed-shape standalone static-unroll path is a separate pre-existing
    // limitation. In host/gc mode — the test262 lane — both paths restore.)
    expect(
      await run(`function f(): number {
  let x = 'outside';
  for (let x in ({ a: 1 } as any)) {}
  return x === 'outside' ? 1 : 0;
}
export function test(): number { return f(); }`),
    ).toBe(1);
  });
});
