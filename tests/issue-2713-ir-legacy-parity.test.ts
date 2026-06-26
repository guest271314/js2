// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2713 — IR↔legacy parity correctness twins.
//
// The IR front-end (`src/ir/from-ast.ts`) re-introduces correctness bugs that
// were fixed only on the legacy AST→Wasm path, because the IR lowering was
// never given the fix and the IR verifier checks *structure*, not *semantics*.
// These are committed miscompiles, not clean demotes.
//
// This is the structural guard the issue asks for: a **differential IR-on vs
// IR-off** check over a focused correctness corpus. Each case compiles the
// *same* source twice — `experimentalIR: false` (legacy) and `experimentalIR:
// true` (IR claims what it can) — instantiates both, and asserts the two
// runtimes agree AND match the spec-correct value. When a future change
// "fixes a bug on one path only" (or re-drops a fix on the IR side), the twin
// diverges and this test goes red.
//
// Reliability notes (intentional scoping):
//   - Cases pass only `number` / `null` arguments and return `number` /
//     `string`, the shapes that marshal cleanly across the host boundary.
//     Passing a JS string/array to a native-strings/vec param throws an
//     identical host-marshalling error on BOTH paths (not a compiler
//     divergence), so such inputs are constructed *inside* the wasm instead.
//   - No test262, no timing, no known-divergent assertions: every case is a
//     case where IR-on and IR-off MUST agree on current main (either the IR
//     compiles it correctly, or it demotes to the legacy path which does).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface DualResult {
  legacy: unknown;
  ir: unknown;
}

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

/**
 * Compile `source` twice (legacy + IR), instantiate each with the full
 * host import table built from its own manifest, and invoke `fn(...args)` on
 * both. `buildImports` (the same path #1169n uses) materialises `env`,
 * `wasm:js-string` and `string_constants` so every shape instantiates,
 * regardless of host- vs native-string mode.
 */
