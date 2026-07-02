// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// ---------------------------------------------------------------------------
// func-space — the ONLY sanctioned way to read a function definition / import
// signature from an absolute function index mid-compile (#1916 S2 / #2710
// slice 3).
//
// WHY A CHOKEPOINT
// ----------------
// A `FuncHandle` (src/ir/types.ts) is today numerically equal to the live
// function-index-space position, and after the #1916 S3 flip it becomes a
// stable, never-renumbered id that only `resolveLayout()` (src/emit/
// resolve-layout.ts) may turn into a position. Any inline positional
// arithmetic on a handle — `mod.functions[h - numImportFuncs]`,
// `h < numImportFuncs` — bakes the "handle == live position" assumption into
// a call site, which is exactly the assumption S3 deletes. Concentrating that
// arithmetic here means the flip rewrites THESE functions to registry lookups
// and every caller is already correct.
//
// RULES
// -----
// - New code MUST NOT write `mod.functions[idx - numImportFuncs]` or compare
//   `idx < numImportFuncs` inline; call `definedFuncAt` / `isImportFuncIdx` /
//   `funcSignatureOf` instead.
// - Plain positional ITERATION over `mod.functions` (walking every function,
//   e.g. shifters/DCE/emit) is NOT this module's concern — that is layout
//   work, owned by the passes themselves until S3/S4 retire them.
// - These accessors are read-only lookups; they never mint indices. Minting
//   (`numImportFuncs + mod.functions.length`) stays at registration sites
//   until S3 replaces it with registry handle minting.
// ---------------------------------------------------------------------------

import type { FuncTypeDef, FuncHandle, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** True when the handle denotes an imported function (import index space). */
export function isImportFuncIdx(ctx: CodegenContext, funcIdx: FuncHandle): boolean {
  return funcIdx < ctx.numImportFuncs;
}

/**
 * The defined-function record for an absolute function handle, or undefined
 * when the handle denotes an import (or is out of range / a sentinel like -1).
 * The returned object is the live `mod.functions` entry — callers that patch
 * helper bodies mutate through it exactly as before.
 */
export function definedFuncAt(ctx: CodegenContext, funcIdx: FuncHandle): WasmFunction | undefined {
  const pos = funcIdx - ctx.numImportFuncs;
  return pos >= 0 ? ctx.mod.functions[pos] : undefined;
}

/**
 * Replace the defined-function record for an absolute function handle
 * (patch-in-place, e.g. the IR integration swapping a legacy-compiled body
 * for the IR-lowered one). The write-side twin of `definedFuncAt` — after the
 * S3 flip this maps handle→position through the registry, so positional
 * writes must flow through here too. Throws on a non-defined handle: every
 * caller is expected to have resolved the handle via `definedFuncAt` first.
 */
export function replaceDefinedFuncAt(ctx: CodegenContext, funcIdx: FuncHandle, fn: WasmFunction): void {
  const pos = funcIdx - ctx.numImportFuncs;
  if (pos < 0 || pos >= ctx.mod.functions.length) {
    throw new Error(`replaceDefinedFuncAt: funcIdx ${funcIdx} is not a defined function`);
  }
  ctx.mod.functions[pos] = fn;
}

/**
 * The function signature (`FuncTypeDef`) for an absolute function handle,
 * covering BOTH index subspaces: imports (scanned in import-declaration
 * order, matching the function index space) and defined functions (via
 * `definedFuncAt`). Returns undefined when unresolvable.
 */
export function funcSignatureOf(ctx: CodegenContext, funcIdx: FuncHandle): FuncTypeDef | undefined {
  if (funcIdx < 0) return undefined;
  if (isImportFuncIdx(ctx, funcIdx)) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          return typeDef?.kind === "func" ? typeDef : undefined;
        }
        importFuncCount++;
      }
    }
    return undefined;
  }
  const func = definedFuncAt(ctx, funcIdx);
  if (!func) return undefined;
  const typeDef = ctx.mod.types[func.typeIdx];
  return typeDef?.kind === "func" ? typeDef : undefined;
}
