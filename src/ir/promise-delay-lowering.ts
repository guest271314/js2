// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import { asVal, irVal, type IrClosureSignature, type IrType, type IrValueId } from "./nodes.js";
import type { IrPromiseDelayCertification, IrPromiseDelayResolver } from "./promise-delay.js";

/** Exact node-identity plan produced only for the certified Promise delay. */
export interface IrPromiseDelayLoweringPlan {
  readonly ownerName: string;
  readonly construction: ts.NewExpression;
  readonly executor: ts.ArrowFunction & { readonly body: ts.Block };
  readonly timerCall: ts.CallExpression;
  readonly timerCallback: ts.ArrowFunction;
  readonly resolveCall: ts.CallExpression;
  readonly executorSignature: IrClosureSignature;
  readonly timerSignature: IrClosureSignature;
  readonly executorCaptureNames: readonly string[];
  readonly timerCaptureNames: readonly string[];
  readonly executorLiftedName: string;
  readonly timerLiftedName: string;
}

export interface IrPromiseDelayLoweringPlans {
  readonly constructions: ReadonlyMap<ts.NewExpression, IrPromiseDelayLoweringPlan>;
  readonly timers: ReadonlyMap<ts.CallExpression, IrPromiseDelayLoweringPlan>;
  readonly resolves: ReadonlyMap<ts.CallExpression, IrPromiseDelayLoweringPlan>;
}

export interface ExactClosureLoweringOptions {
  readonly orderedReadonlyCaptures?: readonly string[];
  readonly expectedLiftedName?: string;
  readonly allowConciseVoidBody?: boolean;
}

type PromiseDelayBuilder = Pick<IrFunctionBuilder, "emitCall" | "emitCallablePack" | "typeOf">;

/** Narrow facade keeps this exact lowering independent of from-ast's private context. */
export interface IrPromiseDelayLoweringHost {
  readonly builder: PromiseDelayBuilder;
  readonly funcName: string;
  lowerExpr(expr: ts.Expression, expected: IrType): IrValueId;
  lowerClosure(
    expr: ts.ArrowFunction,
    signature: IrClosureSignature,
    captures: ReadonlySet<string>,
    exact: ExactClosureLoweringOptions,
  ): IrValueId;
}

export function collectIrPromiseDelayOwners(
  sourceFile: ts.SourceFile,
  selectedOwners: ReadonlySet<string>,
  resolver: IrPromiseDelayResolver | undefined,
): ReadonlyMap<string, IrPromiseDelayCertification> {
  const byOwner = new Map<string, IrPromiseDelayCertification>();
  if (!resolver) return byOwner;
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !selectedOwners.has(statement.name.text)) continue;
    const certification = resolver.resolveOwner(statement);
    if (certification) byOwner.set(statement.name.text, certification);
  }
  return byOwner;
}

export function buildIrPromiseDelayLoweringPlans(
  byOwner: ReadonlyMap<string, IrPromiseDelayCertification>,
  selectedOwners: ReadonlySet<string>,
): IrPromiseDelayLoweringPlans {
  const constructions = new Map<ts.NewExpression, IrPromiseDelayLoweringPlan>();
  const timers = new Map<ts.CallExpression, IrPromiseDelayLoweringPlan>();
  const resolves = new Map<ts.CallExpression, IrPromiseDelayLoweringPlan>();
  for (const [ownerName, certification] of byOwner) {
    if (!selectedOwners.has(ownerName)) continue;
    const executorLiftedName = `${ownerName}__closure_${certification.executorOrdinal}`;
    const plan: IrPromiseDelayLoweringPlan = {
      ownerName,
      construction: certification.construction,
      executor: certification.executor,
      timerCall: certification.timerCall,
      timerCallback: certification.timerCallback,
      resolveCall: certification.resolveCall,
      executorSignature: { params: [irVal({ kind: "externref" })], returnType: null },
      timerSignature: { params: [], returnType: null },
      executorCaptureNames: certification.executorCaptureNames,
      timerCaptureNames: certification.timerCaptureNames,
      executorLiftedName,
      timerLiftedName: `${executorLiftedName}__closure_${certification.timerOrdinal}`,
    };
    constructions.set(certification.construction, plan);
    timers.set(certification.timerCall, plan);
    resolves.set(certification.resolveCall, plan);
  }
  return { constructions, timers, resolves };
}

function lowerResolveCall(
  expr: ts.CallExpression,
  plan: IrPromiseDelayLoweringPlan,
  host: IrPromiseDelayLoweringHost,
  statementPosition: boolean,
): IrValueId {
  if (
    expr !== plan.resolveCall ||
    !statementPosition ||
    !ts.isIdentifier(expr.expression) ||
    expr.arguments.length !== 1
  ) {
    throw new Error(`ir/from-ast: malformed Promise delay resolve plan (${host.funcName})`);
  }
  const resolve = host.lowerExpr(expr.expression, irVal({ kind: "externref" }));
  if (asVal(host.builder.typeOf(resolve))?.kind !== "externref") {
    throw new Error(`ir/from-ast: Promise resolve binding is not raw externref (${host.funcName})`);
  }
  const value = host.lowerExpr(expr.arguments[0]!, irVal({ kind: "f64" }));
  if (asVal(host.builder.typeOf(value))?.kind !== "f64") {
    throw new Error(`ir/from-ast: Promise resolve value is not f64 (${host.funcName})`);
  }
  const result = host.builder.emitCall(
    { kind: "func", name: "__call_1_f64" },
    [resolve, value],
    irVal({ kind: "f64" }),
  );
  if (result === null) throw new Error(`ir/from-ast: __call_1_f64 produced no value (${host.funcName})`);
  return result;
}

