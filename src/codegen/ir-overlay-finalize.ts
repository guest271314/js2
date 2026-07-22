// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrHostVoidCallbackLoweringPlan } from "../ir/ast-lowering-plans.js";
import type { IrUnitId } from "../ir/identity.js";
import { classifyIrFailure, type IrPreparationFailure } from "../ir/outcomes.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningOwnerUnitId,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../ir/planning-identity.js";
import type { IrPromiseDelayLoweringPlan, IrPromiseDelayLoweringPlans } from "../ir/promise-delay-lowering.js";
import type { IrSelection } from "../ir/select.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { collectLocalCallEdges, collectLocalCallEdgesByIdentity, MODULE_INIT_CALLER } from "./ir-first-gate.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

function planningInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

function requireExactSourceFunctionOwner(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  ownerUnitId: IrUnitId,
  ownerName?: string,
): ts.FunctionDeclaration {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  const unit = identityContext.unitByUnitId.get(ownerUnitId);
  if (!unit) {
    planningInvariant(
      "missing-planning-owner",
      `IR overlay owner ${ownerUnitId} is absent from the authoritative planning inventory`,
    );
  }
  if (unit.sourceId !== sourceId) {
    planningInvariant(
      "source-record-mismatch",
      `IR overlay owner ${ownerUnitId} belongs to source ${unit.sourceId}, not ${sourceId}`,
    );
  }
  const terminal = identityContext.terminalByUnitId.get(ownerUnitId);
  if (!terminal || terminal !== unit || !terminal.terminal || terminal.terminalOwnerId !== ownerUnitId) {
    planningInvariant("terminal-record-mismatch", `IR overlay owner ${ownerUnitId} is not an exact terminal unit`);
  }
  const declaration = identityContext.declarationByUnitId.get(ownerUnitId);
  if (
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.parent !== sourceFile ||
    !sourceFile.statements.includes(declaration) ||
    !declaration.body ||
    identityContext.unitIdByDeclaration.get(declaration) !== ownerUnitId
  ) {
    planningInvariant(
      "unit-record-mismatch",
      `IR overlay owner ${ownerUnitId} is not an exact executable function in ${sourceFile.fileName}`,
    );
  }
  if (ownerName !== undefined && terminal.legacyMatchName !== ownerName) {
    planningInvariant(
      "unit-record-mismatch",
      `IR overlay owner label ${JSON.stringify(ownerName)} does not match ${ownerUnitId}`,
    );
  }
  return declaration;
}

