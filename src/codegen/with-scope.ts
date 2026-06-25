// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static `with` statement lowering (#1387).
 *
 * This slice implements the Tier-1, closed-shape path for object literals:
 * the `with` target is compiled once into a local, the literal's own key set
 * is treated as closed, and bare identifier references that statically satisfy
 * Object Environment Record HasBinding are rewritten to direct struct
 * get/set. Unproven targets keep the #1387 diagnostic gate.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { reportError } from "./context/errors.js";
import { pushBody, popBody } from "./context/bodies.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureComputedPropertyFields, compileObjectLiteralForStruct } from "./literals.js";
import { ensureStructForType, resolveWasmType } from "./index.js";
import { resolveStructName } from "./property-access.js";
import { emitDynGet } from "./dyn-read.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { compileExpression, compileStatement, coerceType, valTypesMatch } from "./shared.js";

const OBJECT_PROTOTYPE_KEYS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

/**
 * (#2663 Slice 4) The HasBinding gate import for the dynamic `with` object
 * environment record. HOST mode uses `__with_has_binding`, which applies the
 * full ECMAScript §9.1.1.2.1 predicate: value-independent HasProperty filtered
 * by the receiver's @@unscopables blocklist (a `with`-routed name shadows the
 * outer binding only when HasBinding is true). Under `--target standalone`
 * there is no JS host, and the dynamic-`with` path already emits `__extern_has`
 * — which the #1472 standalone gate REFUSES (dynamic `with` is host-only). We
 * keep that exact name in standalone so the refusal is byte-identical to Slices
 * 1-3; `__with_has_binding` is NOT `__extern_*`-prefixed and so would NOT be
 * refused, which must never leak into a no-JS-host build.
 */
function withHasBindingImport(ctx: CodegenContext): string {
  return ctx.standalone ? "__extern_has" : "__with_has_binding";
}

/** A static (#1387 Tier-1) `with` scope entry. */
export type StaticWithScope = Extract<NonNullable<FunctionContext["withScopes"]>[number], { kind: "static" }>;

export interface WithBinding {
  scope: StaticWithScope;
  field: FieldDef;
  fieldIdx: number;
}

type WithTargetIntegrity = "plain" | "sealed" | "frozen";

interface WithTargetProof {
  ok: true;
  expr: ts.ObjectLiteralExpression;
  keys: Set<string>;
  integrity: WithTargetIntegrity;
}

/** A dynamic (#2663 Tier-2) `with` scope: arbitrary externref target resolved at
 *  runtime via HasBinding + Get. */
export type DynamicWithScope = Extract<NonNullable<FunctionContext["withScopes"]>[number], { kind: "dynamic" }>;

/** Result of resolving a bare identifier against the `with` scope stack. */
export type WithResolution =
  | { kind: "static"; binding: WithBinding }
  | { kind: "dynamic"; scope: DynamicWithScope }
  | null;

export function findWithBinding(fctx: FunctionContext, name: string): WithBinding | null {
  const res = resolveWithBinding(fctx, name);
  return res?.kind === "static" ? res.binding : null;
}

/**
 * (#2663 Slice 1) Resolve a bare identifier against the `with` scope stack,
 * innermost-first, across a MIXED static/dynamic stack.
 *
 * - A `static` scope hit returns the proven struct field binding (Tier-1
 *   zero-overhead path) — short-circuits the walk.
 * - A `dynamic` scope hit returns the scope for a runtime HasBinding-gated
 *   select (the absent case falls through to the next-outer scope / lexical at
 *   runtime, but statically we resolve to the innermost non-shadowing dynamic
 *   scope and let codegen emit the gate + fallback).
 * - `blockedNames` (body-declared lexical/inner-function names) shadow a scope
 *   for that name — skip it.
 */
export function resolveWithBinding(fctx: FunctionContext, name: string): WithResolution {
  const scopes = fctx.withScopes;
  if (!scopes || scopes.length === 0) return null;

  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (scope.blockedNames.has(name)) continue;
    if (scope.kind === "dynamic") {
      // Runtime HasBinding decides presence; resolve to this dynamic scope and
      // let codegen emit the gated select (present ⇒ object, absent ⇒ outer).
      return { kind: "dynamic", scope };
    }
    // static scope
    const fieldIdx = scope.fields.findIndex((f) => f.name === name);
    if (fieldIdx >= 0) {
      return { kind: "static", binding: { scope, field: scope.fields[fieldIdx]!, fieldIdx } };
    }
    if (OBJECT_PROTOTYPE_KEYS.has(name)) {
      return null;
    }
  }
  return null;
}

