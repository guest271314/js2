// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  LINEAR_RECORD_FIELD_SLOT_BYTES,
  LINEAR_RECORD_HEADER_BYTES,
  planLinearRecordLayout,
} from "../ir/analysis/linear-memory-plan.js";

/**
 * Class layout computation for the linear-memory backend.
 *
 * Each class instance is stored on the heap with the following layout:
 *   [type_tag: u8 at +0][padding 3B][payload_size: u32 at +4][field0: 8B at +8][field1: 8B at +16]...
 *
 * The header is 8 bytes (tag + padding + payload_size).
 * Each field occupies 8 bytes for uniform access (f64 for numbers, i32 stored in
 * the low 4 bytes for object references).
 */

export interface ClassLayout {
  name: string;
  /** Total allocation size: header (8) + 8 bytes per field */
  totalSize: number;
  /** Map from field name to its memory offset and wasm type */
  fields: Map<string, { offset: number; type: "i32" | "f64" }>;
  /** Map from field name to TS collection kind (for nested property access) */
  fieldCollectionKinds: Map<string, "Array" | "Uint8Array" | "Map" | "Set">;
  /** Map from method name to its wasm function name */
  methods: Map<string, string>;
  /** Map from getter property name to its wasm function name */
  getters: Map<string, string>;
  /** Wasm function name for the constructor */
  ctorFuncName: string;
}

/** Canonical header/slot constants shared by classes, object literals, and IR aggregates. */
export const LINEAR_AGGREGATE_HEADER_SIZE = LINEAR_RECORD_HEADER_BYTES;
export const LINEAR_AGGREGATE_FIELD_SIZE = LINEAR_RECORD_FIELD_SLOT_BYTES;
export const LINEAR_GENERIC_OBJECT_TAG = 0x10;

/**
 * Compute the memory layout for a class with the given fields.
 *
 * @param name - The class name
 * @param fieldDefs - Array of { name, type } where type is "i32" or "f64"
 * @returns The computed ClassLayout
 */
export function computeClassLayout(name: string, fieldDefs: { name: string; type: "i32" | "f64" }[]): ClassLayout {
  const plan = planLinearRecordLayout(
    `record:legacy:${JSON.stringify(name)}`,
    fieldDefs.map((field) => ({ name: field.name, storage: field.type })),
  );
  const fields = new Map<string, { offset: number; type: "i32" | "f64" }>();
  for (const field of plan.fields) {
    const type = field.storage;
    if (type !== "i32" && type !== "f64") {
      throw new Error(`linear class layout cannot store '${type}' field '${field.name}'`);
    }
    fields.set(field.name, { offset: field.offset, type });
  }
  if (plan.size.kind !== "constant") throw new Error("linear class layout must have a constant size");

  return {
    name,
    totalSize: plan.size.bytes,
    fields,
    fieldCollectionKinds: new Map(),
    methods: new Map(),
    getters: new Map(),
    ctorFuncName: `${name}_ctor`,
  };
}
