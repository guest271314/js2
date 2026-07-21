// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrHostVoidCallbackLoweringPlan } from "../ir/ast-lowering-plans.js";
import type { IrPromiseDelayLoweringPlans } from "../ir/promise-delay-lowering.js";
import type { IrSelection } from "../ir/select.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { collectLocalCallEdges, MODULE_INIT_CALLER } from "./ir-first-gate.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/** Demote both directions of a selected local-call component before legacy bodies are discarded. */
export function closeIrBlockedComponent(
  sourceFile: ts.SourceFile,
  selection: IrSelection,
  initialBlocked: ReadonlySet<string>,
): IrSelection {
  const funcs = new Set(selection.funcs);
  const blocked = new Set(initialBlocked);
  for (const name of blocked) funcs.delete(name);
  const callEdges = collectLocalCallEdges(sourceFile);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [caller, callees] of callEdges) {
      if (blocked.has(caller)) {
        for (const callee of callees) {
          if (!funcs.delete(callee)) continue;
          blocked.add(callee);
          changed = true;
        }
      } else if (funcs.has(caller)) {
        for (const callee of callees) {
          if (!blocked.has(callee)) continue;
          funcs.delete(caller);
          blocked.add(caller);
          changed = true;
          break;
        }
      }
    }
  }
  return { funcs, classMembers: new Set(), moduleInit: undefined };
}

/** Final-context proof for B2's symbolic `__make_callback` dependency. */
function hasExactHostVoidCallbackMakerImport(ctx: CodegenContext): boolean {
  const makerIdx = ctx.funcMap.get("__make_callback");
  if (makerIdx === undefined || makerIdx < 0 || makerIdx >= ctx.numImportFuncs) return false;

  let functionIndex = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (functionIndex++ !== makerIdx) continue;
    if (imported.module !== "env" || imported.name !== "__make_callback") return false;
    const type = ctx.mod.types[imported.desc.typeIdx];
    return (
      type?.kind === "func" &&
      type.params.length === 2 &&
      type.params[0]?.kind === "i32" &&
      type.params[1]?.kind === "externref" &&
      type.results.length === 1 &&
      type.results[0]?.kind === "externref"
    );
  }
  return false;
}

/** Apply B2/Calendar's safety proof after legacy declaration/import collection. */
export function prepareHostVoidCallbackLowering(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  callbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>,
  selection: IrSelection,
): IrSelection {
  const activePlans = [...callbacks.values()].filter((callback) => selection.funcs.has(callback.ownerName));
  if (activePlans.length === 0) return selection;

  const blocked = new Set<string>();
  if (!hasExactHostVoidCallbackMakerImport(ctx)) {
    for (const callback of activePlans) blocked.add(callback.ownerName);
  }
  for (const callback of activePlans) {
    const liftedName = `${callback.ownerName}__closure_${callback.liftedOrdinal}`;
    if (ctx.funcMap.has(liftedName) || ctx.mod.functions.some((fn) => fn.name === liftedName)) {
      blocked.add(callback.ownerName);
    }
  }
  return blocked.size === 0 ? selection : closeIrBlockedComponent(sourceFile, selection, blocked);
}

function sameValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if ((left.kind === "ref" || left.kind === "ref_null") && (right.kind === "ref" || right.kind === "ref_null")) {
    return left.typeIdx === right.typeIdx;
  }
  return true;
}

function hasExactEnvFunctionImport(
  ctx: CodegenContext,
  name: string,
  params: readonly ValType[],
  results: readonly ValType[],
): boolean {
  const idx = ctx.funcMap.get(name);
  if (idx === undefined || idx < 0 || idx >= ctx.numImportFuncs) return false;
  let functionIndex = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (functionIndex++ !== idx) continue;
    if (imported.module !== "env" || imported.name !== name) return false;
    const type = ctx.mod.types[imported.desc.typeIdx];
    return (
      type?.kind === "func" &&
      type.params.length === params.length &&
      type.results.length === results.length &&
      type.params.every((param, i) => sameValType(param, params[i]!)) &&
      type.results.every((result, i) => sameValType(result, results[i]!))
    );
  }
  return false;
}