export function emitWithBindingGet(fctx: FunctionContext, binding: WithBinding): ValType {
  fctx.body.push({ op: "local.get", index: binding.scope.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: binding.scope.structTypeIdx, fieldIdx: binding.fieldIdx });
  return binding.field.type;
}

export function compileWithBindingAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  binding: WithBinding,
  rhs: ts.Expression,
): ValType | null {
  if (!binding.field.mutable) {
    reportError(
      ctx,
      rhs,
      `#1387: cannot assign through with binding "${binding.field.name}" because the field is immutable`,
    );
    return null;
  }

  const resultType = compileExpression(ctx, fctx, rhs, binding.field.type);
  if (!resultType) return null;
  if (!valTypesMatch(resultType, binding.field.type)) {
    coerceType(ctx, fctx, resultType, binding.field.type);
  }

  const tmp = allocTempLocal(fctx, binding.field.type);
  fctx.body.push({ op: "local.set", index: tmp });
  fctx.body.push({ op: "local.get", index: binding.scope.localIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "struct.set", typeIdx: binding.scope.structTypeIdx, fieldIdx: binding.fieldIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  releaseTempLocal(fctx, tmp);
  return binding.field.type;
}

export function compileWithStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.WithStatement): void {
  const proof = proveObjectLiteralWithTarget(fctx, stmt.expression);
  // (#2663 Slice 1) Tier-1 (static closed-shape) is the zero-overhead fast path;
  // any non-proven target — `with(variable)`, `with(fn())`, etc. — falls to the
  // Tier-2 dynamic-scope path (runtime HasBinding + Get) instead of being
  // rejected at compile time.
  if (!proof.ok || containsNestedFunctionBoundary(stmt.statement)) {
    compileDynamicWithStatement(ctx, fctx, stmt);
    return;
  }

  const targetType = compileClosedObjectLiteralTarget(ctx, fctx, proof.expr);
  if (!targetType || (targetType.kind !== "ref" && targetType.kind !== "ref_null")) {
    if (targetType) fctx.body.push({ op: "drop" });
    // Degenerate: proof said closed-literal but lowering didn't yield a struct.
    // The target was already (partially) compiled here, so re-routing to the
    // dynamic path would double-evaluate it — keep the diagnostic for this rare
    // internal case. (The common non-proven targets never reach here; they took
    // the Tier-2 path above before any target compilation.)
    reportWithStatementDiagnostic(ctx, stmt, "target did not lower to a WasmGC struct with a closed shape");
    return;
  }

  const structTypeIdx = targetType.typeIdx;
  const localIdx = allocLocal(fctx, `__with_scope_${fctx.locals.length}`, targetType);
  fctx.body.push({ op: "local.set", index: localIdx });

  const typeName = ctx.typeIdxToStructName.get(structTypeIdx);
  const fields = typeName ? ctx.structFields.get(typeName) : undefined;
  if (!fields) {
    reportWithStatementDiagnostic(ctx, stmt, "compiled target struct fields are unavailable");
    return;
  }

  const targetKeys = new Set(fields.map((f) => f.name));
  for (const key of proof.keys) {
    if (!targetKeys.has(key)) {
      reportWithStatementDiagnostic(ctx, stmt, `compiled target struct is missing literal key "${key}"`);
      return;
    }
  }

  const blockedNames = collectBodyDeclaredNames(stmt.statement);
  const referencedNames = collectBodyReferencedNames(stmt.statement);
  for (const name of referencedNames) {
    if (!blockedNames.has(name) && !proof.keys.has(name) && OBJECT_PROTOTYPE_KEYS.has(name)) {
      reportWithStatementDiagnostic(
        ctx,
        stmt,
        `body references inherited Object.prototype key "${name}", which this static slice cannot route as an own field`,
      );
      return;
    }
  }
  const scopeFields = proof.integrity === "frozen" ? fields.map((field) => ({ ...field, mutable: false })) : fields;
  const scope = { kind: "static" as const, localIdx, structTypeIdx, fields: scopeFields, blockedNames };
  (fctx.withScopes ??= []).push(scope);
  try {
    compileStatement(ctx, fctx, stmt.statement);
  } finally {
    fctx.withScopes?.pop();
  }
}

/**
 * (#2663 Slice 1) Tier-2 dynamic `with` lowering. The target is an arbitrary
 * value (variable / call / non-closed literal). ECMA-262 §14.11.7: evaluate the
 * target, `GetValue`, `ToObject` (throws TypeError on null/undefined), and run
 * the body with an Object Environment Record on the scope chain. Bare-identifier
 * reads inside the body are resolved at runtime via `emitDynamicWithGet`
 * (HasBinding gate + Get, falling back to the outer lowering when absent).
 *
 * Scope of THIS slice (READ only): writes/compound/inc-dec/`typeof`/`delete`
 * (Slices 2-3) still take their non-with lowering — they don't consult the
 * dynamic scope yet. `@@unscopables` (Slice 4) is not consulted; HasProperty is
 * treated as HasBinding. A body containing a nested function/class boundary is
 * rejected (the closure can't capture the object environment at runtime yet),
 * matching the Tier-1 boundary refusal.
 */
function compileDynamicWithStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.WithStatement): void {
  if (containsNestedFunctionBoundary(stmt.statement)) {
    reportWithStatementDiagnostic(
      ctx,
      stmt,
      "body contains a nested function or class that could capture the object environment (Tier-2 dynamic with: deferred)",
    );
    return;
  }

  // §14.11.7 step 1-3: evaluate the target and coerce to a uniform externref
  // receiver (struct ref / boxed any / host object all normalize to externref).
  const targetType = compileExpression(ctx, fctx, stmt.expression, { kind: "externref" });
  if (!targetType) {
    reportWithStatementDiagnostic(ctx, stmt, "dynamic with target did not compile");
    return;
  }
  if (targetType.kind !== "externref") {
    coerceType(ctx, fctx, targetType, { kind: "externref" });
  }
  const localIdx = allocLocal(fctx, `__with_dyn_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: localIdx });

  // §14.11.7: ToObject(undefined|null) throws TypeError. A JS `undefined`/`null`
  // is a NON-null externref wrapping the host sentinel, so `ref.is_null` alone is
  // insufficient — use `__extern_is_undefined` (host) which matches `v == null`.
  // Guard: if (__extern_is_undefined(recv)) throw TypeError.
  const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "call", funcIdx: isUndefIdx } as Instr);
    const savedGuard = pushBody(fctx);
    emitThrowTypeError(ctx, fctx, "Cannot convert undefined or null to object");
    const throwArm = fctx.body;
    popBody(fctx, savedGuard);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwArm } as Instr);
  }

  // Only body-declared LEXICAL names (let/const/class/catch) + inner-function
  // names genuinely shadow the object environment. `var`/function-scope names do
  // NOT — a `var` inside `with` hoists to the function env, but the object env is
  // consulted FIRST at runtime, so a `var foo` must still pass the HasBinding
  // gate (object wins if it owns `foo`; else the hoisted var). Using the lexical
  // set (not the full declared set) is what makes `with({foo:..}){ var foo=.. }`
  // write the OBJECT, while keeping the empty-object canary correct (gate misses
  // ⇒ falls to the hoisted var). (#2663 Slice 2 var-precedence refinement.)
  const blockedNames = collectBodyLexicalNames(stmt.statement);

  (fctx.withScopes ??= []).push({ kind: "dynamic", localIdx, blockedNames });
  try {
    compileStatement(ctx, fctx, stmt.statement);
  } finally {
    fctx.withScopes?.pop();
  }
}

/**
 * (#2663 Slice 1) Emit the HasBinding-gated READ select for a bare identifier
 * that resolved to a dynamic `with` scope (§9.1.1.2.1 HasBinding +
 * §9.1.1.2.5 GetBindingValue):
 *
 *   if (HasBinding(recv, name)) result = Get(recv, name) else result = <outer>
 *
 * Both arms normalize to `externref` (the `Get` half yields externref; the outer
 * fallback is coerced). `emitFallback` emits the name's normal (non-with)
 * lowering into the current body and returns its ValType (or null on error).
 *
 * Slice 1 treats HasProperty as HasBinding (no `@@unscopables` — Slice 4). The
 * gate uses the value-INDEPENDENT host `__extern_has` (NOT `__dyn_has`'s
 * non-null proxy): a property present with value `undefined` MUST still shadow
 * the outer binding (§7.3.12).
 */
export function emitDynamicWithGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
  emitFallback: () => ValType | null,
): ValType {
  // HasBinding gate: __extern_has(recv, "name") -> i32 (own+proto, value-indep).
  addStringConstantGlobal(ctx, name);
  const hasIdx = ensureLateImport(
    ctx,
    withHasBindingImport(ctx),
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  // THEN arm: Get(recv, name) -> externref (via the #2580 substrate emitDynGet).
  const savedThen = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  emitDynGet(ctx, fctx, name);
  const thenArm = fctx.body;
  popBody(fctx, savedThen);

  // ELSE arm: the name's normal (outer) lowering, normalized to externref.
  const savedElse = pushBody(fctx);
  const fbType = emitFallback();
  if (fbType && fbType.kind !== "externref") {
    coerceType(ctx, fctx, fbType, { kind: "externref" });
  }
  const elseArm = fctx.body;
  popBody(fctx, savedElse);

  if (hasIdx === undefined) {
    // Could not register the gate — fall back to the plain outer lowering
    // (already captured in elseArm); splice it inline so we don't lose it.
    fctx.body.push(...elseArm);
    return { kind: "externref" };
  }

  fctx.body.push({ op: "local.get", index: scope.localIdx });
  // Build the key externref + __extern_has call as the condition.
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: hasIdx } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } as ValType },
    then: thenArm,
    else: elseArm,
  } as Instr);
  return { kind: "externref" };
}

/**
 * (#2663 Slice 2) Emit the HasBinding-gated WRITE for `name = <value in
 * rhsLocalIdx>` where `name` resolved to a dynamic `with` scope (§9.1.1.2.4
 * SetMutableBinding), STATEMENT form (leaves nothing on the stack):
 *
 *   if (HasBinding(recv, name)) __extern_set(recv, name, rhsVal) else <fallback>
 *
 * The RHS is pre-evaluated ONCE by the caller into the externref temp
 * `rhsLocalIdx` (§13.15.2). `with` is sloppy-only, so the write uses
 * `__extern_set` (silent-on-failure, not the strict variant).
 * `emitFallbackWrite()` emits the next-outer write (another dynamic-with gate,
 * or the lexical write) using the same temp; it must leave nothing on the stack.
 */
/**
 * (#2663 Slice 2 / #2061 fix) Emit `__extern_has(recv, name) -> i32` into a fresh
 * i32 local, returning its index. §13.15.2: for a plain `=` assignment the LHS
 * Reference is resolved (→ HasBinding) BEFORE the RHS is evaluated. So the caller
 * captures each candidate dynamic-with scope's HasBinding with this helper BEFORE
 * compiling the RHS; the gated write then branches on the captured i32.
 *
 * (Computing HasBinding AFTER the RHS — as the original Slice 2 did — let an RHS
 * that adds the property to the with-object change the binding decision and
 * mis-route the write: regressed test262 `S11.13.1_A6_T3` — "PutValue uses the
 * initially-created Reference even if a more local binding is available".)
 */
export function emitCaptureWithHasBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
): number {
  addStringConstantGlobal(ctx, name);
  const hasIdx = ensureLateImport(
    ctx,
    withHasBindingImport(ctx),
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  const hasLocal = allocLocal(fctx, `__with_has_${fctx.locals.length}`, { kind: "i32" });
  if (hasIdx === undefined) {
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: hasLocal });
    return hasLocal;
  }
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: hasIdx } as Instr);
  fctx.body.push({ op: "local.set", index: hasLocal });
  return hasLocal;
}

/**
 * (#2663 Slice 2) Emit the WRITE for `name = <value in rhsLocalIdx>` gated on a
 * PRE-CAPTURED HasBinding i32 (`hasLocalIdx`, from `emitCaptureWithHasBinding`,
 * evaluated BEFORE the RHS per §13.15.2). Statement form (leaves nothing on the
 * stack): `if (hasLocal) __extern_set(recv,name,rhs) else <fallback>`. `with` is
 * sloppy-only ⇒ `__extern_set` (silent-on-failure).
 */
export function emitDynamicWithSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
  rhsLocalIdx: number,
  hasLocalIdx: number,
  emitFallbackWrite: () => void,
): void {
  addStringConstantGlobal(ctx, name);
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);

  // ELSE arm: the next-outer write (cascade), using the pre-computed RHS.
  const savedElse = pushBody(fctx);
  emitFallbackWrite();
  const elseArm = fctx.body;
  popBody(fctx, savedElse);

  if (setIdx === undefined) {
    // Setter unavailable — perform the fallback write only.
    fctx.body.push(...elseArm);
    return;
  }

  // THEN arm: __extern_set(recv, "name", rhsVal) → writes the object binding.
  const savedThen = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "local.get", index: rhsLocalIdx });
  fctx.body.push({ op: "call", funcIdx: setIdx } as Instr);
  const thenArm = fctx.body;
  popBody(fctx, savedThen);

  // Branch on the PRE-CAPTURED HasBinding (resolved before the RHS, §13.15.2).
  fctx.body.push({ op: "local.get", index: hasLocalIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenArm,
    else: elseArm,
  } as Instr);
}

/**
 * (#2663 Slice 3) Emit `delete name` where `name` resolved to a dynamic `with`
 * scope, leaving an i32 result on the stack (§13.5.1.2 / §8.5.2 DeleteBinding):
 *
 *   if (HasBinding(recv, name)) result = __delete_property(recv, name)
 *   else result = <outer delete>   // a bare variable is not deletable ⇒ 0,
 *                                  // unless an outer with also binds it (cascade)
 *
 * `emitOuterDelete()` emits the next-outer `delete name` result as i32 (another
 * dynamic-with gate, or the plain "variables not deletable" `i32.const 0`).
 */
export function emitDynamicWithDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
  emitOuterDelete: () => void,
): ValType {
  addStringConstantGlobal(ctx, name);
  const hasIdx = ensureLateImport(
    ctx,
    withHasBindingImport(ctx),
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  const delIdx = ensureLateImport(
    ctx,
    "__delete_property",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  // ELSE arm: the next-outer delete (cascade) → i32.
  const savedElse = pushBody(fctx);
  emitOuterDelete();
  const elseArm = fctx.body;
  popBody(fctx, savedElse);

  if (hasIdx === undefined || delIdx === undefined) {
    fctx.body.push(...elseArm);
    return { kind: "i32" };
  }

  // THEN arm: __delete_property(recv, name) → i32 (configurability-aware result).
  const savedThen = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: delIdx } as Instr);
  const thenArm = fctx.body;
  popBody(fctx, savedThen);

  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: hasIdx } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: thenArm,
    else: elseArm,
  } as Instr);
  return { kind: "i32" };
}

function compileClosedObjectLiteralTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  const tsType = ctx.checker.getTypeAtLocation(expr);
  let typeName = resolveStructName(ctx, tsType);
  if (!typeName) {
    ensureStructForType(ctx, tsType);
    typeName = resolveStructName(ctx, tsType);
  }
  if (!typeName) {
    typeName = registerClosedLiteralStruct(ctx, expr);
  }
  ensureComputedPropertyFields(ctx, fctx, expr, tsType);
  return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
}

function registerClosedLiteralStruct(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): string {
  const typeName = `__with_anon_${ctx.anonTypeCounter++}`;
  const fields: FieldDef[] = [];
  for (const prop of expr.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      fields.push({
        name: prop.name.text,
        type: resolveWasmType(ctx, ctx.checker.getTypeAtLocation(prop.name)),
        mutable: true,
      });
    } else if (ts.isPropertyAssignment(prop)) {
      const name = staticPropertyName(prop.name);
      if (name === undefined) continue;
      fields.push({
        name,
        type: resolveWasmType(ctx, ctx.checker.getTypeAtLocation(prop.initializer)),
        mutable: true,
      });
    }
  }
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: typeName, fields });
  ctx.structMap.set(typeName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, typeName);
  ctx.structFields.set(typeName, fields);
  return typeName;
}

function reportWithStatementDiagnostic(ctx: CodegenContext, stmt: ts.WithStatement, reason: string): void {
  reportError(
    ctx,
    stmt,
    `#1387: with statement requires a proven closed object-literal shape before codegen; ${reason}. ECMA-262 14.11.2 creates an Object Environment Record, 9.1.1.2.1 checks HasProperty plus @@unscopables, and 7.3.11 includes inherited properties. Dynamic fallback is deferred to #1472.`,
  );
}

