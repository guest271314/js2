// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2567 (regression) — a destructuring parameter whose binding default is a
 * function CALL (`{ b = thrower() }`) must keep its `call` funcIdx tracked
 * across late-import index shifts.
 *
 * Root cause: in `destructureParamObjectExternref`
 * (src/codegen/destructuring-params.ts) the identifier-with-initializer path
 * compiles the default-value expression into a DETACHED `thenInstrs` buffer
 * (swapped out of `fctx.body`) before splicing it into the guard `if`. When the
 * default is a function call, compiling it registers a late import and triggers
 * a func/global-index shift. That shift walks `fctx.body` + `fctx.savedBodies` +
 * `ctx.liveBodies`; the detached `thenInstrs` was on NONE of them, so the
 * already-emitted `call <fn>` kept its stale-high funcIdx and was mis-remapped
 * at finalize — the call landed on an unrelated import (`__typeof_bigint` /
 * `__box_number` scaffolding), producing
 * `C_method: not enough arguments on the stack for call (need 1, got 0)` →
 * invalid Wasm.
 *
 * Fix: register the detached default buffers in `ctx.liveBodies` for the compile
 * window (mirrors the #2158 struct-fast-path then/else tracking), so the shift
 * reaches the in-flight `call`. The assertion is module VALIDITY — only V8's
 * index-resolved function-body validation rejects the mis-remapped call.
 *
 * Mirrors `language/{statements,expressions}/class/dstr/meth-dflt-obj-ptrn-list-err.js`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function expectValid(src: string): Promise<void> {
  const r = await compile(src, { skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "compiled module must validate").toBe(true);
}

describe("#2567 dstr-param default with a function-call initializer", () => {
  it("object-pattern param default calling a function validates (the *-list-err shape)", async () => {
    // `b = thrower()` is the load-bearing case: a CALL default in a destructuring
    // param, with the outer `= {}` forcing the externref destructuring path.
    await expectValid(`
      var initCount = 0;
      function thrower(): never { throw new Error("x"); }
      class C {
        method({ a, b = thrower(), c = ++initCount } = {}) {}
      }
      export function test(): number { return 1; }
    `);
  });

  it("static method variant validates", async () => {
    await expectValid(`
      var initCount = 0;
      function thrower(): never { throw new Error("x"); }
      class C {
        static method({ a, b = thrower(), c = ++initCount } = {}) {}
      }
      export function test(): number { return 1; }
    `);
  });

  it("class-expression variant validates", async () => {
    await expectValid(`
      var initCount = 0;
      function thrower(): never { throw new Error("x"); }
      var C = class {
        method({ a, b = thrower(), c = ++initCount } = {}) {}
      };
      export function test(): number { return 1; }
    `);
  });

  it("plain (non-throwing) function-call default still validates", async () => {
    // Guard against over-narrowing the fix to `never`-returning calls: any
    // call-valued default exercises the same detached-buffer shift path.
    await expectValid(`
      function make(): number { return 9; }
      class C {
        method({ a, b = make() } = {}) { return b; }
      }
      export function test(): number {
        new C().method({ a: 1 });
        return 1;
      }
    `);
  });
});
