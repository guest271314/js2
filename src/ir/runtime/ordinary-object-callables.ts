// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { OrdinaryObjectRuntimeFeature } from "./contracts/manifest.js";

const EXTERNAL: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const FLAGS: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

function declaration(
  feature: OrdinaryObjectRuntimeFeature,
  params: readonly IrType[],
  results: readonly IrType[],
): IrRuntimeCallableDeclaration {
  return Object.freeze({
    feature,
    ref: irIntrinsicFuncRef(feature),
    params: Object.freeze(params),
    results: Object.freeze(results),
  });
}

/**
 * Ordinary property semantics, separate from fixed-field object.new/get/set.
 * Keys are already canonical String/Symbol PropertyKeys. Get retains its
 * original receiver independently of the prototype-walk cursor.
 *
 * Descriptor words use the existing exact integer f64 encoding: W/E/C values
 * in bits 0..2, their presence in 3..5, value presence in 7, getter/setter
 * presence in 8/9. Accessor operations require explicit half-presence bits;
 * zero must never inherit the historical "both specified" fallback. The
 * attributes-only operation preserves the existing property's kind and value.
 * These declarations do not grant physical provider or receiver authority.
 */
const DECLARATIONS: Readonly<Record<OrdinaryObjectRuntimeFeature, IrRuntimeCallableDeclaration>> = Object.freeze({
  "js.object.create-default": declaration("js.object.create-default", [], [EXTERNAL]),
  "js.object.create-null": declaration("js.object.create-null", [], [EXTERNAL]),
  "js.object.create-with-prototype": declaration("js.object.create-with-prototype", [EXTERNAL], [EXTERNAL]),
  "js.object.define-data": declaration("js.object.define-data", [EXTERNAL, EXTERNAL, EXTERNAL, FLAGS], []),
  "js.object.define-accessor": declaration(
    "js.object.define-accessor",
    [EXTERNAL, EXTERNAL, EXTERNAL, EXTERNAL, FLAGS],
    [],
  ),
  "js.object.define-attributes": declaration("js.object.define-attributes", [EXTERNAL, EXTERNAL, FLAGS], []),
  "js.object.get": declaration("js.object.get", [EXTERNAL, EXTERNAL, EXTERNAL], [EXTERNAL]),
  "js.object.has": declaration("js.object.has", [EXTERNAL, EXTERNAL], [BOOLEAN]),
});

/** Exact semantic binding only; neither display names nor runtime aliases qualify. */
export function irOrdinaryObjectCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  if (ref.binding.kind !== "intrinsic" || !Object.hasOwn(DECLARATIONS, ref.binding.symbol)) return undefined;
  return DECLARATIONS[ref.binding.symbol as OrdinaryObjectRuntimeFeature];
}