function exactNodeIsReachableFrom(root: ts.Node, target: ts.Node): boolean {
  let reachable = false;
  const visit = (node: ts.Node): void => {
    if (reachable) return;
    if (node === target) {
      reachable = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return reachable;
}

function requireExactPlanSiteOwner(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  ownerUnitId: IrUnitId,
  ownerName: string,
  site: ts.Node,
  planKind: string,
): void {
  const owner = requireExactSourceFunctionOwner(sourceFile, identityContext, ownerUnitId, ownerName);
  const actualOwner = requireIrPlanningOwnerUnitId(identityContext, site);
  if (actualOwner !== ownerUnitId) {
    planningInvariant(
      "terminal-record-mismatch",
      `${planKind} site belongs to ${actualOwner}, not retained owner ${ownerUnitId}`,
    );
  }
  if (!exactNodeIsReachableFrom(owner.body!, site)) {
    planningInvariant(
      "unit-record-mismatch",
      `${planKind} site is no longer reachable from the exact current body of ${ownerUnitId}`,
    );
  }
}

function validateRetainedFunctionUnitIds(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  retainedFunctionUnitIds: ReadonlySet<IrUnitId>,
): Set<IrUnitId> {
  const retained = new Set<IrUnitId>();
  for (const unitId of retainedFunctionUnitIds) {
    requireExactSourceFunctionOwner(sourceFile, identityContext, unitId);
    retained.add(unitId);
  }
  return retained;
}

function requireExactSourceBlockedOwner(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  ownerUnitId: IrUnitId,
  ownerName?: string,
): void {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  const unit = identityContext.unitByUnitId.get(ownerUnitId);
  if (!unit) {
    planningInvariant(
      "missing-planning-owner",
      `blocked IR overlay owner ${ownerUnitId} is absent from the authoritative planning inventory`,
    );
  }
  if (unit.sourceId !== sourceId) {
    planningInvariant(
      "source-record-mismatch",
      `blocked IR overlay owner ${ownerUnitId} belongs to source ${unit.sourceId}, not ${sourceId}`,
    );
  }
  if (unit.kind !== "module-init") {
    requireExactSourceFunctionOwner(sourceFile, identityContext, ownerUnitId, ownerName);
    return;
  }

  const terminal = identityContext.terminalByUnitId.get(ownerUnitId);
  if (
    !terminal ||
    terminal !== unit ||
    !terminal.terminal ||
    terminal.terminalOwnerId !== ownerUnitId ||
    terminal.observedKind !== "module-init" ||
    terminal.lexicalOwnerId !== null ||
    identityContext.moduleInitUnitIdBySourceFile.get(sourceFile) !== ownerUnitId ||
    identityContext.moduleInitUnitIdBySourceId.get(sourceId) !== ownerUnitId
  ) {
    planningInvariant(
      "invalid-module-init",
      `blocked IR overlay owner ${ownerUnitId} is not this source's exact module-init terminal`,
    );
  }
  if (ownerName !== undefined && terminal.legacyMatchName !== ownerName) {
    planningInvariant(
      "unit-record-mismatch",
      `IR overlay module-init label ${JSON.stringify(ownerName)} does not match ${ownerUnitId}`,
    );
  }
}

function requireExactSourceModuleInitOwner(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  ownerUnitId: IrUnitId,
  ownerName?: string,
): void {
  requireExactSourceBlockedOwner(sourceFile, identityContext, ownerUnitId, ownerName);
  if (identityContext.unitByUnitId.get(ownerUnitId)?.kind !== "module-init") {
    planningInvariant("invalid-module-init", `IR overlay owner ${ownerUnitId} is not a module-init unit`);
  }
}

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

/**
 * Identity-keyed blocked-component closure over the already retained function
 * population. Raw selector claims are deliberately not consulted here: a
 * function dropped during type preparation must never be resurrected.
 */
export function closeIrBlockedComponentByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  retainedFunctionUnitIds: ReadonlySet<IrUnitId>,
  initialBlockedUnitIds: ReadonlySet<IrUnitId>,
): Set<IrUnitId> {
  const retained = validateRetainedFunctionUnitIds(sourceFile, identityContext, retainedFunctionUnitIds);
  return closeRetainedIrOwnersByIdentity(sourceFile, identityContext, retained, initialBlockedUnitIds);
}

/** Preserve the legacy final-context rule that one blocked function demotes every non-function owner too. */
export function applyIrFinalContextFunctionRetention(
  selection: IrSelection,
  retainedFunctionNames: Set<string>,
  blockedAnyFunction: boolean,
): IrSelection {
  return blockedAnyFunction
    ? { funcs: retainedFunctionNames, classMembers: new Set(), moduleInit: undefined }
    : { ...selection, funcs: retainedFunctionNames };
}

function closeRetainedIrOwnersByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  retained: Set<IrUnitId>,
  initialBlockedUnitIds: ReadonlySet<IrUnitId>,
): Set<IrUnitId> {
  const blocked = new Set<IrUnitId>();
  for (const unitId of initialBlockedUnitIds) {
    requireExactSourceBlockedOwner(sourceFile, identityContext, unitId);
    blocked.add(unitId);
    retained.delete(unitId);
  }

  const { callees } = collectLocalCallEdgesByIdentity(sourceFile, identityContext);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [caller, targets] of callees) {
      if (blocked.has(caller)) {
        for (const callee of targets) {
          if (!retained.delete(callee)) continue;
          blocked.add(callee);
          changed = true;
        }
      } else if (retained.has(caller)) {
        for (const callee of targets) {
          if (!blocked.has(callee)) continue;
          retained.delete(caller);
          blocked.add(caller);
          changed = true;
          break;
        }
      }
    }
  }
  return retained;
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