interface HostDateImportSignature {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}

const HOST_DATE_IMPORT_SIGNATURES = new Map<string, HostDateImportSignature>([
  ["Date_new", { params: [], results: [{ kind: "externref" }] }],
  ["Date_getDate", { params: [{ kind: "externref" }], results: [{ kind: "f64" }] }],
  ["Date_getMonth", { params: [{ kind: "externref" }], results: [{ kind: "f64" }] }],
  ["Date_getFullYear", { params: [{ kind: "externref" }], results: [{ kind: "f64" }] }],
]);

function hasSelectedModuleInit(selection: IrSelection): boolean {
  return selection.moduleInit?.reason === null && selection.moduleInit.stmtCount > 0;
}

function closeIrBlockedModuleComponent(sourceFile: ts.SourceFile, selection: IrSelection): IrSelection {
  const moduleCallees = collectLocalCallEdges(sourceFile).get(MODULE_INIT_CALLER);
  if (moduleCallees && moduleCallees.size > 0) {
    return closeIrBlockedComponent(sourceFile, selection, moduleCallees);
  }
  return { ...selection, moduleInit: undefined };
}

function hostDateOwnerIsSelected(selection: IrSelection, owner: string): boolean {
  return owner === MODULE_INIT_CALLER ? hasSelectedModuleInit(selection) : selection.funcs.has(owner);
}

function closeBlockedHostDateOwners(
  sourceFile: ts.SourceFile,
  selection: IrSelection,
  blockedFunctions: ReadonlySet<string>,
  moduleInitBlocked: boolean,
): IrSelection {
  let retained = moduleInitBlocked ? closeIrBlockedModuleComponent(sourceFile, selection) : selection;
  if (blockedFunctions.size > 0) retained = closeIrBlockedComponent(sourceFile, retained, blockedFunctions);
  return retained;
}

/** Materialise and prove Calendar's synthetic host-Date ABI as one late-import batch. */
export function prepareHostDateSnapshotLowering(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  importsByOwner: ReadonlyMap<string, ReadonlySet<string>>,
  selection: IrSelection,
): IrSelection {
  if (importsByOwner.size === 0) return selection;
  const blocked = new Set<string>();
  let moduleInitBlocked = false;

  // Prove every existing occupant before mutation so a wrong Date_get* name
  // cannot leave a partial Date_new import on the legacy fallback path.
  for (const [owner, names] of importsByOwner) {
    if (!hostDateOwnerIsSelected(selection, owner)) continue;
    for (const name of names) {
      const signature = HOST_DATE_IMPORT_SIGNATURES.get(name);
      if (
        !signature ||
        (ctx.funcMap.has(name) && !hasExactEnvFunctionImport(ctx, name, signature.params, signature.results))
      ) {
        if (owner === MODULE_INIT_CALLER) moduleInitBlocked = true;
        else blocked.add(owner);
        break;
      }
    }
  }

  const retained =
    blocked.size === 0 && !moduleInitBlocked
      ? selection
      : closeBlockedHostDateOwners(sourceFile, selection, blocked, moduleInitBlocked);
  const needed = new Set<string>();
  for (const [owner, names] of importsByOwner) {
    if (!hostDateOwnerIsSelected(retained, owner)) continue;
    for (const name of names) needed.add(name);
  }
  let requestedLateImport = false;
  for (const name of needed) {
    const signature = HOST_DATE_IMPORT_SIGNATURES.get(name)!;
    if (!ctx.funcMap.has(name)) requestedLateImport = true;
    ensureLateImport(ctx, name, [...signature.params], [...signature.results]);
  }
  if (requestedLateImport) flushLateImportShifts(ctx, null);

  for (const [owner, names] of importsByOwner) {
    if (!hostDateOwnerIsSelected(retained, owner)) continue;
    for (const name of names) {
      const signature = HOST_DATE_IMPORT_SIGNATURES.get(name)!;
      if (!hasExactEnvFunctionImport(ctx, name, signature.params, signature.results)) {
        if (owner === MODULE_INIT_CALLER) moduleInitBlocked = true;
        else blocked.add(owner);
        break;
      }
    }
  }
  return blocked.size === 0 && !moduleInitBlocked
    ? retained
    : closeBlockedHostDateOwners(sourceFile, retained, blocked, moduleInitBlocked);
}

