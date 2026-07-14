// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// emit-helpers.ts — small pure emit utilities factored out of index.ts (#3272)
// to remove copy-pasted idioms. No codegen-context coupling beyond the passed
// `WasmModule`; safe to import from any codegen module.

import type { WasmModule } from "../ir/types.js";

/**
 * Is `structName` a compiler-synthetic / internal struct that must be skipped
 * when iterating `ctx.structFields` to emit host-facing field getters/setters
 * or classification exports? Matches the wrapper boxes (`Wrapper…`), the
 * `$AnyValue` any-box, and the `__vec_` / `__arr_` runtime array/vec structs.
 * Factored out of ~9 byte-identical inline guards (#3272).
 */
export function isSyntheticStructName(structName: string): boolean {
  return (
    structName.startsWith("Wrapper") ||
    structName === "$AnyValue" ||
    structName.startsWith("__vec_") ||
    structName.startsWith("__arr_")
  );
}

/**
 * Push a function export entry onto `mod.exports`. Factored out of the
 * `mod.exports.push({ name, desc: { kind: "func", index } })` idiom repeated at
 * many finalize-pass sites (#3272).
 */
export function exportFunc(mod: WasmModule, name: string, funcIdx: number): void {
  mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
}