/** Exact callback preparation keyed by structural terminal owner. */
export function prepareHostVoidCallbackLoweringByIdentity(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  callbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>,
  retainedFunctionUnitIds: ReadonlySet<IrUnitId>,
  identityContext: IrPlanningIdentityContext,
): Set<IrUnitId> {
  const retained = validateRetainedFunctionUnitIds(sourceFile, identityContext, retainedFunctionUnitIds);
  for (const [callback, plan] of callbacks) {
    requireExactPlanSiteOwner(
      sourceFile,
      identityContext,
      plan.ownerUnitId,
      plan.ownerName,
      callback,
      "host callback plan",
    );
  }
  const activePlans = [...callbacks.values()].filter((callback) => retained.has(callback.ownerUnitId));
  if (activePlans.length === 0) return retained;

  const blocked = new Set<IrUnitId>();
  if (!hasExactHostVoidCallbackMakerImport(ctx)) {
    for (const callback of activePlans) blocked.add(callback.ownerUnitId);
  }
  for (const callback of activePlans) {
    const liftedName = `${callback.ownerName}__closure_${callback.liftedOrdinal}`;
    if (ctx.funcMap.has(liftedName) || ctx.mod.functions.some((fn) => fn.name === liftedName)) {
      blocked.add(callback.ownerUnitId);
    }
  }
  return blocked.size === 0
    ? retained
    : closeIrBlockedComponentByIdentity(sourceFile, identityContext, retained, blocked);
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

/** Exact owner plus the validated legacy labels needed at the host-Date ABI seam. */
export interface IrHostDateSnapshotImportPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  readonly importNames: ReadonlySet<string>;
}

export interface IrHostDateSnapshotRetention {
  readonly retainedFunctionUnitIds: ReadonlySet<IrUnitId>;
  readonly retainedModuleInitUnitId?: IrUnitId;
}

export interface IrHostDateSnapshotPreparationOptions {
  readonly supportsHostDateSnapshots?: boolean;
}

function validateHostDateSnapshotPlansByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  importsByOwnerUnitId: ReadonlyMap<IrUnitId, IrHostDateSnapshotImportPlan>,
): readonly IrHostDateSnapshotImportPlan[] {
  const plans: IrHostDateSnapshotImportPlan[] = [];
  for (const [ownerUnitId, plan] of importsByOwnerUnitId) {
    if (ownerUnitId !== plan.ownerUnitId) {
      planningInvariant(
        "unit-record-mismatch",
        `host-Date map key ${ownerUnitId} does not match plan owner ${plan.ownerUnitId}`,
      );
    }
    requireExactSourceBlockedOwner(sourceFile, identityContext, plan.ownerUnitId, plan.ownerName);
    plans.push(plan);
  }
  return plans;
}

function validateRetainedHostDateOwners(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  retainedFunctionUnitIds: ReadonlySet<IrUnitId>,
  retainedModuleInitUnitId: IrUnitId | undefined,
): Set<IrUnitId> {
  const retained = validateRetainedFunctionUnitIds(sourceFile, identityContext, retainedFunctionUnitIds);
  if (retainedModuleInitUnitId !== undefined) {
    requireExactSourceModuleInitOwner(sourceFile, identityContext, retainedModuleInitUnitId);
    retained.add(retainedModuleInitUnitId);
  }
  return retained;
}

function projectHostDateRetention(
  retainedOwnerUnitIds: Set<IrUnitId>,
  retainedModuleInitUnitId: IrUnitId | undefined,
): IrHostDateSnapshotRetention {
  const moduleInitRetained =
    retainedModuleInitUnitId !== undefined && retainedOwnerUnitIds.delete(retainedModuleInitUnitId);
  return {
    retainedFunctionUnitIds: retainedOwnerUnitIds,
    ...(moduleInitRetained ? { retainedModuleInitUnitId } : {}),
  };
}

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

