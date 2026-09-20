// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import { createErrorStructType } from "../../../runtime/wasmgc/values/string-layouts.js";
import { buildErrorConstructorBody } from "../../../runtime/wasmgc/values/error-bodies.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";

export interface NativeErrorDependencies {
  readonly strings: NativeStringLiteralReservations;
  /** Supplied from the existing tag authority; no second builtin catalog. */
  readonly typeErrorTag: number;
}
export interface NativeErrorReservations {
  readonly type: TypeReservation;
  readonly newTypeError: FunctionReservation;
}
const owners = new WeakMap<
  NativeErrorReservations,
  {
    tx: PhysicalModuleReservations;
    requirements: { readonly key: string };
    key: string;
    dependencies: NativeErrorDependencies;
    identities: NativeErrorDependencies;
    filled: boolean;
  }
>();

export function reserveNativeErrorResources(
  tx: PhysicalModuleReservations,
  requirements: { readonly key: string },
  dependencies: NativeErrorDependencies,
): NativeErrorReservations {
  if (!requirements.key || tx.state !== "reserving") throw new Error("native errors: invalid reservation phase/key");
  // ABI invariant, not a replacement catalog. The parent supplies the canonical value.
  if (dependencies.typeErrorTag !== -11) throw new Error("native errors: incorrect TypeError tag");
  requireNativeStringLiteral(tx, dependencies.strings, "TypeError");
  tx.assertReservationKeysAvailable([`${requirements.key}:type`, `${requirements.key}:new-TypeError`]);
  const type = tx.reserveType(`${requirements.key}:type`, createErrorStructType());
  tx.internFunctionType([{ kind: "externref" }], [{ kind: "externref" }], "__new_TypeError_type");
  const newTypeError = tx.reserveFunction(`${requirements.key}:new-TypeError`, "__new_TypeError", {
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const pack = Object.freeze({ type, newTypeError });
  owners.set(pack, {
    tx,
    requirements,
    key: requirements.key,
    dependencies,
    identities: Object.freeze({ ...dependencies }),
    filled: false,
  });
  return pack;
}

/** Reservation authority only: completion remains a separate canonical-fill assertion. */
export function requireNativeErrorReservations(
  tx: PhysicalModuleReservations,
  pack: NativeErrorReservations,
  expectedRequirements: { readonly key: string },
  expectedDependencies: NativeErrorDependencies,
): NativeErrorReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native errors: foreign or forged resource owner");
  if (
    owner.requirements !== expectedRequirements ||
    owner.dependencies !== expectedDependencies ||
    owner.key !== expectedRequirements.key ||
    expectedDependencies.strings !== owner.identities.strings ||
    expectedDependencies.typeErrorTag !== owner.identities.typeErrorTag
  )
    throw new Error("native errors: substituted reservation input");
  requireNativeStringLiteral(tx, owner.dependencies.strings, "TypeError");
  if (tx.state === "reserving") tx.assertTypeReservation(pack.type);
  else {
    tx.physicalIndex(pack.type);
    tx.physicalIndex(pack.newTypeError);
  }
  if (preparedIrDataMismatch(pack.type.object, createErrorStructType()) !== undefined)
    throw new Error("native errors: altered TypeError layout");
  return pack;
}

export function fillNativeErrorResources(tx: PhysicalModuleReservations, pack: NativeErrorReservations): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native errors: foreign or forged resource owner");
  requireNativeErrorReservations(tx, pack, owner.requirements, owner.dependencies);
  if (owner.filled) throw new Error("native errors: duplicate fill");
  tx.physicalIndex(pack.type);
  const name = requireNativeStringLiteral(tx, owner.dependencies.strings, "TypeError");
  tx.fillFunction(pack.newTypeError, {
    locals: [],
    body: buildErrorConstructorBody(
      pack.type.typeIndex,
      owner.dependencies.typeErrorTag,
      1,
      name.kind === "global"
        ? { kind: "global", index: tx.physicalIndex(name.global), representation: "gc" }
        : { kind: "callable", handle: name.function.handle, representation: "gc" },
    ),
  });
  owner.filled = true;
}

export function requireCompletedNativeErrors(
  tx: PhysicalModuleReservations,
  pack: NativeErrorReservations,
  expectedRequirements: { readonly key: string },
  expectedDependencies: NativeErrorDependencies,
): NativeErrorReservations {
  requireNativeErrorReservations(tx, pack, expectedRequirements, expectedDependencies);
  if (!owners.get(pack)!.filled) throw new Error("native errors: missing canonical fill");
  requireCompletedNativeStringLiterals(tx, expectedDependencies.strings);
  tx.assertCompletedReservation(pack.newTypeError);
  return pack;
}