function hasFunctionNameOccupant(ctx: CodegenContext, name: string): boolean {
  return (
    ctx.funcMap.has(name) ||
    ctx.mod.functions.some((fn) => fn.name === name) ||
    ctx.mod.imports.some((imported) => imported.desc.kind === "func" && imported.name === name)
  );
}

function hasUncontestedExactEnvFunctionImport(
  ctx: CodegenContext,
  name: string,
  params: readonly ValType[],
  results: readonly ValType[],
): boolean {
  return (
    hasExactEnvFunctionImport(ctx, name, params, results) &&
    !ctx.mod.functions.some((fn) => fn.name === name) &&
    ctx.mod.imports.filter((imported) => imported.desc.kind === "func" && imported.name === name).length === 1
  );
}

/**
 * Final-context proof for the exact Promise delay. Collision checks precede
 * the single late-import batch so a demotion never leaves incidental helpers.
 */
export function preparePromiseDelayLowering(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plans: IrPromiseDelayLoweringPlans,
  selection: IrSelection,
): IrSelection {
  const activePlans = [...plans.constructions.values()].filter((delay) => selection.funcs.has(delay.ownerName));
  if (activePlans.length === 0) return selection;

  const blocked = new Set<string>();
  const promiseExact = hasUncontestedExactEnvFunctionImport(
    ctx,
    "Promise_new",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
  );
  const timerExact = hasUncontestedExactEnvFunctionImport(
    ctx,
    "__timer_set_timeout",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const boxExact = hasUncontestedExactEnvFunctionImport(
    ctx,
    "__box_number",
    [{ kind: "f64" }],
    [{ kind: "externref" }],
  );
  const callExact = hasUncontestedExactEnvFunctionImport(
    ctx,
    "__call_1_f64",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "f64" }],
  );

  if (
    !promiseExact ||
    !timerExact ||
    (hasFunctionNameOccupant(ctx, "__box_number") && !boxExact) ||
    (hasFunctionNameOccupant(ctx, "__call_1_f64") && !callExact)
  ) {
    for (const delay of activePlans) blocked.add(delay.ownerName);
  }
  for (const delay of activePlans) {
    for (const liftedName of [delay.executorLiftedName, delay.timerLiftedName]) {
      if (ctx.funcMap.has(liftedName) || ctx.mod.functions.some((fn) => fn.name === liftedName)) {
        blocked.add(delay.ownerName);
      }
    }
  }
  let retained = blocked.size === 0 ? selection : closeIrBlockedComponent(sourceFile, selection, blocked);
  const retainedPlans = activePlans.filter((delay) => retained.funcs.has(delay.ownerName));
  if (retainedPlans.length === 0) return retained;

  let registrationFailed = false;
  try {
    let requestedLateImport = false;
    if (!boxExact) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      requestedLateImport = true;
    }
    if (!callExact) {
      ensureLateImport(ctx, "__call_1_f64", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      requestedLateImport = true;
    }
    if (requestedLateImport) flushLateImportShifts(ctx, null);
  } catch {
    registrationFailed = true;
  }

  const exactAfterRegistration =
    !registrationFailed &&
    hasUncontestedExactEnvFunctionImport(ctx, "Promise_new", [{ kind: "externref" }], [{ kind: "externref" }]) &&
    hasUncontestedExactEnvFunctionImport(
      ctx,
      "__timer_set_timeout",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    ) &&
    hasUncontestedExactEnvFunctionImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]) &&
    hasUncontestedExactEnvFunctionImport(
      ctx,
      "__call_1_f64",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "f64" }],
    );
  if (!exactAfterRegistration) {
    retained = closeIrBlockedComponent(sourceFile, retained, new Set(retainedPlans.map((delay) => delay.ownerName)));
  }
  return retained;
}