function lowerTimerCall(
  expr: ts.CallExpression,
  plan: IrPromiseDelayLoweringPlan,
  host: IrPromiseDelayLoweringHost,
  statementPosition: boolean,
): IrValueId {
  if (
    expr !== plan.timerCall ||
    !statementPosition ||
    expr.arguments.length !== 2 ||
    expr.arguments[0] !== plan.timerCallback ||
    plan.timerSignature.params.length !== 0 ||
    plan.timerSignature.returnType !== null
  ) {
    throw new Error(`ir/from-ast: malformed Promise delay timer plan (${host.funcName})`);
  }
  const timerClosure = host.lowerClosure(plan.timerCallback, plan.timerSignature, new Set(plan.timerCaptureNames), {
    orderedReadonlyCaptures: plan.timerCaptureNames,
    expectedLiftedName: plan.timerLiftedName,
    allowConciseVoidBody: true,
  });
  const packedTimer = host.builder.emitCallablePack(timerClosure, plan.timerSignature);
  const delay = host.lowerExpr(expr.arguments[1]!, irVal({ kind: "f64" }));
  if (asVal(host.builder.typeOf(delay))?.kind !== "f64") {
    throw new Error(`ir/from-ast: Promise delay timeout is not f64 (${host.funcName})`);
  }
  const boxedDelay = host.builder.emitCall(
    { kind: "func", name: "__box_number" },
    [delay],
    irVal({ kind: "externref" }),
  );
  if (boxedDelay === null) throw new Error(`ir/from-ast: __box_number produced no value (${host.funcName})`);
  const timerResult = host.builder.emitCall(
    { kind: "func", name: "__timer_set_timeout" },
    [packedTimer, boxedDelay],
    irVal({ kind: "externref" }),
  );
  if (timerResult === null) throw new Error(`ir/from-ast: __timer_set_timeout produced no value (${host.funcName})`);
  return timerResult;
}

export function tryLowerPromiseDelayCall(
  expr: ts.CallExpression,
  statementPosition: boolean,
  plans: IrPromiseDelayLoweringPlans | undefined,
  makeHost: () => IrPromiseDelayLoweringHost,
): IrValueId | undefined {
  const timer = plans?.timers.get(expr);
  if (timer) return lowerTimerCall(expr, timer, makeHost(), statementPosition);
  const resolve = plans?.resolves.get(expr);
  return resolve ? lowerResolveCall(expr, resolve, makeHost(), statementPosition) : undefined;
}

export function tryLowerPromiseDelayConstruction(
  expr: ts.NewExpression,
  plans: IrPromiseDelayLoweringPlans | undefined,
  makeHost: () => IrPromiseDelayLoweringHost,
): IrValueId | undefined {
  const plan = plans?.constructions.get(expr);
  if (!plan) return undefined;
  const host = makeHost();
  if (
    expr !== plan.construction ||
    expr.arguments?.length !== 1 ||
    expr.arguments[0] !== plan.executor ||
    plan.executorSignature.params.length !== 1 ||
    asVal(plan.executorSignature.params[0]!)?.kind !== "externref" ||
    plan.executorSignature.returnType !== null
  ) {
    throw new Error(`ir/from-ast: malformed Promise delay construction plan (${host.funcName})`);
  }
  const executor = host.lowerClosure(plan.executor, plan.executorSignature, new Set(plan.executorCaptureNames), {
    orderedReadonlyCaptures: plan.executorCaptureNames,
    expectedLiftedName: plan.executorLiftedName,
  });
  const packedExecutor = host.builder.emitCallablePack(executor, plan.executorSignature);
  const promise = host.builder.emitCall({ kind: "func", name: "Promise_new" }, [packedExecutor], {
    kind: "extern",
    className: "Promise",
  });
  if (promise === null) throw new Error(`ir/from-ast: Promise_new produced no value (${host.funcName})`);
  return promise;
}

export function validateExactCapturePlan(
  orderedNames: readonly string[],
  referencedNames: ReadonlySet<string>,
  ownParams: ReadonlySet<string>,
  lookup: (name: string) => "local" | "other" | undefined,
  funcName: string,
): void {
  const ordered = new Set(orderedNames);
  for (const name of referencedNames) {
    if (ownParams.has(name)) continue;
    const kind = lookup(name);
    if (kind !== undefined && (kind !== "local" || !ordered.has(name))) {
      throw new Error(`ir/from-ast: exact closure capture plan omitted binding "${name}" (${funcName})`);
    }
  }
  for (const name of orderedNames) {
    if (lookup(name) !== "local") {
      throw new Error(`ir/from-ast: exact closure capture "${name}" is not a local in scope (${funcName})`);
    }
  }
}

export function exactClosureLiftedName(prefix: string, ordinal: number, expected: string | undefined): string {
  const actual = `${prefix}__closure_${ordinal}`;
  if (expected !== undefined && expected !== actual) {
    throw new Error(`ir/from-ast: exact closure lift name ${actual} != planned ${expected} (${prefix})`);
  }
  return actual;
}
