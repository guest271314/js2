// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3472 — a native-string-reassigned `any`/untyped param that is then
 * string-concatenated (`+=`) compiled to an INVALID standalone module.
 *
 * Repro shape (drives the test262 `assert.sameValue` message-building path):
 *
 *   const f = function(msg){
 *     if (msg === undefined) { msg = ''; } else { msg += ' '; }
 *     msg += 'x';
 *     return msg;
 *   };
 *
 * The unannotated param `msg` lowers to an EXTERNREF local slot. Because a
 * branch assigns it a string literal (`msg = ''`), `+=` was routed to the
 * native-string compound-assignment path (`compileNativeStringCompoundAssignment`),
 * which loaded the current value with a bare `local.get` on the assumption the
 * slot was already a native `ref $AnyString`. It was not, so `__str_concat`
 * received an `externref` for its first operand:
 *   `CompileError: call[0] expected type (ref null $AnyString), found ... externref`
 * i.e. the module failed to instantiate.
 *
 * Fix: under no-JS-host (standalone / WASI) coerce the loaded externref
 * current-value to a native `ref $AnyString` via ToString (§7.1.17,
 * `__extern_toString`) — matching the general `+` operator lowering — so a
 * runtime number/undefined/object stringifies correctly instead of an
 * unconditional-cast trap. Both the function-DECLARATION and the
 * function-EXPRESSION/closure forms route through the same site, so one fix
 * covers both.
 */

async function instantiateStandalone(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Empty import object — proves the module is JS-host-free (pure Wasm).
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#3472 standalone: native-string-reassigned externref param += concat", () => {
  it("compiles a VALID module and runs — function DECLARATION form", async () => {
    // In-wasm comparison → returns 1/0 (avoids marshalling native strings across
    // the JS boundary). `f(undefined)` → "x", `f("a")` → "a x".
    const ex = await instantiateStandalone(`
      function f(msg){ if (msg === undefined) { msg = ''; } else { msg += ' '; } msg += 'x'; return msg; }
      export function test(): number {
        return (f(undefined) === 'x' && f('a') === 'a x') ? 1 : 0;
      }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("compiles a VALID module and runs — function EXPRESSION / closure form", async () => {
    const ex = await instantiateStandalone(`
      export function test(): number {
        const f = function(msg){ if (msg === undefined) { msg = ''; } else { msg += ' '; } msg += 'x'; return msg; };
        return (f(undefined) === 'x' && f('a') === 'a x') ? 1 : 0;
      }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("stringifies a non-string runtime value via ToString (not an unconditional-cast trap)", async () => {
    // `msg: any` keeps the externref slot; a numeric runtime value reaches the
    // `else` branch and must ToString → "5 x" (`ref.cast`-only would trap here).
    const ex = await instantiateStandalone(`
      function f(msg: any){ if (msg === undefined) { msg = ''; } else { msg += ' '; } msg += 'x'; return msg; }
      export function test(): number { return (f(5) === '5 x') ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("does not regress a statically-string param (native-string ref slot)", async () => {
    const ex = await instantiateStandalone(`
      function f(msg: string){ if (msg === undefined) { msg = ''; } else { msg += ' '; } msg += 'x'; return msg; }
      export function test(): number { return (f('a') === 'a x') ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("does not regress a plain `let s = ''` string builder", async () => {
    const ex = await instantiateStandalone(`
      export function test(): number { let s = ''; s += 'a'; s += 'b'; return (s === 'ab') ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });
});
