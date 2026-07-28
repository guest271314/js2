// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irSupportFuncRef } from "../ir/callable-bindings.js";
import type { IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncTypeDef, Import, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { planProgramAbiSupportCallable, PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import type { ProgramAbiSession } from "./program-abi-session.js";

const RETAINED_MODULE_FUNCTION_ROLE = "retained-module-function";

function canonicalEntrySource(session: ProgramAbiSession): IrSourceId {
  const entrySources = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `callable ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  return entrySources[0]!.id;
}

function functionSignature(ctx: CodegenContext, func: WasmFunction): FuncTypeDef {
  const signature = ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `retained function ${func.name} references non-function or missing type ${func.typeIdx}`,
    );
  }
  return signature;
}

/**
 * Final function-space population owner.
 *
 * Source bodies, imported callables, class adapters, and runtime providers keep
 * their semantic owners. Every remaining defined function receives one
 * entry-source support identity after DCE, making the final function index
 * space total without consulting funcMap or a function name.
 */
export class ProgramAbiCallableRegistry {
  private planned = false;

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
  ) {
    session.assertModule(ctx.mod);
  }

  planRetained(): void {
    if (this.planned) return;
    this.planned = true;

    const entrySourceId = canonicalEntrySource(this.session);
    const seen = new Set<object>();
    let finalIndex = 0;

    for (const value of this.ctx.mod.imports) {
      if (value.desc.kind !== "func") continue;
      this.assertUniqueAllocatorObject(seen, value, finalIndex);
      if (!this.session.locatorBindingId(value)) {
        throw new ProgramAbiInvariantError(
          "missing-required-locator",
          `retained function import ${value.module}.${value.name} has no Program ABI owner`,
        );
      }
      finalIndex++;
    }
    for (const func of this.ctx.mod.functions) {
      this.assertUniqueAllocatorObject(seen, func, finalIndex);
      if (!this.session.locatorBindingId(func)) {
        const name = func.name.length > 0 ? func.name : `function#${finalIndex}`;
        const ref = irSupportFuncRef(entrySourceId, RETAINED_MODULE_FUNCTION_ROLE, name, finalIndex);
        planProgramAbiSupportCallable(this.ctx, {
          ref,
          anchor: { kind: "source", sourceId: entrySourceId },
          role: RETAINED_MODULE_FUNCTION_ROLE,
          roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.retainedModuleFunction,
          derivedOrdinal: finalIndex,
          signature: functionSignature(this.ctx, func),
          func,
        });
      }
      finalIndex++;
    }
  }

  private assertUniqueAllocatorObject(seen: Set<object>, value: Import | WasmFunction, finalIndex: number): void {
    if (seen.has(value)) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `function allocator object appears more than once in final function space at index ${finalIndex}`,
      );
    }
    seen.add(value);
  }
}