/** Materialise Calendar's host-Date ABI while retaining exact function and module-init ownership. */
export function prepareHostDateSnapshotLoweringByIdentity(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  importsByOwnerUnitId: ReadonlyMap<IrUnitId, IrHostDateSnapshotImportPlan>,
  retainedFunctionUnitIds: ReadonlySet<IrUnitId>,
  retainedModuleInitUnitId: IrUnitId | undefined,
  identityContext: IrPlanningIdentityContext,
  options: IrHostDateSnapshotPreparationOptions = {},
): IrHostDateSnapshotRetention {
  let retained = validateRetainedHostDateOwners(
    sourceFile,
    identityContext,
    retainedFunctionUnitIds,
    retainedModuleInitUnitId,
  );
  const plans = validateHostDateSnapshotPlansByIdentity(sourceFile, identityContext, importsByOwnerUnitId);
  const activePlans = plans.filter((plan) => retained.has(plan.ownerUnitId));
  if (activePlans.length === 0) return projectHostDateRetention(retained, retainedModuleInitUnitId);

  const blockedBeforeRegistration = new Set<IrUnitId>();
  if (options.supportsHostDateSnapshots === false) {
    for (const plan of activePlans) blockedBeforeRegistration.add(plan.ownerUnitId);
  } else {
    // Prove every existing occupant before mutation so a wrong Date_get* name
    // cannot leave a partial Date_new import on the legacy fallback path.
    for (const plan of activePlans) {
      for (const name of plan.importNames) {
        const signature = HOST_DATE_IMPORT_SIGNATURES.get(name);
        if (
          !signature ||
          (ctx.funcMap.has(name) && !hasExactEnvFunctionImport(ctx, name, signature.params, signature.results))
        ) {
          blockedBeforeRegistration.add(plan.ownerUnitId);
          break;
        }
      }
    }
  }

  if (blockedBeforeRegistration.size > 0) {
    retained = closeRetainedIrOwnersByIdentity(sourceFile, identityContext, retained, blockedBeforeRegistration);
  }
  if (options.supportsHostDateSnapshots === false) {
    return projectHostDateRetention(retained, retainedModuleInitUnitId);
  }

  const needed = new Set<string>();
  for (const plan of plans) {
    if (!retained.has(plan.ownerUnitId)) continue;
    for (const name of plan.importNames) needed.add(name);
  }
  let requestedLateImport = false;
  for (const name of needed) {
    const signature = HOST_DATE_IMPORT_SIGNATURES.get(name)!;
    if (!ctx.funcMap.has(name)) requestedLateImport = true;
    ensureLateImport(ctx, name, [...signature.params], [...signature.results]);
  }
  if (requestedLateImport) flushLateImportShifts(ctx, null);

  const blockedAfterRegistration = new Set<IrUnitId>();
  for (const plan of plans) {
    if (!retained.has(plan.ownerUnitId)) continue;
    for (const name of plan.importNames) {
      const signature = HOST_DATE_IMPORT_SIGNATURES.get(name)!;
      if (!hasExactEnvFunctionImport(ctx, name, signature.params, signature.results)) {
        blockedAfterRegistration.add(plan.ownerUnitId);
        break;
      }
    }
  }
  if (blockedAfterRegistration.size > 0) {
    retained = closeRetainedIrOwnersByIdentity(sourceFile, identityContext, retained, blockedAfterRegistration);
  }
  return projectHostDateRetention(retained, retainedModuleInitUnitId);
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
  preparationFailures?: Map<string, IrPreparationFailure>,
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

  let registrationFailure: IrPreparationFailure | undefined;
  try {
    if (process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW === "1") {
      throw new Error("injected Promise late-registration failure");
    }
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
  } catch (error) {
    registrationFailure = classifyIrFailure(error, "resolve");
    for (const delay of retainedPlans) preparationFailures?.set(delay.ownerName, registrationFailure);
  }

  const exactAfterRegistration =
    !registrationFailure &&
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

function validatePromiseDelayPlansByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  plans: IrPromiseDelayLoweringPlans,
): readonly IrPromiseDelayLoweringPlan[] {
  const uniquePlans = new Set<IrPromiseDelayLoweringPlan>();
  const collect = <TNode extends ts.Node>(
    entries: ReadonlyMap<TNode, IrPromiseDelayLoweringPlan>,
    expectedNode: (plan: IrPromiseDelayLoweringPlan) => ts.Node,
    kind: string,
  ): void => {
    for (const [node, plan] of entries) {
      if (node !== expectedNode(plan)) {
        planningInvariant("unit-record-mismatch", `${kind} map does not retain its exact certified AST node`);
      }
      uniquePlans.add(plan);
    }
  };
  collect(plans.constructions, (plan) => plan.construction, "Promise construction");
  collect(plans.timers, (plan) => plan.timerCall, "Promise timer");
  collect(plans.resolves, (plan) => plan.resolveCall, "Promise resolve");

  for (const plan of uniquePlans) {
    if (
      plans.constructions.get(plan.construction) !== plan ||
      plans.timers.get(plan.timerCall) !== plan ||
      plans.resolves.get(plan.resolveCall) !== plan
    ) {
      planningInvariant("unit-record-mismatch", "Promise delay plan is incomplete across its exact AST-site maps");
    }
    for (const [site, kind] of [
      [plan.construction, "Promise construction"],
      [plan.executor, "Promise executor"],
      [plan.timerCall, "Promise timer"],
      [plan.timerCallback, "Promise timer callback"],
      [plan.resolveCall, "Promise resolve"],
    ] as const) {
      requireExactPlanSiteOwner(sourceFile, identityContext, plan.ownerUnitId, plan.ownerName, site, `${kind} plan`);
    }
  }
  return [...uniquePlans];
}

