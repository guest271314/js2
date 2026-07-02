// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// ---------------------------------------------------------------------------
// resolveLayout — the single handle→final-index authority (#1916 / #2710).
//
// CONTRACT (the #1899-ratified end state)
// ---------------------------------------
// Instructions and module records reference functions / globals / types through
// stable handles (`FuncHandle` / `GlobalHandle` / `TypeHandle`, src/ir/types.ts).
// A concrete module index is assigned in exactly ONE place — here — and read in
// exactly one phase: serialization (src/emit/binary.ts), the only point that
// sees the FINAL index space (post every late import, post DCE). Nothing
// upstream of emit may interpret a handle as a position.
//
// WHY (the bug class this retires)
// --------------------------------
// The WasmGC backend historically baked *live* indices into instruction streams
// mid-compile; every late import (`addUnionImports`, `addStringImports`,
// `ensureLateImport`) then had to chase the +N shift into every body and ~40
// side-channel caches (`shiftLateImportIndices`, `reconcileNativeStrFinalizeShift`,
// two hand-rolled inline shifters), and DCE's remove-and-renumber had to remap
// them again. At least 7 numbered regressions trace to that design (#618, #1109,
// #1384, #1525b, #1666, #1677, #2191, #2193, #2918…). #1899's implementation
// notes prove the dual lesson that fixes the design:
//   - identity must ride IN the instruction (a handle), because a numeric index
//     is ambiguous across shifts — any idx-keyed repair map is unsound;
//   - the only sound resolution point is AFTER all churn, i.e. emit time.
//
// MIGRATION PHASE — IDENTITY (#2710 slice 2, landed under #1916 S1)
// -----------------------------------------------------------------
// In the current phase handles are still *numerically equal* to live indices
// (the existing shifters keep them current, exactly as before). `resolveLayout`
// is therefore the identity map, and wiring it through `binary.ts` is provably
// byte-identical (see `scripts/prove-emit-identity.mjs`). The value of this
// slice is the SEAM: every serialization of a func/global reference now flows
// through `ModuleLayout`, so the later flip — minting stable, never-renumbered
// handles at registration and computing the real permutation here — changes
// one function instead of fourteen encode sites.
//
// FLIP PRECONDITIONS (do NOT make this non-identity before these hold):
//   1. Every positional read (`mod.functions[idx - numImportFuncs]`,
//      `idx - numImportFuncs` arithmetic, `mod.globals[idx]`) is converted to a
//      registry/layout-keyed lookup (#1916 S2 / #2710 slice 3).
//   2. Registration sites mint handles from a monotonic counter (never reused),
//      and the shifters are deleted in the same change — a body-walking shifter
//      mutating stable handles would corrupt them (#1916 S3 / #2710 slice 4).
//   3. The canonical ordering reproduces today's final layout exactly (imports
//      in declaration order first, then live defined entries in array order
//      post-DCE) so the flip stays byte-identical.
// ---------------------------------------------------------------------------

import type { FuncHandle, GlobalHandle, TypeHandle, WasmModule } from "../ir/types.js";

/**
 * The resolved final layout of one module's index spaces. `binary.ts` (and,
 * at flip time, `wat.ts` / `object.ts`) dereference every handle through this
 * — never through arithmetic on the handle value.
 */
export interface ModuleLayout {
  /** Final function-index-space position for a function handle. */
  func(h: FuncHandle): number;
  /** Final global-index-space position for a global handle. */
  global(h: GlobalHandle): number;
  /** Final type-index-space position for a type handle. */
  type(h: TypeHandle): number;
}

/**
 * Compute the handle→final-index maps for a module whose registration and
 * churn (late imports, DCE) have fully settled. Called at the top of emit —
 * downstream of `ctx.indexSpaceFrozen = true` in `generateModule`, the point
 * both finalize arms guarantee no further import can be added.
 *
 * IDENTITY PHASE: handles == live indices by construction (the shifters keep
 * them current), so the identity map is definitionally correct. The `mod`
 * parameter is unused today but is the flip-time input (import counts +
 * registration registry + liveness), so callers already pass it.
 */
export function resolveLayout(_mod: WasmModule): ModuleLayout {
  return IDENTITY_LAYOUT;
}

const IDENTITY_LAYOUT: ModuleLayout = {
  func: (h: FuncHandle): number => h,
  global: (h: GlobalHandle): number => h,
  type: (h: TypeHandle): number => h,
};
