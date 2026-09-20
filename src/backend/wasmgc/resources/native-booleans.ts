// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import {
  requireNativeValueReservations,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import {
  buildUnboxBooleanBody,
  buildUnboxBooleanLocals,
  buildTypeofBooleanBody,
} from "../../../runtime/wasmgc/values/boolean-bodies.js";

export interface NativeBooleanReservations {
  readonly isBoolean: FunctionReservation;
  readonly unboxBoolean: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly values: NativeValueReservations;
  readonly requirements: NativeValueResourcePlan;
  readonly dependencies: NativeValueDependencies;
  filled: boolean;
}
const owners = new WeakMap<NativeBooleanReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native Boolean resources: " + detail);
}

/** Reuse the issued primitive owner's Boolean type; never mint a lookalike. */
export function reserveNativeBooleanResources(
  tx: PhysicalModuleReservations,
  key: string,
  values: NativeValueReservations,
  requirements: NativeValueResourcePlan,
  dependencies: NativeValueDependencies,
): NativeBooleanReservations {
  if (!key || tx.state !== "reserving") fail("invalid reservation phase/key");
  requireNativeValueReservations(tx, values, requirements, dependencies);
  const signature = { params: [{ kind: "externref" } as const], results: [{ kind: "i32" } as const] };
  const pack = Object.freeze({
    isBoolean: tx.reserveFunction(key + ":typeof-boolean", "__typeof_boolean", signature),
    unboxBoolean: tx.reserveFunction(key + ":unbox-boolean", "__unbox_boolean", signature),
  });
  owners.set(pack, { tx, values, requirements, dependencies, filled: false });
  return pack;
}

export function requireNativeBooleanReservations(
  tx: PhysicalModuleReservations,
  pack: NativeBooleanReservations,
  values: NativeValueReservations,
  requirements: NativeValueResourcePlan,
  dependencies: NativeValueDependencies,
): NativeBooleanReservations {
  const owner = owners.get(pack);
  if (
    !owner ||
    owner.tx !== tx ||
    owner.values !== values ||
    owner.requirements !== requirements ||
    owner.dependencies !== dependencies
  )
    fail("foreign or substituted reservation inputs");
  requireNativeValueReservations(tx, values, requirements, dependencies);
  if (tx.state !== "reserving") {
    tx.physicalIndex(pack.isBoolean);
    tx.physicalIndex(pack.unboxBoolean);
  }
  return pack;
}

export function fillNativeBooleanResources(tx: PhysicalModuleReservations, pack: NativeBooleanReservations): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign resource owner");
  requireNativeBooleanReservations(tx, pack, owner.values, owner.requirements, owner.dependencies);
  requireCompletedNativeValues(tx, owner.values, owner.requirements, owner.dependencies);
  const type = owner.values.types.boxedBoolean.typeIndex;
  tx.fillFunction(pack.isBoolean, { locals: [], body: buildTypeofBooleanBody(type) });
  tx.fillFunction(pack.unboxBoolean, { locals: buildUnboxBooleanLocals(), body: buildUnboxBooleanBody(type) });
  owner.filled = true;
}

export function requireCompletedNativeBooleans(
  tx: PhysicalModuleReservations,
  pack: NativeBooleanReservations,
  values: NativeValueReservations,
  requirements: NativeValueResourcePlan,
  dependencies: NativeValueDependencies,
): NativeBooleanReservations {
  requireNativeBooleanReservations(tx, pack, values, requirements, dependencies);
  if (!owners.get(pack)!.filled) fail("incomplete Boolean resources");
  requireCompletedNativeValues(tx, values, requirements, dependencies);
  tx.assertCompletedReservation(pack.isBoolean);
  tx.assertCompletedReservation(pack.unboxBoolean);
  return pack;
}
