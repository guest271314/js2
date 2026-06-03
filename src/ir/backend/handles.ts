// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Backend layout-handle types (#1713).
//
// These interfaces describe the *layout* of an IR value in a concrete
// backend's representation. They are produced by the `IrLowerResolver`
// (layout factory, in `lower.ts`) and consumed by a `BackendEmitter`
// (op emission, in `backend/emitter.ts`).
//
// They were extracted verbatim from `lower.ts` so the `BackendEmitter`
// trait file can import them without pulling in the 2.4k-line lowering
// pass (which would create an import cycle). `lower.ts` re-exports them
// for backwards compatibility, so existing `import { IrVecLowering } from
// "./lower.js"` sites keep working.
//
// Phase 1 (#1713) keeps every handle WasmGC-typed (they expose `typeIdx` /
// `fieldIdx`). A second backend (#1714 linear, #1715 bytecode) introduces
// parallel handle shapes and parameterises the emitter over them -- see the
// `## Implementation Plan` section 7 in
// `plan/issues/1713-ir-backend-emitter-trait-seam.md` for that design step.
// Nothing here changes for Phase 1.

import type { ValType } from "../types.js";

/**
 * Information about a tagged-union struct type emitted into the WasmGC module.
 * See `passes/tagged-union-types.ts` for the registry that produces these.
 */
export interface IrUnionLowering {
  /** WasmGC type index of the `$union_<members>` struct. */
  readonly typeIdx: number;
  /** Field index of the `$tag` i32 discriminator. */
  readonly tagFieldIdx: number;
  /** Field index of the `$val` field carrying the member scalar. */
  readonly valFieldIdx: number;
  /** Canonical tag value (i32 constant) for each ValType kind. */
  tagFor(member: ValType): number;
}

/**
 * Information about a heap-allocated scalar box -- see
 * `IrType { kind: "boxed", inner }`. Resolved lazily by the lowering pass.
 */
export interface IrBoxedLowering {
  /** WasmGC type index of the `$box_<inner>` struct. */
  readonly typeIdx: number;
  /** Field index of the inner `$val`. */
  readonly valFieldIdx: number;
}

/**
 * Information about a registered WasmGC struct that backs an
 * `IrType.object` shape. The resolver memoizes one of these per shape.
 *
 * `fieldIdx(name)` returns the WasmGC struct's field index for the given
 * shape field name (in the shape's canonical order). It throws when the
 * name is not a member of the shape -- the lowerer catches via the
 * surrounding try/catch and emits a clean fall-back error.
 */
export interface IrObjectStructLowering {
  /** WasmGC type index of the registered struct. */
  readonly typeIdx: number;
  /** Field index for each field name in the shape's canonical order. */
  fieldIdx(name: string): number;
}

/**
 * Slice 3 (#1169c): WasmGC type info for a closure value. Two structs
 * are involved per closure construction site:
 *   - The SUPERTYPE struct (`structTypeIdx`): contains only the funcref
 *     field. Carried by the IrType.closure ValType so all closures
 *     sharing a signature have the same Wasm-level type.
 *   - The SUBTYPE struct (resolved via `resolveClosureSubtype`): adds
 *     the capture fields. Constructed at the closure's creation site
 *     (`struct.new <subtype>`) and `ref.cast`-ed inside the lifted
 *     body to read captures.
 *
 * `funcTypeIdx` is the lifted function's Wasm func type
 * `(ref $base, ...sig.params) -> sig.returnType` -- used by `call_ref`
 * at the call site.
 */
export interface IrClosureLowering {
  readonly structTypeIdx: number;
  readonly funcFieldIdx: number;
  /** Field index for capture position `i` (0-based). Valid only for subtype lowerings. */
  capFieldIdx(index: number): number;
  readonly funcTypeIdx: number;
}

/**
 * Slice 3 (#1169c): WasmGC type info for a ref cell over a primitive
 * value type. Single-field struct `(struct (field $value (mut T)))`.
 */
export interface IrRefCellLowering {
  readonly typeIdx: number;
  readonly fieldIdx: number;
}

/**
 * Slice 6 (#1169e): WasmGC type info for a vec struct (the runtime layout
 * for `Array<T>` / tuple types). The struct is `{ length: i32, data: (ref
 * $arr) }` where `$arr` is the element array type. This interface is the
 * lowerer's contract for emitting `vec.len` and `vec.get` against a known
 * vec value's IrType.
 *
 *   - `vecStructTypeIdx`   Wasm struct type index of the vec.
 *   - `lengthFieldIdx`     field index of the i32 length (typically 0).
 *   - `dataFieldIdx`       field index of the data array ref (typically 1).
 *   - `arrayTypeIdx`       Wasm array type index of the data array.
 *   - `elementValType`     element ValType -- used by `vec.get` to lower
 *                           the result and (recursively, via the resolver)
 *                           to widen the element to the loop variable's
 *                           declared type when needed.
 */
export interface IrVecLowering {
  readonly vecStructTypeIdx: number;
  readonly lengthFieldIdx: number;
  readonly dataFieldIdx: number;
  readonly arrayTypeIdx: number;
  readonly elementValType: ValType;
}

/**
 * Slice 4 (#1169d): WasmGC type info for a class declared in the
 * compilation unit. The class's struct + constructor + method funcs
 * are all registered by the legacy `collectClassDeclaration` pass before
 * the IR runs; this interface just exposes them by name.
 *
 *   - `structTypeIdx`        Wasm struct type index for the class
 *   - `fieldIdx(name)`       Wasm struct field index for a user field name
 *                             (the legacy `__tag` prefix at field 0 is
 *                             accounted for here so the IR doesn't need to
 *                             reason about it).
 *   - `constructorFuncName`  legacy-registered name of the constructor
 *                             function (`<className>_new`); the resolver's
 *                             `resolveFunc` maps it to the funcIdx.
 *   - `methodFuncName(name)` legacy-registered name of an instance method
 *                             (`<className>_<methodName>`); the resolver's
 *                             `resolveFunc` maps it to the funcIdx.
 */
export interface IrClassLowering {
  readonly structTypeIdx: number;
  fieldIdx(name: string): number;
  readonly constructorFuncName: string;
  methodFuncName(name: string): string;
}

/**
 * #1714: linear-memory layout handle for a vec (array). Sibling to
 * {@link IrVecLowering} (the WasmGC handle). The linear backend stores an
 * array as a base `i32` pointer to `[header 8B][len:u32 @+8][cap:u32
 * @+12][elements @+16…]` (see `src/codegen-linear/runtime.ts:339`), so the
 * only representation detail the emitter needs is the element ValType (for
 * stride + load op). Field offsets are fixed by the layout, not per-instance.
 *
 * This is the "different handle shape the linear resolver returns" that the
 * #1713 spec §7 anticipated. The `BackendEmitter` vec methods accept
 * `IrVecLowering | LinearVecLowering`; each emitter narrows to its own shape.
 */
export interface LinearVecLowering {
  /** Element ValType — drives stride (4 vs 8) and the load op. */
  readonly elementValType: ValType;
}
