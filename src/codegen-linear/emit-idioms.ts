// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Emit-idiom builders for the linear-memory backend (#3105).
//
// The linear runtime (`runtime.ts`) hand-rolls the same small Wasm instruction
// scaffolds at dozens of sites — one copy per hash-table variant (string
// Map/Set, numeric Map/Set) × per operation (get/set/has/delete). Each copy
// re-derives the same operand order and local layout by hand, which is both
// duplication (the file is the single most duplicated in `src/`) and a latent
// bug surface (a mistyped operand/branch depth is exactly what the
// stack-balance layers exist to catch).
//
// These builders return the **byte-identical** instruction sequence the sites
// already emit — same ops, same operand order, no blockType/branch changes — so
// migrating a site is provably a no-op for the emitted binary
// (`scripts/prove-emit-identity.mjs`, `linear` target). They are per-backend by
// design: the linear and WasmGC backends stay separate (#1527), and these
// operate on linear-memory locals/offsets that have no WasmGC analogue.

import type { Instr } from "../ir/types.js";

/**
 * Open-addressing probe advance: `idx = (idx + 1) % cap`.
 *
 * This is the ×10 hash-probe-advance idiom of #3105 — the tail of every linear
 * probe loop (`__map_set`/`__map_get`/`__map_has`, and the set/numeric
 * variants). It reads the current probe index, steps it by one, wraps modulo
 * the (power-of-two-or-not) capacity, and stores it back. The following loop
 * back-branch (`br 0`) is intentionally NOT part of this builder — it belongs
 * to the enclosing loop, not the index step.
 *
 * Returns exactly six instructions, in this order:
 *   local.get idx · i32.const 1 · i32.add · local.get cap · i32.rem_u · local.set idx
 *
 * @param idxLocal local index holding the current probe slot index
 * @param capLocal local index holding the table capacity
 */
export function hashProbeAdvanceInstrs(idxLocal: number, capLocal: number): Instr[] {
  return [
    { op: "local.get", index: idxLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: capLocal },
    { op: "i32.rem_u" },
    { op: "local.set", index: idxLocal },
  ];
}
