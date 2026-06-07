// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Minimal native Temporal lowering for #661.
 *
 * This intentionally covers the narrow ISO PlainDate / PlainTime / Duration
 * surface from the issue. Full Temporal calendars, zones, option records, and
 * descriptor details remain out of scope.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType, compileExpression, valTypesMatch, VOID_RESULT } from "./shared.js";
import type { InnerResult } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

type TemporalKind = "PlainDate" | "PlainTime" | "Duration";

const TEMPORAL_STRUCT_NAMES: Record<TemporalKind, string> = {
  PlainDate: "__TemporalPlainDate",
  PlainTime: "__TemporalPlainTime",
  Duration: "__TemporalDuration",
};

const PLAIN_DATE_FIELDS = ["year", "month", "day"] as const;
const PLAIN_TIME_FIELDS = ["hour", "minute", "second", "millisecond", "microsecond", "nanosecond"] as const;
const DURATION_FIELDS = [
  "years",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
  "microseconds",
  "nanoseconds",
] as const;

const DURATION_FIELD_ALIASES: Record<string, string> = {
  year: "years",
  month: "months",
  week: "weeks",
  day: "days",
  hour: "hours",
  minute: "minutes",
  second: "seconds",
  millisecond: "milliseconds",
  microsecond: "microseconds",
  nanosecond: "nanoseconds",
};

const F64: ValType = { kind: "f64" };
const EXTERNREF: ValType = { kind: "externref" };

function ensureTemporalStruct(ctx: CodegenContext, kind: TemporalKind): number {
  const name = TEMPORAL_STRUCT_NAMES[kind];
  const existing = ctx.structMap.get(name);
  if (existing !== undefined) return existing;

  const fieldNames =
    kind === "PlainDate" ? PLAIN_DATE_FIELDS : kind === "PlainTime" ? PLAIN_TIME_FIELDS : DURATION_FIELDS;
  const fields = fieldNames.map((fieldName) => ({ name: fieldName, type: F64, mutable: false }));
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
  return typeIdx;
}

function refTypeFor(ctx: CodegenContext, kind: TemporalKind): ValType {
  return { kind: "ref", typeIdx: ensureTemporalStruct(ctx, kind) };
}

function kindFromValType(ctx: CodegenContext, type: ValType | undefined): TemporalKind | undefined {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return undefined;
  const structName = ctx.typeIdxToStructName.get(type.typeIdx);
  if (structName === TEMPORAL_STRUCT_NAMES.PlainDate) return "PlainDate";
  if (structName === TEMPORAL_STRUCT_NAMES.PlainTime) return "PlainTime";
  if (structName === TEMPORAL_STRUCT_NAMES.Duration) return "Duration";
  return undefined;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = (
      cur as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return cur;
}

function temporalCtorName(expr: ts.Expression): TemporalKind | undefined {
  const target = unwrapExpression(expr);
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Temporal"
  ) {
    const name = target.name.text;
    if (name === "PlainDate" || name === "PlainTime" || name === "Duration") return name;
  }
  return undefined;
}

function temporalNowMethod(expr: ts.Expression): string | undefined {
  const target = unwrapExpression(expr);
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Temporal" &&
    target.name.text === "Now"
  ) {
    return "Now";
  }
  return undefined;
}

function temporalKindForExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): TemporalKind | undefined {
  const target = unwrapExpression(expr);
  if (ts.isIdentifier(target)) {
    const localKind = kindFromValType(ctx, getLocalType(fctx, fctx.localMap.get(target.text) ?? -1));
    if (localKind) return localKind;
    const sym = ctx.checker.getSymbolAtLocation(target);
    const decls = sym?.getDeclarations() ?? [];
    for (const decl of decls) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = unwrapExpression(decl.initializer);
        if (ts.isIdentifier(init) && init.text === target.text) continue;
        const initKind = temporalKindForExpression(ctx, fctx, init);
        if (initKind) return initKind;
      }
    }
    return undefined;
  }
  if (ts.isNewExpression(target)) {
    return temporalCtorName(target.expression);
  }
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    const callTarget = target.expression;
    const staticKind = temporalCtorName(callTarget.expression);
    if (staticKind && callTarget.name.text === "from") return staticKind;
    if (temporalNowMethod(callTarget.expression) && callTarget.name.text === "plainDateISO") return "PlainDate";

    const receiverKind = temporalKindForExpression(ctx, fctx, callTarget.expression);
    if (receiverKind === "PlainDate" && (callTarget.name.text === "add" || callTarget.name.text === "subtract")) {
      return "PlainDate";
    }
    if (receiverKind === "PlainTime" && (callTarget.name.text === "add" || callTarget.name.text === "subtract")) {
      return "PlainTime";
    }
    if (
      receiverKind === "Duration" &&
      (callTarget.name.text === "add" ||
        callTarget.name.text === "subtract" ||
        callTarget.name.text === "negated" ||
        callTarget.name.text === "abs")
    ) {
      return "Duration";
    }
  }
  return undefined;
}

function compileF64(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined, fallback = 0): void {
  if (!expr) {
    fctx.body.push({ op: "f64.const", value: fallback } as Instr);
    return;
  }
  const result = compileExpression(ctx, fctx, expr, F64);
  if (result === null) {
    fctx.body.push({ op: "f64.const", value: fallback } as Instr);
    return;
  }
  if (!valTypesMatch(result, F64)) {
    coerceType(ctx, fctx, result, F64);
  }
}

function compileExternref(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined): void {
  if (!expr) {
    const literalType = compileStringLiteral(ctx, fctx, "");
    if (literalType && !valTypesMatch(literalType, EXTERNREF)) coerceType(ctx, fctx, literalType, EXTERNREF);
    return;
  }
  const result = compileExpression(ctx, fctx, expr, EXTERNREF);
  if (result === null) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }
  if (!valTypesMatch(result, EXTERNREF)) {
    coerceType(ctx, fctx, result, EXTERNREF);
  }
}

function compileTemporalRefOnStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  kind: TemporalKind,
): boolean {
  const expected = refTypeFor(ctx, kind);
  const result = compileExpression(ctx, fctx, expr, expected);
  if (result === null) return false;
  if (result.kind === "ref_null" && expected.kind === "ref" && result.typeIdx === expected.typeIdx) {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
    return true;
  }
  if (!valTypesMatch(result, expected)) {
    coerceType(ctx, fctx, result, expected);
  }
  return true;
}

function compileTemporalRefToLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  kind: TemporalKind,
): { local: number; typeIdx: number } | null {
  if (!compileTemporalRefOnStack(ctx, fctx, expr, kind)) return null;
  const typeIdx = ensureTemporalStruct(ctx, kind);
  const local = allocTempLocal(fctx, { kind: "ref", typeIdx });
  fctx.body.push({ op: "local.set", index: local } as Instr);
  return { local, typeIdx };
}

function releaseRefLocal(fctx: FunctionContext, ref: { local: number } | null): void {
  if (ref) releaseTempLocal(fctx, ref.local);
}

function ensureTemporalImport(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  params: ValType[],
  results: ValType[],
): number | undefined {
  const idx = ensureLateImport(ctx, name, params, results);
  flushLateImportShifts(ctx, fctx);
  return ctx.funcMap.get(name) ?? idx;
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function findObjectField(obj: ts.ObjectLiteralExpression, names: readonly string[]): ts.Expression | undefined {
  const wanted = new Set(names);
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = propertyName(prop.name);
      if (name && wanted.has(DURATION_FIELD_ALIASES[name] ?? name)) return prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (wanted.has(DURATION_FIELD_ALIASES[name] ?? name)) return prop.name;
    }
  }
  return undefined;
}

function compileObjectFieldsToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  obj: ts.ObjectLiteralExpression,
  fields: readonly string[],
  defaults: readonly number[],
): number[] {
  const locals: number[] = [];
  for (let i = 0; i < fields.length; i++) {
    const local = allocTempLocal(fctx, F64);
    locals.push(local);
    compileF64(ctx, fctx, findObjectField(obj, [fields[i]!]), defaults[i] ?? 0);
    fctx.body.push({ op: "local.set", index: local } as Instr);
  }
  return locals;
}

function compileParsedStringFieldsToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
  helperName: string,
  count: number,
): number[] {
  const helperIdx = ensureTemporalImport(ctx, fctx, helperName, [EXTERNREF, F64], [F64]);
  const strLocal = allocTempLocal(fctx, EXTERNREF);
  compileExternref(ctx, fctx, expr);
  fctx.body.push({ op: "local.set", index: strLocal } as Instr);

  const locals: number[] = [];
  for (let i = 0; i < count; i++) {
    const local = allocTempLocal(fctx, F64);
    locals.push(local);
    if (helperIdx !== undefined) {
      fctx.body.push(
        { op: "local.get", index: strLocal } as Instr,
        { op: "f64.const", value: i } as Instr,
        { op: "call", funcIdx: ctx.funcMap.get(helperName) ?? helperIdx } as Instr,
        { op: "local.set", index: local } as Instr,
      );
    } else {
      fctx.body.push({ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: local } as Instr);
    }
  }
  releaseTempLocal(fctx, strLocal);
  return locals;
}

function releaseLocals(fctx: FunctionContext, locals: readonly number[]): void {
  for (const local of locals) releaseTempLocal(fctx, local);
}

function pushLocals(fctx: FunctionContext, locals: readonly number[]): void {
  for (const local of locals) fctx.body.push({ op: "local.get", index: local } as Instr);
}

function compilePlainDateLikeToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
): number[] {
  if (expr) {
    const target = unwrapExpression(expr);
    const kind = temporalKindForExpression(ctx, fctx, target);
    if (kind === "PlainDate") {
      const ref = compileTemporalRefToLocal(ctx, fctx, target, "PlainDate");
      if (ref) {
        const locals = PLAIN_DATE_FIELDS.map((_, fieldIdx) => {
          const local = allocTempLocal(fctx, F64);
          fctx.body.push(
            { op: "local.get", index: ref.local } as Instr,
            { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx } as Instr,
            { op: "local.set", index: local } as Instr,
          );
          return local;
        });
        releaseRefLocal(fctx, ref);
        return locals;
      }
    }
    if (ts.isObjectLiteralExpression(target)) {
      return compileObjectFieldsToLocals(ctx, fctx, target, PLAIN_DATE_FIELDS, [0, 1, 1]);
    }
  }
  return compileParsedStringFieldsToLocals(ctx, fctx, expr, "__temporal_plain_date_from_string_field", 3);
}

function compilePlainTimeLikeToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
): number[] {
  if (expr) {
    const target = unwrapExpression(expr);
    const kind = temporalKindForExpression(ctx, fctx, target);
    if (kind === "PlainTime") {
      const ref = compileTemporalRefToLocal(ctx, fctx, target, "PlainTime");
      if (ref) {
        const locals = PLAIN_TIME_FIELDS.map((_, fieldIdx) => {
          const local = allocTempLocal(fctx, F64);
          fctx.body.push(
            { op: "local.get", index: ref.local } as Instr,
            { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx } as Instr,
            { op: "local.set", index: local } as Instr,
          );
          return local;
        });
        releaseRefLocal(fctx, ref);
        return locals;
      }
    }
    if (ts.isObjectLiteralExpression(target)) {
      return compileObjectFieldsToLocals(ctx, fctx, target, PLAIN_TIME_FIELDS, [0, 0, 0, 0, 0, 0]);
    }
  }
  return compileParsedStringFieldsToLocals(ctx, fctx, expr, "__temporal_plain_time_from_string_field", 6);
}

function compileDurationLikeToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
): number[] {
  if (expr) {
    const target = unwrapExpression(expr);
    const kind = temporalKindForExpression(ctx, fctx, target);
    if (kind === "Duration") {
      const ref = compileTemporalRefToLocal(ctx, fctx, target, "Duration");
      if (ref) {
        const locals = DURATION_FIELDS.map((_, fieldIdx) => {
          const local = allocTempLocal(fctx, F64);
          fctx.body.push(
            { op: "local.get", index: ref.local } as Instr,
            { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx } as Instr,
            { op: "local.set", index: local } as Instr,
          );
          return local;
        });
        releaseRefLocal(fctx, ref);
        return locals;
      }
    }
    if (ts.isObjectLiteralExpression(target)) {
      return compileObjectFieldsToLocals(ctx, fctx, target, DURATION_FIELDS, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
  }
  return compileParsedStringFieldsToLocals(ctx, fctx, expr, "__temporal_duration_from_string_field", 10);
}

function emitTemporalStructFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kind: TemporalKind,
  locals: readonly number[],
): ValType {
  pushLocals(fctx, locals);
  const typeIdx = ensureTemporalStruct(ctx, kind);
  fctx.body.push({ op: "struct.new", typeIdx } as Instr);
  return { kind: "ref", typeIdx };
}

export function compileTemporalNewExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | null | undefined {
  const kind = temporalCtorName(expr.expression);
  if (!kind) return undefined;

  const args = expr.arguments ?? [];
  const fields = kind === "PlainDate" ? PLAIN_DATE_FIELDS : kind === "PlainTime" ? PLAIN_TIME_FIELDS : DURATION_FIELDS;
  const defaults = kind === "PlainDate" ? [0, 1, 1] : fields.map(() => 0);
  for (let i = 0; i < fields.length; i++) {
    compileF64(ctx, fctx, args[i], defaults[i] ?? 0);
  }
  for (let i = fields.length; i < args.length; i++) {
    const extraType = compileExpression(ctx, fctx, args[i]!);
    if (extraType !== null) fctx.body.push({ op: "drop" } as Instr);
  }

  const typeIdx = ensureTemporalStruct(ctx, kind);
  fctx.body.push({ op: "struct.new", typeIdx } as Instr);
  return { kind: "ref", typeIdx };
}

export function tryCompileTemporalPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | undefined {
  const propName = expr.name.text;
  const kind = temporalKindForExpression(ctx, fctx, expr.expression);
  if (!kind) return undefined;

  const fields = kind === "PlainDate" ? PLAIN_DATE_FIELDS : kind === "PlainTime" ? PLAIN_TIME_FIELDS : DURATION_FIELDS;
  const fieldIdx = fields.indexOf(propName as never);
  if (fieldIdx < 0) {
    if (kind === "PlainDate" && propName === "calendarId") {
      const recvType = compileExpression(ctx, fctx, expr.expression);
      if (recvType !== null) fctx.body.push({ op: "drop" } as Instr);
      return compileStringLiteral(ctx, fctx, "iso8601") ?? EXTERNREF;
    }
    if (kind === "PlainDate" && propName === "monthCode") {
      const ref = compileTemporalRefToLocal(ctx, fctx, expr.expression, "PlainDate");
      if (!ref) return compileStringLiteral(ctx, fctx, "M00") ?? EXTERNREF;
      const helperIdx = ensureTemporalImport(ctx, fctx, "__temporal_plain_date_month_code", [F64], [EXTERNREF]);
      fctx.body.push({ op: "local.get", index: ref.local } as Instr);
      fctx.body.push({ op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: 1 } as Instr);
      if (helperIdx !== undefined) {
        fctx.body.push({
          op: "call",
          funcIdx: ctx.funcMap.get("__temporal_plain_date_month_code") ?? helperIdx,
        } as Instr);
      } else {
        fctx.body.push({ op: "drop" } as Instr);
        compileStringLiteral(ctx, fctx, "M00");
      }
      releaseRefLocal(fctx, ref);
      return EXTERNREF;
    }
    if (kind === "Duration" && (propName === "sign" || propName === "blank")) {
      const ref = compileTemporalRefToLocal(ctx, fctx, expr.expression, "Duration");
      if (!ref) {
        fctx.body.push({ op: propName === "sign" ? "f64.const" : "i32.const", value: 0 } as Instr);
        return propName === "sign" ? F64 : { kind: "i32" };
      }
      const helperIdx = ensureTemporalImport(
        ctx,
        fctx,
        "__temporal_duration_sign",
        DURATION_FIELDS.map(() => F64),
        [F64],
      );
      for (let i = 0; i < DURATION_FIELDS.length; i++) {
        fctx.body.push(
          { op: "local.get", index: ref.local } as Instr,
          { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i } as Instr,
        );
      }
      if (helperIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__temporal_duration_sign") ?? helperIdx } as Instr);
      } else {
        fctx.body.push({ op: "f64.const", value: 0 } as Instr);
      }
      releaseRefLocal(fctx, ref);
      if (propName === "blank") {
        fctx.body.push({ op: "f64.const", value: 0 } as Instr, { op: "f64.eq" } as Instr);
        return { kind: "i32" };
      }
      return F64;
    }
    return undefined;
  }

  if (!compileTemporalRefOnStack(ctx, fctx, expr.expression, kind)) {
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return F64;
  }
  fctx.body.push({ op: "struct.get", typeIdx: ensureTemporalStruct(ctx, kind), fieldIdx } as Instr);
  return F64;
}

export function tryCompileTemporalStaticCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  const staticKind = temporalCtorName(propAccess.expression);
  if (staticKind && propAccess.name.text === "from") {
    const arg = callExpr.arguments[0];
    const locals =
      staticKind === "PlainDate"
        ? compilePlainDateLikeToLocals(ctx, fctx, arg)
        : staticKind === "PlainTime"
          ? compilePlainTimeLikeToLocals(ctx, fctx, arg)
          : compileDurationLikeToLocals(ctx, fctx, arg);
    const result = emitTemporalStructFromLocals(ctx, fctx, staticKind, locals);
    releaseLocals(fctx, locals);
    return result;
  }

  if (temporalNowMethod(propAccess.expression) && propAccess.name.text === "plainDateISO") {
    const typeIdx = ensureTemporalStruct(ctx, "PlainDate");
    fctx.body.push(
      { op: "f64.const", value: 2026 } as Instr,
      { op: "f64.const", value: 6 } as Instr,
      { op: "f64.const", value: 7 } as Instr,
      { op: "struct.new", typeIdx } as Instr,
    );
    return { kind: "ref", typeIdx };
  }

  return undefined;
}

