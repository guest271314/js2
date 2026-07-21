// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Funcref-wrapper struct / func-type registry for js2wasm closures.
 *
 * Extracted verbatim from `closures.ts` (issue #3270) — the small, foundational
 * wrapper-struct / lifted-func-type registry that the method-trampoline and
 * funcref-as-closure subsystems both build on. Isolates the isorecursive
 * root-wrapper canonicalization logic (#2873) in one place.
 */

import type { ClosureInfo, CodegenContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { funcSignatureOf } from "../func-space.js"; // (#1916 S2 read chokepoint)
import { addFuncType } from "../index.js";

/**
 * Look up a function's parameter and result types from its index.
 */
export function getFuncSignature(
  ctx: CodegenContext,
  funcIdx: number,
): { params: ValType[]; results: ValType[] } | null {
  // #1916 S2 — funcSignatureOf is the positional-read chokepoint (func-space.ts).
  const sig = funcSignatureOf(ctx, funcIdx);
  return sig ? { params: sig.params, results: sig.results } : null;
}

/**
 * Get or create the closure struct type and lifted func type for wrapping
 * plain functions with a given signature. Struct type and func type are shared
 * across all functions with the same signature, but each function gets its own
 * trampoline.
 */
export function getOrCreateFuncRefWrapperTypes(
  ctx: CodegenContext,
  userParams: ValType[],
  resultTypes: ValType[],
): { structTypeIdx: number; liftedFuncTypeIdx: number; closureInfo: ClosureInfo } | null {
  // Build cache key from param types and result types
  const sigKey = `${userParams.map((p) => p.kind + ((p as any).typeIdx ?? "")).join(",")}->${resultTypes.map((r) => r.kind + ((r as any).typeIdx ?? "")).join(",")}`;

  const cached = ctx.funcRefWrapperCache.get(sigKey);
  if (cached) {
    return { structTypeIdx: cached.structTypeIdx, liftedFuncTypeIdx: cached.funcTypeIdx, closureInfo: cached };
  }

  // Create the closure struct type: just (field $func funcref), no captures.
  // Mark as non-final (superTypeIdx = -1) so closures with captures can be
  // subtypes of this wrapper struct, enabling ref.cast to succeed at call sites.
  const closureName = `__fn_wrap_${ctx.closureCounter++}`;
  const structFields = [{ name: "func", type: { kind: "funcref" as const }, mutable: false }];
  const structTypeIdx = ctx.mod.types.length;
  const rootWrapperTypeIdx = (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
    superTypeIdx: rootWrapperTypeIdx ?? -1, // first wrapper is the root; later signatures subtype it
  });
  if (rootWrapperTypeIdx === undefined) {
    (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx = structTypeIdx;
  }

  // Create the lifted function type: (ref $struct, ...userParams) -> results
  const liftedParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }, ...userParams];
  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, resultTypes, `${closureName}_type`);

  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: resultTypes.length > 0 ? resultTypes[0]! : null,
    paramTypes: userParams,
  };
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);
  ctx.funcRefWrapperCache.set(sigKey, closureInfo);

  return { structTypeIdx, liftedFuncTypeIdx, closureInfo };
}

/**
 * #3371 — Return a nominally-distinct subtype for an ordinary function value.
 *
 * Arrow functions and method closures deliberately keep using the signature
 * wrapper above.  Ordinary function declarations/expressions add one immutable
 * marker field, making their runtime type distinguishable for IsConstructor
 * without changing field 0 or the shared lifted-call ABI.  The subtype still
 * casts to the base wrapper at every existing call site.
 */
export function getOrCreateConstructibleFuncRefWrapperTypes(
  ctx: CodegenContext,
  userParams: ValType[],
  resultTypes: ValType[],
): { structTypeIdx: number; liftedFuncTypeIdx: number; closureInfo: ClosureInfo } | null {
  const sigKey = `${userParams.map((p) => p.kind + ((p as any).typeIdx ?? "")).join(",")}->${resultTypes.map((r) => r.kind + ((r as any).typeIdx ?? "")).join(",")}`;
  const cached = ctx.constructibleFuncRefWrapperCache.get(sigKey);
  if (cached) {
    return { structTypeIdx: cached.structTypeIdx, liftedFuncTypeIdx: cached.funcTypeIdx, closureInfo: cached };
  }

  const base = getOrCreateFuncRefWrapperTypes(ctx, userParams, resultTypes);
  if (!base) return null;
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__constructible_fn_wrap_${ctx.closureCounter++}_struct`,
    fields: [
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      { name: "__constructible", type: { kind: "i32" as const }, mutable: false },
    ],
    superTypeIdx: base.structTypeIdx,
  });
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: base.liftedFuncTypeIdx,
    returnType: resultTypes.length > 0 ? resultTypes[0]! : null,
    paramTypes: userParams,
  };
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);
  ctx.constructibleFuncRefWrapperCache.set(sigKey, closureInfo);
  ctx.constructibleClosureTypeIdxs.add(structTypeIdx);
  return { structTypeIdx, liftedFuncTypeIdx: base.liftedFuncTypeIdx, closureInfo };
}

/**
 * (#2873 park fix) The ROOT funcref-wrapper struct type — the FIRST wrapper
 * `getOrCreateFuncRefWrapperTypes` created in this module. Every later
 * per-signature wrapper struct is a `sub final` of it (see the star chaining
 * above), so the root is the ONLY wrapper type a `ref.test`/`ref.cast` is
 * guaranteed to accept for a closure value of ANY signature's wrapper.
 *
 * Why callers need it: wrapper structs are all layout-identical
 * `(struct (field funcref))`, but WasmGC isorecursive canonicalization keys on
 * (fields, supertype, finality) — a `sub final $root` sibling does NOT
 * canonicalize with the root or with another sibling. A call site that casts a
 * closure value to the wrapper of its *declared* signature therefore nulls out
 * whenever the value was allocated under a different signature's wrapper
 * (e.g. an activated async closure: its wrapper is minted for the REWRITTEN
 * `... -> externref` Promise signature, while an `fn: () => void` param casts
 * to the void wrapper) — unless creation ORDER happened to make the declared
 * wrapper the root. Cast to the root instead and discriminate on the funcref's
 * exact type (which encodes the true signature).
 */
export function getFuncRefWrapperRootTypeIdx(ctx: CodegenContext): number | undefined {
  return (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx;
}
