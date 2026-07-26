// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irImportGlobalRef } from "../ir/abi-bindings.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { Import } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Source-anchored global roles not owned by source declaration planning. */
const PROGRAM_ABI_IMPORT_GLOBAL_ROLE = Object.freeze({
  stringConstant: 4,
} as const);

/**
 * Plan one successfully inserted host string-constant import.
 *
 * String constants are program support owned by the canonical entry source.
 * Their stable literal ordinal disambiguates structural plan order, while the
 * binding itself is keyed by the exact import module/field payload rather than
 * its temporary `__str_N` compatibility label.
 */
export function planProgramAbiStringConstantImport(ctx: CodegenContext, value: Import, stableOrdinal: number): void {
  const session = ctx.programAbiSession;
  if (!session) return;
  if (value.desc.kind !== "global") {
    throw new ProgramAbiInvariantError(
      "slot-locator-space-mismatch",
      "string-constant ABI planning requires a global import object",
    );
  }
  const entrySources = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `string-constant ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  const entrySource = entrySources[0]!;
  const adapterName = `__str_${stableOrdinal}`;
  const ref = irImportGlobalRef(entrySource.id, value.module, value.name, adapterName, stableOrdinal);
  const structuralReferenceKey = irGlobalBindingKey(ref.binding);
  session.ensurePlan({
    id: ref.binding.bindingId,
    structuralOrder: session.structuralOrder.forSource(entrySource.id, {
      domain: "global",
      roleOrdinal: PROGRAM_ABI_IMPORT_GLOBAL_ROLE.stringConstant,
      derivedOrdinal: stableOrdinal,
    }),
    structuralReferenceKey,
    displayName: ref.name,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin: "import",
      valueType: JSON.stringify(value.desc.type),
      mutable: value.desc.mutable,
    },
  });
  session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
  if (!session.hasLocator(ref.binding.bindingId, value)) {
    session.attachLocator(ref.binding.bindingId, { kind: "import-global", value });
  }
}
