// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1518 — Annex B.3.2 sloppy-mode function-in-block hoisting.
//
// Per ECMA-262 §B.3.2, in sloppy mode a `FunctionDeclaration` inside a Block /
// If / Switch / Try is hoisted to BOTH the block's lexical environment AND
// the surrounding function's var environment. The compiler must:
//   1. Allocate a `var`-style externref slot at the surrounding function's
//      scope, initialised to `undefined`.
//   2. Skip the hoist when a `let` / `const` / `class` / parameter with the
//      same name shadows the candidate at the surrounding function scope
//      (the "early error" branch of §B.3.2).
//   3. Force `typeof <name>` to runtime so the dynamic undefined → function
//      flip is observed.
//
// These tests mirror the most common test262 patterns under
// `annexB/language/function-code/`:
//   - `*-func-init.js`   — assert `f` is `undefined` BEFORE the block.
//   - `*-skip-early-err-for.js` — assert `typeof f === 'undefined'` when an
//     enclosing `for (let f; ; )` shadows the would-be var binding.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runReturning(src: string): Promise<{ ret: unknown; error?: string }> {
  const result = compile(src, { skipSemanticDiagnostics: true });
  if (!result.success) return { ret: undefined, error: result.error };
  const importObj = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
  if (typeof (importObj as any).setExports === "function") {
    (importObj as any).setExports(instance.exports);
  }
  try {
    const ret = (instance.exports as any).test();
    return { ret };
  } catch (e: any) {
    return { ret: undefined, error: String(e) };
  }
}

describe("#1518 — Annex B.3.2 sloppy function-in-block hoisting", () => {
  it("init: outer var binding starts as undefined before the if-block evaluates", async () => {
    // Mirrors `if-decl-else-decl-a-func-init.js`: `init = f` is read BEFORE
    // the if statement; per Annex B, the binding exists at function scope
    // and is initialised to `undefined`. We assert directly inside the
    // exported function so all reads happen within the same Wasm function
    // context that owns the Annex B var slot.
    const src = `
      export function test(): number {
        let init: any = 1;
        let changed: any = 0;
        init = f;
        f = 123 as any;
        changed = f;

        if (true) function f() {}

        let result = 0;
        if (init === undefined) result += 1;
        if (changed === 123) result += 2;
        return result;
      }
    `;
    const { ret, error } = await runReturning(src);
    if (error) {
      // eslint-disable-next-line no-console
      console.error("init compile/run error:", error);
    }
    expect(error).toBeUndefined();
    // 3 = both assertions pass.
    expect(ret).toBe(3);
  });

  it("skip: typeof f stays undefined when a `for (let f; ;)` shadows the would-be var", async () => {
    // Mirrors `if-decl-no-else-func-skip-early-err-for.js`. The Annex B var
    // hoisting MUST be skipped because the surrounding function would have a
    // top-level lexical `f` (via the for-loop's per-iteration `let f`), and
    // the would-be var declaration produces an early error.
    //
    // Pre-#1518 behaviour: the compiler hoisted `f` to funcMap regardless,
    // so `typeof f` const-folded to `'function'` outside the for-loop.
    // Post-#1518: the function decl gets pure block-scoped lexical semantics
    // (no funcMap entry, no var binding), and `typeof f === 'undefined'`.
    const src = `
      export function test(): number {
        let outerTypeof: any = "?";
        (function () {
          // No f in scope here yet — typeof should be 'undefined'.
          let pre = typeof f;
          for (let f: any = 0; ; ) {
            if (true) function f() {}
            break;
          }
          // After the for-loop, the surrounding function still has no
          // var binding for f because Annex B skipped (let f conflict).
          let post = typeof f;
          outerTypeof = pre + "|" + post;
        })();
        // Encode result: 1 = both undefined as expected.
        return outerTypeof === "undefined|undefined" ? 1 : 0;
      }
    `;
    const { ret, error } = await runReturning(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(1);
  });

  it("update: outer var binding holds the function value after the block evaluates", async () => {
    // Mirrors `if-decl-else-decl-a-func-update.js`. After the if-block runs
    // the FunctionDeclaration step, the surrounding function's var binding
    // is set to the function reference. The Wasm-side `after()` call goes
    // through the externref call_ref path (cast back to the closure
    // struct), so it works even without a JS-function bridge.
    const src = `
      export function test(): number {
        let after: any = null;
        (function () {
          if (true) function f() { return 42; } else function _f() {}
          after = f;
        })();
        // Call the closure stored in after — works because the externref
        // here was produced by extern.convert_any of a Wasm closure struct;
        // the call site casts back via any.convert_extern + ref.cast.
        return typeof after === "function" || after() === 42 ? 1 : 0;
      }
    `;
    const { ret, error } = await runReturning(src);
    expect(error).toBeUndefined();
    // We accept either: (a) typeof === "function" (works if the JS-side
    // __typeof can detect wasm closures — currently it cannot, so this is
    // the aspirational branch), OR (b) the call itself returns 42 (which
    // the Wasm-side call_ref path handles today).
    expect(ret).toBe(1);
  });

  it('strict mode: no hoist for function-in-block under "use strict"', async () => {
    // Annex B explicitly does not apply in strict mode. We test that the
    // compiler still does NOT create a var binding when the enclosing
    // function (or source) is strict — `typeof f` must be 'undefined'
    // before AND after the if-block.
    const src = `
      "use strict";
      export function test(): number {
        let pre: any = "?";
        let post: any = "?";
        (function () {
          "use strict";
          pre = typeof f;
          if (true) { function f() {} }
          post = typeof f;
        })();
        return pre === "undefined" && post === "undefined" ? 1 : 0;
      }
    `;
    const { ret, error } = await runReturning(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(1);
  });
});
