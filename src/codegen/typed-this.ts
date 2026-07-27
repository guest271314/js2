/**
 * #3683 S2 — typed-`this` monomorphization for fnctor prototype methods.
 *
 * ## What this is
 *
 * A fnctor prototype method (`Parser.prototype.readToken = function () {…}` /
 * the aliased `pp.readToken = …` acorn writes) is lifted to a generic closure
 * whose `this` is the DYNAMIC `__current_this` externref global. Every
 * `this.pos` read in that body therefore costs a `__get_member_pos` dispatcher
 * call (a `ref.test`/`ref.cast` ladder over the whole struct table) plus a
 * box-to-externref inside the dispatcher and an unbox back to f64 at the call
 * site (`tryEmitPinnedStructMemberGet`'s `finishPinnedRead`). #3673 measured
 * that residue as the dominant remaining cost of the compiled-acorn parse.
 *
 * S2 compiles an admitted method's body a SECOND time as a **typed twin**: one
 * `ref.cast` of `__current_this` down to `$__fnctor_F` in the prologue, parked
 * in a local, after which `this.<field>` lowers to a bare
 * `struct.get`/`struct.set` returning the field's own ValType. The GENERIC body
 * keeps its dynamic lowering and gains a 4-instruction prepend —
 * `global.get __current_this; any.convert_extern; ref.test $__fnctor_F; if →
 * forward all params to the twin and return` — so detached receivers, patched
 * prototypes and foreign shapes still take the original path unchanged.
 *
 * ## Why the inline branches are semantically equivalent (the load-bearing part)
 *
 * The typed branches only ever fire where the receiver is `this` inside a twin,
 * i.e. exactly where today's lowering is the PINNED dispatcher path
 * (`tryEmitPinnedStructMemberGet` / `tryEmitPinnedStructMemberSet`, keyed off
 * `fctx.thisStructName`). They are that path's `$__fnctor_F` arm inlined:
 *
 *   - `fillMemberGetDispatch` emits, per candidate struct, `ref.test $C → (
 *     ref.cast $C; struct.get $C f; box→externref )`. Our receiver was
 *     `ref.cast $__fnctor_F`-verified at twin entry, so the arm the dispatcher
 *     would select is `$__fnctor_F`'s own — or that of a super/subtype in the
 *     same WasmGC chain, whose shared field PREFIX puts the same-named field at
 *     the same index with the same value. Either way the loaded bits are equal.
 *   - The caller then immediately unboxes back with
 *     `coerceType(externref → pinnedFieldType)`. Inlining collapses
 *     box∘unbox to the identity and hands downstream lowering the unboxed type.
 *   - `fillMemberSetDispatch` is the mirror image (`ref.cast`, coerce
 *     externref→field, `struct.set`), with the same argument.
 *
 * Three carve-outs preserve the remaining dispatcher semantics, so anything the
 * inline form could NOT reproduce declines and keeps the dispatcher call:
 *
 *   1. **presence-tracked fields** (`$has_<name>` companion): the dispatcher's
 *      read arm consults the presence bit and answers `undefined` when unset,
 *      and its write arm sets the bit. A bare `struct.get` cannot express that.
 *   2. **accessor properties** on the same struct: accessor arms run BEFORE the
 *      field arms in the dispatcher, so a getter must keep winning.
 *   3. **reserved names** (`length`/`constructor`/`__proto__`/`prototype`/
 *      `name`) and **call-signature-typed accesses**, which the pinned path
 *      itself refuses — a method read keeps its closure/funcref lowering.
 *
 * ### On `moduleUsesDelete`
 *
 * The S2 scoping note listed `!moduleUsesDelete` as an admission gate on
 * tombstone grounds. That gate is **not** what makes the inline branches safe,
 * and applying it would make S2 a measured no-op: acorn contains
 * `delete node.operator` and `delete this.undefinedExports[name]`, so the flag
 * is TRUE for the entire benchmark target. The tombstone-aware read
 * (`tryEmitDeleteAwareDynamicGet`) is a JS-HOST lowering that runs *after* the
 * pinned branch in `tryPinnedAndDeleteAwareDynamicGet` — a pinned `this`
 * receiver never reaches it today. What actually protects a deleted slot is
 * (a) the presence-bit carve-out above and (b) the standalone struct-delete
 * lowering, which WRITES a delete sentinel into the field itself
 * (`typeof-delete.ts` `clearField`), so a plain `struct.get` observes the
 * deletion exactly as the dispatcher's arm does. The gate is therefore replaced
 * by the equivalence conditions it was standing in for.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import { resolveEnclosingFnctorOwner } from "./fnctor-escape-gate.js";
import { allocLocal } from "./context/locals.js";
// `shared.js` holds the late-bound delegates precisely so a feature module can
// reach the expression/coercion engines without a cycle back through
// expressions.ts / index.ts.
import { coerceType, compileExpression } from "./shared.js";

/**
 * Property names whose reads/writes have dedicated lowerings (array length,
 * proto walk, constructor identity, function name). Mirrors the identical
 * carve-out in `tryEmitPinnedStructMemberGet` / `tryEmitPinnedStructMemberSet`
 * so the typed branch never claims a read the pinned path would have refused.
 */