function proveObjectLiteralWithTarget(
  fctx: FunctionContext,
  expr: ts.Expression,
): WithTargetProof | { ok: false; reason: string } {
  if (!ts.isObjectLiteralExpression(expr)) {
    const builtinIntegrity = unwrapBuiltinObjectIntegrityCall(fctx, expr);
    if (builtinIntegrity) {
      const proof = proveObjectLiteralWithTarget(fctx, builtinIntegrity.expr);
      if (!proof.ok) return proof;
      return { ...proof, integrity: builtinIntegrity.integrity };
    }
    return { ok: false, reason: `target ${ts.SyntaxKind[expr.kind]} is not a closed object literal` };
  }

  const keys = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      return { ok: false, reason: "object literal contains a spread, so the complete key set is not local" };
    }
    if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      return { ok: false, reason: "object literal contains accessors, which require dynamic property semantics" };
    }
    if (ts.isMethodDeclaration(prop)) {
      return { ok: false, reason: "object literal contains a method; method-value routing is deferred" };
    }
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
      return { ok: false, reason: "object literal property kind is not in the static slice" };
    }

    const name = ts.isShorthandPropertyAssignment(prop) ? prop.name.text : staticPropertyName(prop.name);
    if (name === undefined) {
      return { ok: false, reason: "object literal contains a dynamic computed property key" };
    }
    if (keys.has(name)) {
      return {
        ok: false,
        reason: `object literal contains duplicate key "${name}", which this static slice does not fold`,
      };
    }
    if (name === "@@unscopables") {
      return { ok: false, reason: "static @@unscopables filtering is deferred for this slice" };
    }
    if (name === "__proto__") {
      return { ok: false, reason: "object literal may alter the prototype through __proto__" };
    }
    keys.add(name);
  }
  return { ok: true, expr, keys, integrity: "plain" };
}