async function dualRun(
  source: string,
  fn: string,
  args: ReadonlyArray<unknown>,
  opts: { nativeStrings?: boolean } = {},
): Promise<DualResult> {
  const result: Partial<DualResult> = {};
  for (const [label, experimentalIR] of [
    ["legacy", false],
    ["ir", true],
  ] as const) {
    const r = await compile(source, { experimentalIR, nativeStrings: opts.nativeStrings ?? false });
    if (!r.success) {
      throw new Error(`${label} compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
    }
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const importObject: WebAssembly.Imports = {
      env: built.env,
      "wasm:js-string": built["wasm:js-string"],
      string_constants: built.string_constants,
    };
    const { instance } = await WebAssembly.instantiate(r.binary, importObject);
    built.setExports?.(instance.exports as Record<string, Function>);
    const exported = (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn];
    if (typeof exported !== "function") {
      throw new Error(`${label}: export '${fn}' missing`);
    }
    result[label] = exported(...args);
  }
  return result as DualResult;
}

/** Assert IR-on and IR-off agree, and both equal the spec value. NaN-aware. */
function expectParity(d: DualResult, spec: unknown): void {
  if (typeof spec === "number" && Number.isNaN(spec)) {
    expect(Number.isNaN(d.legacy as number), `legacy=${String(d.legacy)} expected NaN`).toBe(true);
    expect(Number.isNaN(d.ir as number), `ir=${String(d.ir)} expected NaN`).toBe(true);
    return;
  }
  // IR must match legacy (the parity guard) AND match the spec value.
  expect(d.ir, `IR diverged from legacy (legacy=${String(d.legacy)}, ir=${String(d.ir)})`).toStrictEqual(d.legacy);
  expect(d.ir, `result diverged from spec`).toStrictEqual(spec);
}

describe("#2713 IR↔legacy parity correctness twins", () => {
  // ── B2: `string === null` / `!== null` must NOT fold to a constant ──────
  // The pre-fix IR folded a `string`-typed operand's null-compare to a
  // constant (`=== null` → false, `!== null` → true), because the operand
  // was assumed statically non-null. A host caller can pass `null` for a
  // string param, so the fold silently miscompiled the guard. (The legacy
  // path emits a runtime ref.is_null check.) These are the canonical repros
  // and the host-`null` boundary marshals cleanly.
  describe("B2 — string null-compare not folded", () => {
    const eqSrc = `export function test(s: string): number { return s === null ? 1 : 0; }`;
    const neqSrc = `export function test(s: string): number { return s !== null ? 1 : 0; }`;
    const looseEqSrc = `export function test(s: string): number { return s == null ? 1 : 0; }`;
    const looseNeqSrc = `export function test(s: string): number { return s != null ? 1 : 0; }`;

    it("s === null  with s = null  → 1 (was folded to 0 on the IR path)", async () => {
      expectParity(await dualRun(eqSrc, "test", [null], { nativeStrings: true }), 1);
    });
    it("s !== null  with s = null  → 0 (was folded to 1 on the IR path)", async () => {
      expectParity(await dualRun(neqSrc, "test", [null], { nativeStrings: true }), 0);
    });
    it("s == null   with s = null  → 1", async () => {
      expectParity(await dualRun(looseEqSrc, "test", [null], { nativeStrings: true }), 1);
    });
    it("s != null   with s = null  → 0", async () => {
      expectParity(await dualRun(looseNeqSrc, "test", [null], { nativeStrings: true }), 0);
    });
    it("non-null scalar null-compare still folds correctly (fix must not over-bail)", async () => {
      // `n !== null` where n is f64 is provably non-null — IR may still fold.
      expectParity(
        await dualRun(`export function test(n: number): number { return n !== null ? 1 : 0; }`, "test", [7]),
        1,
      );
    });
  });

  // ── B3: `a?.[i]` must honour the optional short-circuit ─────────────────
  // The element-access lowering ignored `questionDotToken`, emitting an
  // unconditional vec.get that traps on a null receiver instead of yielding
  // `undefined`. Now demoted to legacy (which has the null-guard). The
  // non-null path must still compute correctly under both backends. (A real
  // null array can't cross the host boundary cleanly, so the array is built
  // inside the wasm; the null short-circuit itself is covered by the legacy
  // path the IR now demotes to.)
  describe("B3 — optional element access", () => {
    it("a?.[1] on a non-null in-wasm array → element", async () => {
      const src = `export function test(): number { const a = [10, 20, 30]; return a?.[1] ?? -1; }`;
      expectParity(await dualRun(src, "test", []), 20);
    });
    it("plain a[1] (no optional) still compiles + agrees", async () => {
      const src = `export function test(): number { const a = [10, 20, 30]; return a[1]; }`;
      expectParity(await dualRun(src, "test", []), 20);
    });
  });

  // ── B1: `delete obj.x` — configurable delete returns true (spec) ────────
  // Slice 11 (#1169n) intentionally IR-claims `delete obj.prop` for the
  // common case where the property is configurable: `delete` evaluates to
  // `true` and the legacy path agrees. The parity twin guards that the
  // boolean result and side-effect ordering stay in lock-step.
  describe("B1 — delete result parity", () => {
    it("delete obj.x (configurable) → true → 1", async () => {
      const src = `export function test(): number {
        const obj: { x?: number } = { x: 1 };
        const res: boolean = delete obj.x;
        return res ? 1 : 0;
      }`;
      expectParity(await dualRun(src, "test", []), 1);
    });
    it("delete f().x still calls f (side-effect ordering)", async () => {
      const src = `let calls = 0;
      function mk(): { x?: number } { calls = calls + 1; return { x: 1 }; }
      export function test(): number { delete mk().x; return calls; }`;
      expectParity(await dualRun(src, "test", []), 1);
    });
  });

  // ── B4: `void <expr>` parity ────────────────────────────────────────────
  // `void <expr>` evaluates the operand for side effects and yields
  // `undefined` (NaN in numeric carrier). Slice 11 claims void in statement
  // position; the parity twin guards the operand is still evaluated and the
  // numeric carrier agrees across backends.
  describe("B4 — void expression parity", () => {
    it("void in statement position keeps side effect; function returns normally", async () => {
      const src = `export function test(): number {
        let n = 0;
        void (n = n + 5);
        return n;
      }`;
      expectParity(await dualRun(src, "test", []), 5);
    });
    it("void operand with a call side effect is still evaluated", async () => {
      const src = `let hits = 0;
      function bump(): number { hits = hits + 1; return hits; }
      export function test(): number { void bump(); void bump(); return hits; }`;
      expectParity(await dualRun(src, "test", []), 2);
    });
  });

  // ── B5: rest / default / optional params parity ─────────────────────────
  // The selector rejects top-level functions with rest/default/optional
  // params to legacy; a nested closure / nested-function carrying them keeps
  // the outer function on the legacy path too (the from-ast param gate mirrors
  // the selector). Either way IR-on and IR-off must agree on the observable
  // result — the param semantics survive via the legacy path.
  //
  // The defaulting must be exercised through an INTERNAL call: a missing
  // argument on a direct host call does not run a default-param initializer
  // (true on both backends — not an IR divergence), so the twins invoke the
  // defaulted function from another wasm function.
  describe("B5 — rest/default/optional param parity", () => {
    it("nested closure with a default param", async () => {
      const src = `export function outer(n: number): number {
        function inner(x = 5): number { return x + n; }
        return inner();
      }`;
      expectParity(await dualRun(src, "outer", [10]), 15);
    });
    it("default param applied via internal call (missing arg)", async () => {
      const src = `function helper(x = 5): number { return x + 1; }
      export function test(): number { return helper(); }`;
      expectParity(await dualRun(src, "test", []), 6);
    });
    it("default param NOT applied when arg supplied via internal call", async () => {
      const src = `function helper(x = 5): number { return x + 1; }
      export function test(): number { return helper(40); }`;
      expectParity(await dualRun(src, "test", []), 41);
    });
    it("optional param bound when supplied via internal call", async () => {
      const src = `function helper(x?: number): number { return x === undefined ? 7 : x; }
      export function test(): number { return helper(3); }`;
      expectParity(await dualRun(src, "test", []), 3);
    });
  });
});
