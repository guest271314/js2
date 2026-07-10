// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2973 — eval-shim sub-compiles must NOT inherit JS2WASM_IR_FIRST.
//
// `runtime-eval.ts` wraps the eval'd source in a top-level FunctionDeclaration
// and calls `compileSourceSync`. That sub-compile used to inherit the ambient
// `JS2WASM_IR_FIRST` flag. Under the flag, an eval'd expression with a
// claim-partial type residual (e.g. the mixed f64/i32 `|` in `5+1|0===0`)
// turns into a post-claim IR-first HARD compile error — which the shim's
// fallback `catch` arms swallow, silently degrading a correct result (`7`) to
// `undefined`. That is the exact silent-wrong-answer class the #2138 inversion
// exists to eliminate.
//
// The fix threads a structural `disableIrFirst` opt-out through the compile
// options so sub-compiles always take the proven legacy-then-overlay pipeline,
// independent of the ambient env flag.
import { describe, it, expect, afterEach } from "vitest";
import { createEvalShim } from "../src/runtime-eval.js";
import { compileSourceSync } from "../src/compiler.js";

const IR_FIRST = "JS2WASM_IR_FIRST";

/** Run `body` with JS2WASM_IR_FIRST forced to `val`, restoring the prior value. */
function withIrFirst<T>(val: string | undefined, body: () => T): T {
  const prev = process.env[IR_FIRST];
  if (val === undefined) delete process.env[IR_FIRST];
  else process.env[IR_FIRST] = val;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env[IR_FIRST];
    else process.env[IR_FIRST] = prev;
  }
}

describe("#2973 eval sub-compile does not inherit JS2WASM_IR_FIRST", () => {
  afterEach(() => {
    delete process.env[IR_FIRST];
  });

  // The canonical divergence from #2138's full flagged run: a claim-partial
  // residual (mixed f64/i32 `|`). `5+1|0===0` === `6 | (0===0)` === `6 | 1` === 7.
  const evalSrc = "5+1|0===0";
  const expected = 7;

  it("flag-off eval returns the correct value (control)", () => {
    const shim = createEvalShim();
    const v = withIrFirst("0", () => shim(evalSrc, 0));
    expect(v).toBe(expected);
  });

  it("flag-ON eval returns the SAME value — no silent undefined", () => {
    const shim = createEvalShim();
    const v = withIrFirst("1", () => shim(evalSrc, 0));
    // Before the fix this was `undefined` (the swallowed hard error).
    expect(v).toBe(expected);
  });

  it("flag-on result equals flag-off result", () => {
    const shim = createEvalShim();
    const off = withIrFirst("0", () => shim(evalSrc, 0));
    const on = withIrFirst("1", () => shim(evalSrc, 0));
    expect(on).toBe(off);
  });

  // Unit-level proof of the opt-out mechanism: the same claim-partial wrapper
  // that fails to compile under flag-on WITHOUT the opt-out compiles
  // successfully WITH `disableIrFirst: true`.
  it("disableIrFirst opts the sub-compile out of the IR-first inversion", () => {
    const wrapper = `export function __eval_result() { return (${evalSrc}); }`;
    withIrFirst("1", () => {
      const withoutOptOut = compileSourceSync(wrapper, {
        fileName: "eval.ts",
        allowJs: true,
        skipSemanticDiagnostics: true,
      });
      expect(withoutOptOut.success).toBe(false); // baseline: IR-first hard error

      const withOptOut = compileSourceSync(wrapper, {
        fileName: "eval.ts",
        allowJs: true,
        skipSemanticDiagnostics: true,
        disableIrFirst: true,
      });
      expect(withOptOut.success).toBe(true); // opt-out restores legacy fallback
    });
  });
});