const RESERVED_PROPS = new Set(["length", "constructor", "__proto__", "prototype", "name"]);

/** Env kill-switch: `JS2WASM_TYPED_THIS=0` disables twin emission entirely. */
function typedThisEnabled(): boolean {
  return process.env.JS2WASM_TYPED_THIS !== "0";
}

/**
 * `JS2WASM_TYPED_THIS_DEBUG=1` — per-compile tallies of what the S2 gates
 * actually did, printed at process exit. The measurable win depends entirely on
 * how many HOT `this.<field>` sites end up inlined (a twin whose every field is
 * presence-tracked buys nothing), so this counter is the primary instrument for
 * tuning the admission set. Inert unless the env var is set.
 */
export const typedThisStats = {
  twins: 0,
  declinedTwin: 0,
  inlineGet: 0,
  inlineSet: 0,
  inlineCompound: 0,
  inlineIncDec: 0,
  declinedField: new Map<string, number>(),
};
let statsHookInstalled = false;
function noteStats(): void {
  if (statsHookInstalled || process.env.JS2WASM_TYPED_THIS_DEBUG !== "1") return;
  statsHookInstalled = true;
  process.on("exit", () => {
    const top = [...typedThisStats.declinedField.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    process.stderr.write(
      `[typed-this] twins=${typedThisStats.twins} declinedTwin=${typedThisStats.declinedTwin} ` +
        `get=${typedThisStats.inlineGet} set=${typedThisStats.inlineSet} ` +
        `compound=${typedThisStats.inlineCompound} incdec=${typedThisStats.inlineIncDec}\n` +
        `[typed-this] declined fields: ${top.map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
    );
  });
}
function noteDeclinedField(reason: string): void {
  if (process.env.JS2WASM_TYPED_THIS_DEBUG !== "1") return;
  noteStats();
  typedThisStats.declinedField.set(reason, (typedThisStats.declinedField.get(reason) ?? 0) + 1);
}

/**
 * A second compilation of the same AST must not re-mint per-node artifacts. A
 * nested function-like would get a FRESH lifted closure / callback (a second
 * `__closure_N`, a second construction site) on the twin pass, so bodies
 * containing one are refused outright. `with` is refused for the same reason
 * its scope machinery is stateful.
 */
function bodyHasNestedFunctionLikeOrWith(body: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isClassLike(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isWithStatement(n)
    ) {
      found = true;
      return;
    }
    forEachChild(n, walk);
  };
  forEachChild(body, walk);
  return found;
}

/**
 * Memoized `FunctionLikeDeclaration → owning fnctor NAME` view of the S1
 * write-once verdicts (`analyzeProtoMethodWriteOnce`), so admission is an O(1)
 * node lookup instead of a scan over every class's method map per closure.
 */
function writeOnceOwnerOf(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): string | undefined {
  let index = ctx.typedThisWriteOnceIndex;
  if (index === undefined) {
    index = new Map<ts.FunctionLikeDeclaration, string>();
    for (const [className, methods] of ctx.fnctorEscapeGate?.protoMethodWriteOnce.methods ?? []) {
      for (const [, rhs] of methods) index.set(rhs, className);
    }
    ctx.typedThisWriteOnceIndex = index;
  }
  return index.get(fn);
}

/**
 * (#3683 S2) Decide whether a lifted prototype method gets a typed twin.
 *
 * Every clause is a hard requirement, and each failure mode is "miss a
 * monomorphization candidate", never "wrong lowering":
 *
 *  - `ctx.standalone` — the twin's win is the unboxed native field lane, which
 *    only exists in the host-free representation.
 *  - S1 write-once verdict for THIS arrow node, under the SAME fnctor the
 *    `this`-struct pin resolved to (a method slot that can be reassigned could
 *    later hold a body that never saw this struct).
 *  - the fnctor struct is registered in `ctx.structMap` (the twin's prologue
 *    needs a real type index — unlike the pin, which may resolve before the
 *    `new F()` site registers the struct).
 *  - zero captures, no self-recursive binding, not a named function expression:
 *    the twin's `__self` param is never read, and re-minting capture cells /
 *    self bindings on a second pass is not idempotent.
 *  - not async / not a generator: both own the body emission through separate
 *    state-machine lanes.
 *  - a plain block body with no nested function-like (see above).
 */
export function admitTypedThisTwin(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  opts: {
    thisStructName: string | undefined;
    captureCount: number;
    selfBindingName: string | undefined;
    isGenerator: boolean;
    isAsync: boolean;
    isNamedFuncExpr: boolean;
  },
): { structName: string; structTypeIdx: number } | undefined {
  noteStats();
  if (!typedThisEnabled()) return undefined;
  if (!ctx.standalone) return undefined;
  const { thisStructName } = opts;
  if (thisStructName === undefined) return undefined;
  if (opts.captureCount !== 0) return undefined;
  if (opts.selfBindingName !== undefined) return undefined;
  if (opts.isGenerator || opts.isAsync || opts.isNamedFuncExpr) return undefined;
  if (!ts.isFunctionExpression(arrow)) return undefined;
  if (!arrow.body || !ts.isBlock(arrow.body)) return undefined;

  const structTypeIdx = ctx.structMap.get(thisStructName);
  if (structTypeIdx === undefined) return undefined;

  // The write-once verdict must be for the SAME class the `this` pin resolved
  // to. `resolveLiftedMethodThisStruct` already required a prototype (not
  // static) method of an approved fnctor; re-derive the owner name to compare.
  const owner = resolveEnclosingFnctorOwner(ctx.checker, arrow);
  if (!owner || !owner.viaPrototype) return undefined;
  if (`__fnctor_${owner.name}` !== thisStructName) return undefined;
  if (writeOnceOwnerOf(ctx, arrow) !== owner.name) return undefined;
  if (ctx.fnctorEscapeGate?.protoMethodWriteOnce.poisoned.has(owner.name)) return undefined;

  if (bodyHasNestedFunctionLikeOrWith(arrow.body)) {
    typedThisStats.declinedTwin++;
    return undefined;
  }

  typedThisStats.twins++;
  return { structName: thisStructName, structTypeIdx };
}

/**
 * (#3683 S2) Twin prologue: `__current_this` → `any.convert_extern` →
 * `ref.cast $__fnctor_F` → a non-nullable typed local. The generic body's
 * `ref.test` shim is what makes the cast infallible, so no null guard is
 * emitted here.
 */
export function emitTypedThisPrologue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structName: string,
  structTypeIdx: number,
  allocLocalFn: (fctx: FunctionContext, name: string, type: ValType) => number,
  currentThisGlobalIdx: number,
): void {
  const localIdx = allocLocalFn(fctx, "__typed_this", { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "global.get", index: currentThisGlobalIdx });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: localIdx });
  fctx.typedThisStructIdx = structTypeIdx;
  fctx.typedThisStructName = structName;
  fctx.typedThisLocalIdx = localIdx;
  void ctx;
}

/**
 * (#3683 S2) The guard prepended to the GENERIC lifted body:
 *
 *     global.get __current_this
 *     any.convert_extern
 *     ref.test $__fnctor_F
 *     if
 *       local.get 0 … local.get n   ;; __self + every declared param, verbatim
 *       call $twin
 *       return
 *     end
 *
 * Placed as the very FIRST instructions, before param defaults / destructuring
 * / the `arguments` vec, so a hit re-derives all of them inside the twin from
 * the untouched raw params (and the untouched `__argc` / `__extras_argv`
 * globals, which a plain `call` does not disturb).
 */
export function buildTypedThisForwardGuard(
  structTypeIdx: number,
  currentThisGlobalIdx: number,
  paramCount: number,
  twinFuncIdx: number,
): Instr[] {
  const forward: Instr[] = [];
  for (let i = 0; i < paramCount; i++) forward.push({ op: "local.get", index: i });
  // `return_call`, not `call; return`: the twin shares the generic body's
  // wasm signature exactly (same params, same results), so the tail call is
  // well-typed and the shim costs no extra frame. The guard sits at function
  // ENTRY, outside any `try`, so the tail-call restriction on handler scopes
  // cannot apply.
  forward.push({ op: "return_call", funcIdx: twinFuncIdx });
  return [
    { op: "global.get", index: currentThisGlobalIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: structTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: forward, else: [] },
  ];
}

/** A resolved plain field of the twin's `this` struct. */
export interface TypedThisField {
  structTypeIdx: number;
  structName: string;
  localIdx: number;
  fieldIdx: number;
  fieldType: ValType;
  mutable: boolean;
}

/**
 * (#3683 S2) Resolve `<receiver>.<propName>` to a PLAIN field of the twin's
 * `this` struct, or `undefined` to decline (every decline keeps the existing
 * dispatcher lowering). See the module header for why each carve-out exists.
 */
export function resolveTypedThisField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  propName: string,
): TypedThisField | undefined {
  const structTypeIdx = fctx.typedThisStructIdx;
  const structName = fctx.typedThisStructName;
  const localIdx = fctx.typedThisLocalIdx;
  if (structTypeIdx === undefined || structName === undefined || localIdx === undefined) return undefined;
  // `JS2WASM_TYPED_THIS=shim` — emit the twins + the `ref.test` forward shim but
  // NONE of the inline field lowerings. The A/B against a full build isolates
  // the shim's per-call overhead from the inline branches' win, which is the
  // only way to tell "the branches don't pay" from "the shim eats the win".
  if (process.env.JS2WASM_TYPED_THIS === "shim") return undefined;
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  if (RESERVED_PROPS.has(propName)) {
    noteDeclinedField(`reserved:${propName}`);
    return undefined;
  }
  // Carve-out 2: an accessor on this struct must keep winning over the slot.
  if (ctx.classAccessorSet.has(`${structName}_${propName}`)) {
    noteDeclinedField(`accessor:${propName}`);
    return undefined;
  }
  const fields = ctx.structFields.get(structName);
  if (!fields) return undefined;
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx < 0) {
    noteDeclinedField(`nofield:${propName}`);
    return undefined;
  }
  const field = fields[fieldIdx]!;
  // Carve-out 1: presence-tracked ⇒ the dispatcher's presence check is
  // semantic (absent ⇒ `undefined`), which a bare struct.get cannot express.
  if (field.presenceTracked) {
    noteDeclinedField(`presence:${propName}`);
    return undefined;
  }
  return { structTypeIdx, structName, localIdx, fieldIdx, fieldType: field.type, mutable: field.mutable };
}

/**
 * (#3683 S2 branch a) `this.X` READ inside a twin → `local.get $typed_this;
 * struct.get $__fnctor_F X`. Returns the FIELD's ValType (an `f64` field stays
 * an unboxed f64, an `externref` field stays an externref) — which is what
 * lets the rest of the expression lowering stay numeric instead of routing
 * through `__unbox_number`.
 */
export function tryEmitTypedThisFieldGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  const f = resolveTypedThisField(ctx, fctx, expr.expression, propName);
  if (!f) return undefined;
  // Mirror the pinned path: a method/function-typed access keeps its
  // closure/funcref lowering (S3 devirtualizes those; S2 must not box them).
  const accessType = ctx.checker.getTypeAtLocation(expr);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) {
    noteDeclinedField(`callsig:${propName}`);
    return undefined;
  }
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  typedThisStats.inlineGet++;
  noteDeclinedField(`ok:${propName}:${f.fieldType.kind}`);
  return f.fieldType;
}

/**
 * (#3683 S2, branches b/c) Resolve a WRITE-side typed-`this` field. Adds the
 * mutability requirement (an immutable field cannot take `struct.set` — a hard
 * validator error, which is exactly why `fillMemberSetDispatch` filters its
 * candidates the same way) and the method-typed carve-out.
 */
export function resolveTypedThisWritableField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
): TypedThisField | undefined {
  if (ts.isPrivateIdentifier(target.name)) return undefined;
  const f = resolveTypedThisField(ctx, fctx, target.expression, target.name.text);
  if (!f || !f.mutable) return undefined;
  const accessType = ctx.checker.getTypeAtLocation(target);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) return undefined;
  return f;
}

/**
 * (#3683 S2 branch b) `this.X = v` WRITE inside a twin → `local.get
 * $typed_this; <value>; coerce; struct.set`. Returns the RHS value's ValType
 * (§13.15.2 step 1.e: an assignment evaluates to `rval` as written, NOT to the
 * field-coerced value), or `undefined` to decline.
 *
 * `toBoolean` is injected rather than imported: `ensureI32Condition` lives in
 * `codegen/index.ts`, which transitively imports this module.
 */
export function tryEmitTypedThisFieldSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  toBoolean: (fctx: FunctionContext, t: ValType | null, ctx: CodegenContext) => void,
): ValType | undefined {
  const f = resolveTypedThisWritableField(ctx, fctx, target);
  if (f === undefined) return undefined;
  const propName = (target.name as ts.Identifier).text;
  // Reference before value (§13.15.2): the receiver is a materialized local, so
  // pushing it first is side-effect-free and gives `struct.set` its operand
  // order without a scratch slot for the ref.
  fctx.body.push({ op: "local.get", index: f.localIdx });
  let valType = compileExpression(ctx, fctx, value);
  if (valType === null) {
    fctx.body.push({ op: "ref.null.extern" });
    valType = { kind: "externref" };
  }
  if (ctx.booleanPropertyNames.has(propName)) {
    // #2847 parity with the pinned write: the whole-program property analysis
    // proves this slot is boolean, so normalize through ToBoolean and carry the
    // boolean BRAND (a bare `__box_number` would make `o.flag === true` false).
    toBoolean(fctx, valType, ctx);
    valType = { kind: "i32", boolean: true };
  }
  const valTmp = allocLocal(fctx, `__tt_val_${fctx.locals.length}`, valType);
  fctx.body.push({ op: "local.set", index: valTmp });
  fctx.body.push({ op: "local.get", index: valTmp });
  // Two DIFFERENT nominal struct types cannot be bridged directly; take the
  // same externref hop the dispatcher's write arm takes (value→externref at the
  // call site, externref→field inside the arm). Everything else is one
  // coercion-engine step.
  const bothRefs =
    (valType.kind === "ref" || valType.kind === "ref_null") &&
    (f.fieldType.kind === "ref" || f.fieldType.kind === "ref_null");
  if (bothRefs && (valType as { typeIdx: number }).typeIdx !== (f.fieldType as { typeIdx: number }).typeIdx) {
    coerceType(ctx, fctx, valType, { kind: "externref" });
    coerceType(ctx, fctx, { kind: "externref" }, f.fieldType);
  } else if (valType.kind !== f.fieldType.kind) {
    coerceType(ctx, fctx, valType, f.fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  fctx.body.push({ op: "local.get", index: valTmp });
  typedThisStats.inlineSet++;
  return valType;
}

/**
 * (#3683 S2) Exactly the operators `operator-assignment.ts`'s private `emitCompoundOp`
 * switch lowers. That switch has no `default`, so an unlisted operator is a
 * silent no-op that would strand its operands on the stack — only a caller
 * that pre-checks against this set may enter {@link tryEmitTypedThisCompound}.
 * Kept here, with its only consumer; MUST be updated in lockstep with the
 * switch.
 */
export const EMIT_COMPOUND_OP_HANDLES: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

/**
 * (#3683 S2 branch c1) `this.X op= v` inside a twin. Structurally identical to
 * the existing struct-ref "Path A" in `compilePropertyCompoundAssignmentExternref`
 * (read slot → coerce to f64 → RHS as f64 → op → coerce back → store → yield the
 * f64 result), with the receiver being the twin's typed local. A `this` receiver
 * never reaches Path A today (it compiles to externref via `__current_this`), so
 * it lands on Path B and pays `__get_member_<p>` + unbox + box + `__set_member_<p>`;
 * both are numeric under standalone, so the arithmetic semantics are unchanged.
 *
 * `emitOp` is injected because `emitCompoundOp` is private to
 * `operator-assignment.ts`; the caller MUST have pre-checked that the operator
 * is one `emitOp` actually lowers (its switch has no `default`, so an unlisted
 * operator would silently strand the read + RHS on the stack).
 */
export function tryEmitTypedThisCompound(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  emitOp: (ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind) => void,
): ValType | null | undefined {
  const f = resolveTypedThisWritableField(ctx, fctx, target);
  if (f === undefined) return undefined;
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, f.fieldType, { kind: "f64" });
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (rhsType === null) return null;
  if (rhsType.kind !== "f64") coerceType(ctx, fctx, rhsType, { kind: "f64" });
  emitOp(ctx, fctx, op);
  const resTmp = allocLocal(fctx, `__tt_cmpd_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: resTmp });
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, f.fieldType);
  fctx.body.push({ op: "struct.set", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  fctx.body.push({ op: "local.get", index: resTmp });
  typedThisStats.inlineCompound++;
  return { kind: "f64" };
}

/**
 * (#3683 S2 branch c2) `this.X++` / `--this.X` inside a twin. Acorn's
 * `this.pos++` is the hottest update site in the tokenizer; on the generic body
 * it costs `__get_member_pos` + unbox + `f64.add` + box + `__set_member_pos`.
 * Numeric semantics (and the prefix/postfix result choice) match the externref
 * read-modify-write it replaces, `emitExternrefMemberIncDec`.
 */
export function tryEmitTypedThisIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.PropertyAccessExpression,
  f64Op: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
): ValType | undefined {
  const f = resolveTypedThisWritableField(ctx, fctx, operand);
  if (f === undefined) return undefined;
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, f.fieldType, { kind: "f64" });
  const tmp = allocLocal(fctx, `__tt_incdec_${fctx.locals.length}`, { kind: "f64" });
  if (mode === "postfix") {
    // [ref, old] → stash old, compute new, store, yield old.
    fctx.body.push({ op: "local.tee", index: tmp });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: f64Op });
  } else {
    // [ref, old] → compute new, stash it, store, yield new.
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: f64Op });
    fctx.body.push({ op: "local.tee", index: tmp });
  }
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, f.fieldType);
  fctx.body.push({ op: "struct.set", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  typedThisStats.inlineIncDec++;
  return { kind: "f64" };
}