/** Exact Promise preparation keyed by structural terminal owner. */
export function preparePromiseDelayLoweringByIdentity(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plans: IrPromiseDelayLoweringPlans,
  retainedFunctionUnitIds: ReadonlySet<IrUnitId>,
  identityContext: IrPlanningIdentityContext,
  preparationFailures?: Map<IrUnitId, IrPreparationFailure>,
): Set<IrUnitId> {
  let retained = validateRetainedFunctionUnitIds(sourceFile, identityContext, retainedFunctionUnitIds);
  const validatedPlans = validatePromiseDelayPlansByIdentity(sourceFile, identityContext, plans);
  const activePlans = validatedPlans.filter((delay) => retained.has(delay.ownerUnitId));
  if (activePlans.length === 0) return retained;

  const blocked = new Set<IrUnitId>();
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
    for (const delay of activePlans) blocked.add(delay.ownerUnitId);
  }
  for (const delay of activePlans) {
    for (const liftedName of [delay.executorLiftedName, delay.timerLiftedName]) {
      if (ctx.funcMap.has(liftedName) || ctx.mod.functions.some((fn) => fn.name === liftedName)) {
        blocked.add(delay.ownerUnitId);
      }
    }
  }
  if (blocked.size > 0) {
    retained = closeIrBlockedComponentByIdentity(sourceFile, identityContext, retained, blocked);
  }
  const retainedPlans = activePlans.filter((delay) => retained.has(delay.ownerUnitId));
  if (retainedPlans.length === 0) return retained;

  let registrationFailure: IrPreparationFailure | undefined;
  try {
    if (process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW === "1") {
      throw new Error("injected Promise late-registration failure");
    }
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
  } catch (error) {
    registrationFailure = classifyIrFailure(error, "resolve");
    for (const delay of retainedPlans) preparationFailures?.set(delay.ownerUnitId, registrationFailure);
  }

  const exactAfterRegistration =
    !registrationFailure &&
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
    retained = closeIrBlockedComponentByIdentity(
      sourceFile,
      identityContext,
      retained,
      new Set(retainedPlans.map((delay) => delay.ownerUnitId)),
    );
  }
  return retained;
}