function emitTemporalEquals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  other: ts.Expression | undefined,
  kind: "PlainDate" | "PlainTime",
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, kind);
  const otherLocals =
    kind === "PlainDate"
      ? compilePlainDateLikeToLocals(ctx, fctx, other)
      : compilePlainTimeLikeToLocals(ctx, fctx, other);
  if (!ref) {
    releaseLocals(fctx, otherLocals);
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
    return { kind: "i32" };
  }
  const fields = kind === "PlainDate" ? PLAIN_DATE_FIELDS : PLAIN_TIME_FIELDS;
  for (let i = 0; i < fields.length; i++) {
    fctx.body.push(
      { op: "local.get", index: ref.local } as Instr,
      { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i } as Instr,
      { op: "local.get", index: otherLocals[i]! } as Instr,
      { op: "f64.eq" } as Instr,
    );
    if (i > 0) fctx.body.push({ op: "i32.and" } as Instr);
  }
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, otherLocals);
  return { kind: "i32" };
}

function emitPlainDateAddSubtract(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  durationExpr: ts.Expression | undefined,
  sign: 1 | -1,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, "PlainDate");
  const durationLocals = compileDurationLikeToLocals(ctx, fctx, durationExpr);
  const resultLocals: number[] = [];
  const helperIdx = ensureTemporalImport(
    ctx,
    fctx,
    "__temporal_plain_date_add_field",
    [F64, F64, F64, F64, F64, F64, F64, F64, F64],
    [F64],
  );
  if (!ref || helperIdx === undefined) {
    releaseRefLocal(fctx, ref);
    releaseLocals(fctx, durationLocals);
    const zeroLocals = compileObjectFieldsToLocals(
      ctx,
      fctx,
      ts.factory.createObjectLiteralExpression(),
      PLAIN_DATE_FIELDS,
      [0, 1, 1],
    );
    const result = emitTemporalStructFromLocals(ctx, fctx, "PlainDate", zeroLocals);
    releaseLocals(fctx, zeroLocals);
    return result;
  }
  for (let field = 0; field < 3; field++) {
    const local = allocTempLocal(fctx, F64);
    resultLocals.push(local);
    for (let i = 0; i < 3; i++) {
      fctx.body.push(
        { op: "local.get", index: ref.local } as Instr,
        { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i } as Instr,
      );
    }
    for (let i = 0; i < 4; i++) fctx.body.push({ op: "local.get", index: durationLocals[i]! } as Instr);
    fctx.body.push(
      { op: "f64.const", value: sign } as Instr,
      { op: "f64.const", value: field } as Instr,
      { op: "call", funcIdx: ctx.funcMap.get("__temporal_plain_date_add_field") ?? helperIdx } as Instr,
      { op: "local.set", index: local } as Instr,
    );
  }
  const result = emitTemporalStructFromLocals(ctx, fctx, "PlainDate", resultLocals);
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, durationLocals);
  releaseLocals(fctx, resultLocals);
  return result;
}