function unwrapBuiltinObjectIntegrityCall(
  fctx: FunctionContext,
  expr: ts.Expression,
): { expr: ts.Expression; integrity: Exclude<WithTargetIntegrity, "plain"> } | null {
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 1) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "Object") return null;
  if (fctx.localMap.has("Object")) return null;
  if (callee.name.text === "freeze") return { expr: expr.arguments[0]!, integrity: "frozen" };
  if (callee.name.text === "seal") return { expr: expr.arguments[0]!, integrity: "sealed" };
  return null;
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return String(Number(expr.text));
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "Symbol" &&
      expr.name.text === "unscopables"
    ) {
      return "@@unscopables";
    }
  }
  return undefined;
}

function containsNestedFunctionBoundary(stmt: ts.Statement): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (node !== stmt && isFunctionOrClassBoundary(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return found;
}

function collectBodyDeclaredNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, names);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text);
      return;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

/** True if a VariableDeclaration is `let`/`const` (block-scoped), not `var`. */
function isLexicalVarDecl(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  if (list && ts.isVariableDeclarationList(list)) {
    // NodeFlags.Let (0x1) | NodeFlags.Const (0x2) — `var` has neither.
    return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
  }
  return false;
}

/**
 * (#2663 Slice 2 var-precedence) Names that GENUINELY shadow a dynamic `with`
 * object binding: lexical declarations (`let`/`const`/class/catch) and
 * inner-function declarations. `var`-declared (function-scoped) names are
 * deliberately EXCLUDED — per §, a `var` inside `with` hoists to the function
 * environment but the object environment is consulted FIRST at runtime, so a
 * `var foo` name must still pass through the HasBinding gate (object wins if the
 * with-object owns `foo`; otherwise it resolves to the hoisted var). Used as the
 * dynamic scope's `blockedNames` so the gate is not bypassed for `var` names.
 */
function collectBodyLexicalNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isVariableDeclaration(node)) {
      if (isLexicalVarDecl(node)) collectBindingNames(node.name, names);
      return; // `var` declarations are NOT blocked (object env consulted first)
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text);
      return;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

function collectBodyReferencedNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      names.add(node.text);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, out);
  }
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

function isFunctionOrClassBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}
