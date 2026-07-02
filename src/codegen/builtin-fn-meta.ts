// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2896) Standalone native function-object metadata.
 *
 * A builtin function value under `--target standalone` is a closure wrapper
 * struct (`getOrCreateFuncRefWrapperTypes`); it carries no `name`/`length`, so
 * every REFLECTIVE read (`Object.getOwnPropertyDescriptor(fn, "name")`,
 * `fn[key]` with a runtime key, `hasOwnProperty`, `getOwnPropertyNames`) sees
 * nothing — which fails test262's `propertyHelper.js verifyProperty` for every
 * builtin `name.js` / `length.js` / `prop-desc.js` even where a compile-time
 * direct-access meta fold exists (the helper's receiver/key are runtime params).
 *
 * ## Mechanism — per-(builtin, member) meta SUBTYPE, constant metadata per type
 *
 * For each distinct builtin function we materialize, register a UNIQUE struct
 * subtype of its signature wrapper:
 *
 *   `$__builtinfn_<n> { funcref func; (mut i32) bfnstate }  <: $__fn_wrap_<sig>`
 *
 * - Being a SUBTYPE of the signature wrapper keeps every existing call path
 *   working untouched (static closure calls, reflective `.call`, any-typed
 *   callback dispatch — they cast to the sig wrapper / root, and a subtype
 *   passes).
 * - The metadata itself ({name, length}) is statically known per (builtin,
 *   member), so it is NOT stored in fields — it lives in
 *   `ctx.builtinFnMetaByTypeIdx` keyed by the meta type index. The reflective
 *   runtime natives discriminate the receiver with `ref.test <metaType>` arms
 *   (type indices are rec-group/dead-elim stable — no funcidx hazard) that are
 *   SPLICED IN AT FINALIZE by `fillBuiltinFnMeta` (object-runtime.ts), after
 *   every meta type is known — same reserve/fill discipline as
 *   `fillExternIsArray` / `fillExternGetIdxVecArms`.
 * - `bfnstate` is the one piece of per-INSTANCE state: a deleted-bits mask
 *   (bit 0 = `name` deleted, bit 1 = `length` deleted). `verifyProperty`'s
 *   `isConfigurable` arm `delete`s the property and then requires
 *   `hasOwnProperty` to report false, so delete must genuinely work.
 *   `struct.new` sites therefore push an extra `i32.const 0`
 *   (`pushBuiltinFnClosureValueInstrs` below).
 */
import type { Instr } from "../ir/types.js";
import type { ClosureInfo, CodegenContext } from "./context/types.js";

/**
 * Spec `{name, length}` for the builtin STATIC method closures wired in
 * `ensureStandaloneBuiltinStaticMethodClosure` (property-access.ts). Keep in
 * sync with its `switch (key)`. Also consumed by the direct-access
 * `.name`/`.length` meta fold so the constant fold and the runtime descriptor
 * agree.
 */
export const STANDALONE_STATIC_METHOD_META: Record<string, { name: string; length: number }> = {
  "Array.isArray": { name: "isArray", length: 1 },
  "Object.keys": { name: "keys", length: 1 },
  "Object.getOwnPropertyDescriptor": { name: "getOwnPropertyDescriptor", length: 2 },
};

/**
 * Register (idempotently, keyed by `cacheKey`) the unique metadata-carrying
 * struct subtype for one builtin function closure and return its type index.
 *
 * - `baseStructTypeIdx` — the signature wrapper struct (the supertype).
 * - `baseClosureInfo` — the signature wrapper's ClosureInfo; a copy with
 *   `structTypeIdx` re-pointed at the meta type is registered in
 *   `ctx.closureInfoByTypeIdx` so the static closure-call path and the
 *   reflective `.call` recovery resolve the meta-typed value exactly like the
 *   base wrapper (the lifted func type takes `(ref $sigWrapper)` self — a meta
 *   instance passes as a subtype).
 */
export function ensureBuiltinFnMetaType(
  ctx: CodegenContext,
  baseStructTypeIdx: number,
  baseClosureInfo: ClosureInfo,
  cacheKey: string,
  name: string,
  length: number,
): number {
  if (!ctx.builtinFnMetaTypeByKey) ctx.builtinFnMetaTypeByKey = new Map();
  const existing = ctx.builtinFnMetaTypeByKey.get(cacheKey);
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__builtinfn_meta_${typeIdx}_struct`,
    fields: [
      // Field 0 must mirror the supertype exactly (same type + mutability).
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      // Deleted-bits mask: bit 0 = "name" deleted, bit 1 = "length" deleted.
      { name: "bfnstate", type: { kind: "i32" as const }, mutable: true },
    ],
    superTypeIdx: baseStructTypeIdx,
  });

  ctx.closureInfoByTypeIdx.set(typeIdx, { ...baseClosureInfo, structTypeIdx: typeIdx });
  if (!ctx.builtinFnMetaByTypeIdx) ctx.builtinFnMetaByTypeIdx = new Map();
  ctx.builtinFnMetaByTypeIdx.set(typeIdx, { name, length });
  ctx.builtinFnMetaTypeByKey.set(cacheKey, typeIdx);
  return typeIdx;
}

/** Bit set in `bfnstate` when the `name` own property was deleted. */
export const BFN_STATE_NAME_DELETED = 1;
/** Bit set in `bfnstate` when the `length` own property was deleted. */
export const BFN_STATE_LENGTH_DELETED = 2;

/**
 * The instruction sequence that materializes a builtin closure VALUE from a
 * factory result. A meta-typed closure struct has the extra `(mut i32)
 * bfnstate` field, so its `struct.new` needs one more operand than the plain
 * 2-op `ref.func` + `struct.new` sequence; non-meta types keep the old shape.
 */
export function pushBuiltinFnClosureValueInstrs(
  ctx: CodegenContext,
  closure: { type: { kind: "ref"; typeIdx: number }; funcIdx: number },
): Instr[] {
  const isMeta = ctx.builtinFnMetaByTypeIdx?.has(closure.type.typeIdx) ?? false;
  const instrs: Instr[] = [{ op: "ref.func", funcIdx: closure.funcIdx } as Instr];
  if (isMeta) instrs.push({ op: "i32.const", value: 0 } as Instr);
  instrs.push({ op: "struct.new", typeIdx: closure.type.typeIdx } as Instr);
  return instrs;
}