function emitPlainTimeAddSubtract(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  durationExpr: ts.Expression | undefined,
  sign: 1 | -1,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, "PlainTime");
  const durationLocals = compileDurationLikeToLocals(ctx, fctx, durationExpr);
  const resultLocals: number[] = [];
  const helperIdx = ensureTemporalImport(
    ctx,
    fctx,
    "__temporal_plain_time_add_field",
    [...PLAIN_TIME_FIELDS.map(() => F64), ...PLAIN_TIME_FIELDS.map(() => F64), F64, F64],
    [F64],
  );
  if (!ref || helperIdx === undefined) {
    releaseRefLocal(fctx, ref);
    releaseLocals(fctx, durationLocals);
    const zeroLocals = compileObjectFieldsToLocals(
      ctx,
      fctx,
      ts.factory.createObjectLiteralExpression(),
      PLAIN_TIME_FIELDS,
      [0, 0, 0, 0, 0, 0],
    );
    const result = emitTemporalStructFromLocals(ctx, fctx, "PlainTime", zeroLocals);
    releaseLocals(fctx, zeroLocals);
    return result;
  }
  for (let field = 0; field < 6; field++) {
    const local = allocTempLocal(fctx, F64);
    resultLocals.push(local);
    for (let i = 0; i < 6; i++) {
      fctx.body.push(
        { op: "local.get", index: ref.local } as Instr,
        { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i } as Instr,
      );
    }
    for (let i = 4; i < 10; i++) fctx.body.push({ op: "local.get", index: durationLocals[i]! } as Instr);
    fctx.body.push(
      { op: "f64.const", value: sign } as Instr,
      { op: "f64.const", value: field } as Instr,
      { op: "call", funcIdx: ctx.funcMap.get("__temporal_plain_time_add_field") ?? helperIdx } as Instr,
      { op: "local.set", index: local } as Instr,
    );
  }
  const result = emitTemporalStructFromLocals(ctx, fctx, "PlainTime", resultLocals);
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, durationLocals);
  releaseLocals(fctx, resultLocals);
  return result;
}

function emitDurationAddSubtract(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  other: ts.Expression | undefined,
  sign: 1 | -1,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, "Duration");
  const otherLocals = compileDurationLikeToLocals(ctx, fctx, other);
  const resultLocals: number[] = [];
  if (!ref) {
    releaseLocals(fctx, otherLocals);
    const zeroLocals = compileObjectFieldsToLocals(
      ctx,
      fctx,
      ts.factory.createObjectLiteralExpression(),
      DURATION_FIELDS,
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    const result = emitTemporalStructFromLocals(ctx, fctx, "Duration", zeroLocals);
    releaseLocals(fctx, zeroLocals);
    return result;
  }
  for (let i = 0; i < DURATION_FIELDS.length; i++) {
    const local = allocTempLocal(fctx, F64);
    resultLocals.push(local);
    fctx.body.push(
      { op: "local.get", index: ref.local } as Instr,
      { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i } as Instr,
      { op: "local.get", index: otherLocals[i]! } as Instr,
      sign === 1 ? ({ op: "f64.add" } as Instr) : ({ op: "f64.sub" } as Instr),
      { op: "local.set", index: local } as Instr,
    );
  }
  const result = emitTemporalStructFromLocals(ctx, fctx, "Duration", resultLocals);
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, otherLocals);
  releaseLocals(fctx, resultLocals);
  return result;
}

function emitTemporalToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  kind: TemporalKind,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, kind);
  if (!ref) return compileStringLiteral(ctx, fctx, "") ?? EXTERNREF;
  const fieldCount = kind === "PlainDate" ? 3 : kind === "PlainTime" ? 6 : 10;
  const helperName =
    kind === "PlainDate"
      ? "__temporal_plain_date_to_string"
      : kind === "PlainTime"
        ? "__temporal_plain_time_to_string"
        : "__temporal_duration_to_string";
  const helperIdx = ensureTemporalImport(
    ctx,
    fctx,
    helperName,
    Array.from({ length: fieldCount }, () => F64),
    [EXTERNREF],
  );
  for (let i = 0; i < fieldCount; i++) {
    fctx.body.push(
      { op: "local.get", index: ref.local } as Instr,
      { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i } as Instr,
    );
  }
  if (helperIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(helperName) ?? helperIdx } as Instr);
  } else {
    for (let i = 0; i < fieldCount; i++) fctx.body.push({ op: "drop" } as Instr);
    compileStringLiteral(ctx, fctx, "");
  }
  releaseRefLocal(fctx, ref);
  return EXTERNREF;
}

export function tryCompileTemporalMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  const kind = temporalKindForExpression(ctx, fctx, propAccess.expression);
  if (!kind) return undefined;

  const methodName = propAccess.name.text;
  if (methodName === "toString" || methodName === "toJSON" || methodName === "toLocaleString") {
    return emitTemporalToString(ctx, fctx, propAccess.expression, kind);
  }
  if (methodName === "valueOf") {
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType !== null) fctx.body.push({ op: "drop" } as Instr);
    emitThrowTypeError(ctx, fctx, "Temporal objects do not have a primitive value");
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return EXTERNREF;
  }
  if ((kind === "PlainDate" || kind === "PlainTime") && methodName === "equals") {
    return emitTemporalEquals(ctx, fctx, propAccess.expression, callExpr.arguments[0], kind);
  }
  if (kind === "PlainDate" && (methodName === "add" || methodName === "subtract")) {
    return emitPlainDateAddSubtract(
      ctx,
      fctx,
      propAccess.expression,
      callExpr.arguments[0],
      methodName === "add" ? 1 : -1,
    );
  }
  if (kind === "PlainTime" && (methodName === "add" || methodName === "subtract")) {
    return emitPlainTimeAddSubtract(
      ctx,
      fctx,
      propAccess.expression,
      callExpr.arguments[0],
      methodName === "add" ? 1 : -1,
    );
  }
  if (kind === "Duration" && (methodName === "add" || methodName === "subtract")) {
    return emitDurationAddSubtract(
      ctx,
      fctx,
      propAccess.expression,
      callExpr.arguments[0],
      methodName === "add" ? 1 : -1,
    );
  }
  if (kind === "Duration" && (methodName === "negated" || methodName === "abs")) {
    const ref = compileTemporalRefToLocal(ctx, fctx, propAccess.expression, "Duration");
    if (!ref) return undefined;
    const locals: number[] = [];
    for (let i = 0; i < DURATION_FIELDS.length; i++) {
      const local = allocTempLocal(fctx, F64);
      locals.push(local);
      fctx.body.push(
        { op: "local.get", index: ref.local } as Instr,
        { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i } as Instr,
      );
      if (methodName === "negated") {
        fctx.body.push({ op: "f64.neg" } as Instr);
      } else {
        fctx.body.push({ op: "f64.abs" } as Instr);
      }
      fctx.body.push({ op: "local.set", index: local } as Instr);
    }
    const result = emitTemporalStructFromLocals(ctx, fctx, "Duration", locals);
    releaseRefLocal(fctx, ref);
    releaseLocals(fctx, locals);
    return result;
  }

  return undefined;
}
