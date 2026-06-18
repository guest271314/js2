// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2193 / #43 harvest) Native `$NativeProto` glue for `Array.prototype` and
 * `Object.prototype` so a bare `Array.prototype` / `Object.prototype` value read
 * resolves host-free in `--target standalone` instead of refusing
 * (`property-access.ts` `reportUnsupportedStandaloneBuiltinValueRead`,
 * "#1907 / #1888 S6-b").
 *
 * Scope (PR-A): the PROTO OBJECT itself. `emitLazyNativeProtoGet` builds the
 * `$NativeProto` struct purely from the glue's `memberCsv` + `name` — it never
 * calls `emitMemberBody`. So registering glue with the correct member CSV makes
 * `Array.prototype` / `Object.prototype` value reads (and their reference
 * identity, `Array.prototype === Array.prototype`) work immediately. Reflective
 * member-CLOSURE materialization (`Array.prototype.slice` as a callable value)
 * still routes through `emitMemberBody`; until the per-member native bodies are
 * filled in (PR-C), those degrade gracefully via a catchable TypeError rather
 * than a hard compile refusal — see `emitMemberBody` below.
 *
 * Dual-mode: host mode is untouched (the `__get_builtin` path stays). Pure Wasm,
 * no new host import.
 */

import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import {
  getBuiltinBrand,
  getNativeProtoBuiltinGlue,
  registerNativeProtoBuiltin,
  type NativeProtoBuiltinGlue,
} from "./native-proto.js";
import { emitThrowTypeError } from "./expressions/helpers.js";

/**
 * `Array.prototype`'s own enumerable+non-enumerable method names (ES2024
 * §23.1.3). `@@iterator` is the well-known-symbol member (the `$NativeProto`
 * symbol-cell sentinel form is `@@<id>`; Symbol.iterator's id is threaded by the
 * caller — for the value-read object we only need the string members in the CSV,
 * the symbol member is resolved by the computed-access path).
 */
const ARRAY_PROTO_METHODS = [
  "at",
  "concat",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "unshift",
  "values",
  "with",
] as const;

/** `Object.prototype`'s own method names (ES2024 §20.1.3). */
const OBJECT_PROTO_METHODS = [
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
] as const;

/** Spec arity (`fn.length`) of the proto methods that differ from the default 1. */
const PROTO_METHOD_LENGTH: Readonly<Record<string, number>> = {
  concat: 1,
  copyWithin: 2,
  every: 1,
  fill: 1,
  forEach: 1,
  push: 1,
  reduce: 1,
  splice: 2,
  unshift: 1,
  with: 2,
  hasOwnProperty: 1,
  isPrototypeOf: 1,
  propertyIsEnumerable: 1,
  // entries/keys/values/reverse/pop/shift/toString/valueOf/… default to 0 or 1;
  // the value-read object does not depend on exact arities, only the member set.
};

/**
 * Graceful member-body refusal: the value-read object (PR-A) does not need
 * member bodies, but if a reflective member closure is materialized for a member
 * whose native body isn't wired yet, emit a catchable TypeError instead of a
 * hard compile error. Keeps `Array.prototype` reads compilable while the
 * per-member native bodies land incrementally (#2193 PR-C).
 */
function emitProtoMemberBodyRefusal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brandName: string,
  member: string,
): ValType | null {
  emitThrowTypeError(ctx, fctx, `${brandName}.prototype.${member} is not yet implemented in --target standalone`);
  return null;
}

function makeGlue(
  ctx: CodegenContext,
  brand: number,
  name: string,
  members: readonly string[],
): NativeProtoBuiltinGlue {
  return {
    brand,
    name,
    memberCsv: members.join(","),
    // Array/Object.prototype members are all data methods (no accessor getters
    // on the prototype itself; `length` is an own data property of an instance,
    // not the proto).
    memberKind: () => "method",
    memberLength: (member) => PROTO_METHOD_LENGTH[member] ?? 1,
    emitMemberBody: (c, fctx, member) => emitProtoMemberBodyRefusal(c, fctx, name, member),
  };
}

/**
 * Register `Array.prototype` glue (idempotent) and return its brand, or
 * `undefined` if the Array brand isn't reserved (should not happen).
 */
export function ensureArrayNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Array");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Array", ARRAY_PROTO_METHODS));
  }
  return brand;
}

/** Register `Object.prototype` glue (idempotent) and return its brand. */
export function ensureObjectNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "Object");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "Object", OBJECT_PROTO_METHODS));
  }
  return brand;
}
