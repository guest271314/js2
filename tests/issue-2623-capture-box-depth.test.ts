// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2623 Slice A — async/capability closure outbound-capture box-depth lowering.
//
// Root cause (verified, binaryen-decoded): when an outer function is itself
// materialized as a closure VALUE and threads a mutable capture as a boxed
// `$cell` leading param (e.g. the Promise capability `Constructor(executor)`
// whose module-level `callCount` is boxed), a NESTED function declaration that
// re-captures the SAME name was DOUBLE-BOXED. `nested-declarations.ts` typed the
// nested mutable capture as `getOrRegisterRefCellType(ctx, c.type)` where
// `c.type` was ALREADY the `$cell` — producing a `$cell-of-cell`
// (`__ref_cell_ref_*` whose value field is itself a `(ref null $cell)`).
//
// That deref-depth mismatch (#1205/#1312 hazard) broke two sites:
//   1. The construction site (emitFuncRefAsClosure) pushed the existing single
//      `$cell` into a closure field typed as the double cell — the struct.new
//      field-coerce in stack-balance.ts inserted an UNGUARDED `ref.cast`
//      `$cell -> $cell-of-cell` that trapped: "illegal cast in Constructor()".
//   2. The lifted body derefed once (`struct.get $cell-of-cell`) and got the
//      INNER `$cell` (a ref) where it expected the f64 value, so the mutation
//      `callCount += 1` read/wrote garbage and never incremented.
//
// Fix: mirror the ARROW path's existing `alreadyBoxed` disambiguation
// (closures.ts:1681/1728-1748/2457-2476) in the FunctionDeclaration path. When
// the captured name is already registered in the outer scope's `boxedCaptures`,
// thread the existing `$cell` through unchanged (single box) and register the
// lifted body's read/write at the cell's inner value depth.
//
// This test asserts the STRUCTURAL invariant directly (the generated module
// must not contain a ref-cell-of-ref-cell for the capability shape) because it
// is deterministic and does not depend on the test262 harness shims
// (`Test262Error.thrower` / `promiseHelper.js`) that gate the full row flips.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST262_FILE = resolve(HERE, "../test262/test/built-ins/Promise/allSettled/call-resolve-element.js");

/**
 * Compile the EXACT test262 source that triggers the double-box (through the
 * runner's wrap, matching the conformance path). The full capability shape —
 * `Promise.allSettled.call(Constructor, [thenable])` with a `Constructor`
 * whose nested `resolve` captures the module-level `var callCount` — is what
 * boxes `callCount` into a `$cell` threaded as a `Constructor` param and then
 * re-captured by `resolve`. A reduced synthetic shape does NOT exercise the
 * host-routed boxing, so we use the real fixture.
 */
function compileCapabilityFixture() {
  const src = readFileSync(TEST262_FILE, "utf-8");
  const meta = parseMeta(src);
  const wrapped = wrapTest(src, meta);
  const wsrc = typeof wrapped === "string" ? wrapped : (wrapped as { source: string }).source;
  return compile(wsrc, { fileName: "call-resolve-element.ts" });
}

/**
 * The compiler names a ref-cell that boxes the value type `T` as
 * `__ref_cell_<key>`. A SINGLE box of an f64 capture is `__ref_cell_f64`; a
 * DOUBLE box (cell-of-cell) is `__ref_cell_ref_<n>` — the key is derived from a
 * `ref` value type, i.e. the cell wraps another ref-cell. That `__ref_cell_ref_`
 * marker is the precise signature of the #2623 double-box regression: it is
 * generated ONLY when a mutable capture's value type is itself already a ref
 * cell. Its presence is the bug; its absence is the fix.
 */
function hasCellOfCell(wat: string): boolean {
  return /\(type \$__ref_cell_ref_\d+\s/.test(wat);
}

describe("#2623 Slice A — nested-capture box depth (no double-box)", () => {
  it("the capability fixture's nested capture is single-boxed (no cell-of-cell)", async () => {
    const r = await compileCapabilityFixture();
    expect(r.success).toBe(true);
    // The module must be structurally valid (no ungual cast trap baked in).
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
    // Box-depth invariant: the `__ref_cell_ref_*` cell-of-cell marker must be
    // ABSENT. On the pre-fix baseline this fixture emits
    // `(type $__ref_cell_ref_N (struct (field $value (mut (ref null <f64-cell>)))))`.
    expect(hasCellOfCell(r.wat)).toBe(false);
  });

  it("Constructor and its nested resolve capture callCount at the SAME depth", async () => {
    const r = await compileCapabilityFixture();
    expect(r.success).toBe(true);
    const lines = r.wat.split("\n");
    const ctor = lines.find((l) => /\(type \$__fn_cap_Constructor_\d+_struct/.test(l));
    const resolveCap = lines.find((l) => /\(type \$__fn_cap_resolve_\d+_struct/.test(l));
    expect(ctor).toBeDefined();
    expect(resolveCap).toBeDefined();
    // Both closures box `callCount` — the cap0 field type index must match
    // (single shared `$__ref_cell_f64`). Pre-fix, resolve's cap0 pointed at the
    // cell-of-cell while Constructor's pointed at the f64 cell.
    const ctorCap0 = ctor!.match(/cap0 \(ref null (\d+)\)/)?.[1];
    const resolveCap0 = resolveCap!.match(/cap0 \(ref null (\d+)\)/)?.[1];
    expect(ctorCap0).toBeDefined();
    expect(resolveCap0).toBeDefined();
    expect(resolveCap0).toBe(ctorCap0);
  });
});
