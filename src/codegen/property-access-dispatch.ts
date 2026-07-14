// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Property-access dispatch helpers (#3276, Wave B decomposition of #3182).
 *
 * `compilePropertyAccess` in property-access.ts is a ~3.3k-LOC function that
 * dispatches on access kind / receiver family through a long sequence of
 * independent early-return guard bands. This module hosts the extracted,
 * cohesively-named guard bands. Each helper contains a VERBATIM run of the
 * original inline guard blocks and returns {@link PA_FALLTHROUGH} where the
 * original fell through (guard false / inner attempt produced nothing); every
 * original `return X` inside a band is preserved unchanged.
 *
 * Byte-identity: the moved statements execute in the same order with the same
 * ctx/fctx mutations, so the emitted Wasm is unchanged (proved with
 * scripts/prove-emit-identity.mjs — 39/39 gc/standalone/wasi IDENTICAL).
 *
 * Call-site contract in compilePropertyAccess:
 *
 *   {
 *     const __r = tryFooBar(ctx, fctx, expr, propName, objType);
 *     if (__r !== PA_FALLTHROUGH) return __r;
 *   }
 */

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isExternalDeclaredClass } from "../checker/type-mapper.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import {
  classifyPrivateMember,
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  noJsHost,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
import { popBody, pushBody } from "./context/bodies.js";
import { classMemberFuncKey, resolveMethodOwnerClass } from "./class-member-keys.js";
import { definedFuncAt } from "./func-space.js";
import { emitCachedMethodClosureAccess, emitFuncRefAsClosure } from "./closures.js";
import { emitLazyProtoGet } from "./expressions/extern.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { addStringConstantGlobal, localGlobalIdx } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import {
  emitBuiltinConstructorIdentity,
  emitBuiltinNamespaceObject,
  isBuiltinConstructorIdentityName,
} from "./builtin-static-globals.js";
import { tryCompileNativeDisposableStackAnyDisposedGet } from "./disposable-runtime.js";
import { tryEmitFnctorPrototypeRead } from "./expressions/fnctor-prototype.js";
import {
  tryCompileStandaloneRegExpMatchResultRead,
  tryCompileStandaloneRegExpPropertyRead,
} from "./regexp-standalone.js";
import {
  emitGeneratorPrototypeSingleton,
  emitNativeGlobalThisObject,
  emitTypedArrayIntrinsicCtorObject,
} from "./array-object-proto.js";
import {
  dvDetachedThrowInstrs,
  emitTaCtorBytesPerElement,
  emitTaViewAccessor,
  emitTaViewDynamicByteLength,
  getOrRegisterDvWindowType,
} from "./dataview-native.js";
import { resolveWasmType, TYPED_ARRAY_NAMES, typedArrayVecStorage } from "./index.js";
import {
  getArrTypeIdxFromVec,
  getOrRegisterResizableAbType,
  getOrRegisterVecType,
  taCtorKindOf,
} from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStringLiteral,
  compileSuperPropertyAccess,
  ensureLateImport,
  flushLateImportShifts,
  skipTransparentExpressions,
} from "./shared.js";
import { tryEmitJsonParsePropertyAccess } from "./json-standalone.js";
import { resolveReceiverStruct } from "./fnctor-escape-gate.js";
import { tryCompileTemporalPropertyAccess } from "./temporal-native.js";
import {
  BUILTIN_CTOR_NAMES,
  ensureStandaloneBuiltinStaticMethodClosure,
  hasNativeBuiltinConstantHandler,
  reportUnsupportedStandaloneBuiltinValueRead,
  TYPED_ARRAY_BYTES_PER_ELEMENT,
  tryCompileStandaloneBuiltinProtoMemberMeta,
  tryCompileStandaloneBuiltinProtoMemberRead,
  tryEnsureNativeProtoBrand,
} from "./builtin-value-read.js";
import { isBuiltinSubtype, isBuiltinTypeName } from "./builtin-tags.js";
import { getOrRegisterErrorStructType, isWasiErrorName } from "./registry/error-types.js";
import {
  classifyPlainCtorReceiverNamespace,
  emitGetterCallWithDummy,
  isGetProtoOfWiredViewProtoCall,
  moduleTouchesConstructorProp,
  receiverIsCatchClauseBinding,
  resolveInheritedStaticProp,
  taViewReceiverTypeIdx,
  tryEmitConstructorViaTag,
  tryEmitDeleteAwareDynamicGet,
  tryEmitPinnedStructMemberGet,
} from "./property-access.js";

/**
 * Sentinel returned by every dispatch helper to mean "this guard band did not
 * handle the access — keep going". `compilePropertyAccess` returns
 * `ValType | null`, and `null` is itself a legitimate handled result, so it
 * cannot double as the not-handled marker; a unique symbol can.
 */
export const PA_FALLTHROUGH: unique symbol = Symbol("property-access:fallthrough");
export type PADispatchResult = ValType | null | typeof PA_FALLTHROUGH;

export function tryDynamicReceiverRuntimeDispatchReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#3054 D) `ctor.BYTES_PER_ELEMENT` where `ctor` is a first-class `$__ta_ctor`
  // value (the kind is only known at runtime — `for (c of ctors) … c.BYTES_PER_ELEMENT`,
  // `CreateRabForTest(ctor)`'s `4 * ctor.BYTES_PER_ELEMENT`). Placed at the TOP so
  // it wins over the generic dynamic-member dispatchers below (which return
  // `undefined`/0 for a `$__ta_ctor` receiver — a param/loop-var typed `any`).
  // Byte-inert: only when a `$__ta_ctor` type already exists in the module (it is
  // registered when a TA name is used as a value, e.g. the `ctors` array). Excludes
  // the static `Uint8Array.BYTES_PER_ELEMENT` NAME form (kept on its dedicated path)
  // and native TypedArray/DataView/ArrayBuffer INSTANCES (their own instance arm).
  if (
    propName === "BYTES_PER_ELEMENT" &&
    noJsHost(ctx) &&
    !(ts.isIdentifier(expr.expression) && taCtorKindOf(expr.expression.text) >= 0)
  ) {
    const recvSym = objType.getSymbol()?.name;
    const isNativeInstance =
      recvSym !== undefined &&
      (taCtorKindOf(recvSym) >= 0 || recvSym === "DataView" || recvSym === "ArrayBuffer" || recvSym === "TypedArray");
    // A `$__ta_ctor` value only ever flows through an `any`/`unknown`/union-typed
    // receiver (a concrete TA / native instance never holds one). Gate on that so
    // non-dynamic reads stay byte-inert, and register the ctor type on demand (the
    // read may compile before the value that would register it).
    const isDynamicReceiver =
      (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || objType.isUnion() || ctx.taCtorTypeIdx >= 0;
    if (!isNativeInstance && isDynamicReceiver) {
      const r = emitTaCtorBytesPerElement(ctx, fctx, () => compileExpression(ctx, fctx, expr.expression));
      if (r) return r;
    }
  }

  // (#3054 D) `.byteLength` on a boxed `$__ta_view` read back through an `any`/union
  // receiver (a dynamically-constructed view stored in an `any[]`, e.g.
  // length-tracking-N's `for (ta of tas) … ta.byteLength`). The compile-time-typeIdx
  // `$__ta_view` accessor arm can't fire (the local is externref), and the generic
  // dynamic reader THROWS on `.byteLength`. Runtime `ref.test` dispatch instead.
  // Gated to a dynamic receiver + at least one registered `$__ta_view` type
  // (byte-inert otherwise); a static ArrayBuffer/DataView/TA `.byteLength` keeps its
  // own concrete arm below (its receiver type is not `any`/union).
  if (propName === "byteLength" && noJsHost(ctx) && ctx.taDynViewTypeIdx >= 0) {
    const isDynamicReceiver = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || objType.isUnion();
    if (isDynamicReceiver) {
      const r = emitTaViewDynamicByteLength(ctx, fctx, () => compileExpression(ctx, fctx, expr.expression));
      if (r) return r;
    }
  }

  // (#3237 Slice 1) `.disposed` on a DYNAMIC (`any`/`unknown`/union) receiver
  // carrying a native `$DisposableStack` (the runner hoists a captured
  // `var stack = new DisposableStack()` to `let stack: any`). The className arm
  // below can't fire (no nominal symbol), so it fell to the generic dynamic
  // reader — a `__extern_get` miss on the non-`$Object` native struct → always
  // false, silently wrong after `dispose()`. Runtime `ref.test $DisposableStack`
  // dispatch: match → the struct's disposed flag; miss → the generic read (a user
  // object's own `.disposed` still resolves). Byte-inert unless a
  // `DisposableStack` extern class is registered; `nativeStrings`-gated.
  if (propName === "disposed" && ctx.nativeStrings && ctx.externClasses.has("DisposableStack")) {
    const isDynamicReceiver = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || objType.isUnion();
    if (isDynamicReceiver) {
      const r = tryCompileNativeDisposableStackAnyDisposedGet(ctx, fctx, expr.expression);
      if (r !== undefined) return r as ValType;
    }
  }
  return PA_FALLTHROUGH;
}

export function tryConstructorPrototypeIdentity(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#2743 a) `arguments.constructor.prototype` → %Object.prototype% (§10.4.4):
  // the arguments object's `.constructor` is %Object%, whose `.prototype` is
  // %Object.prototype%. The arguments object is modeled as a vec, so the inner
  // `arguments.constructor` would resolve to the Array constructor and the outer
  // `.prototype` to %Array.prototype%. Intercept the COMPOUND access and emit the
  // compiler's own `Object.prototype` value-read (a synthetic `Object.prototype`
  // member access — the lowering is name-keyed on `Object`), so it matches the
  // identity a plain `Object.prototype` read produces. Host-mode only.
  if (
    !noJsHost(ctx) &&
    propName === "prototype" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "constructor" &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "arguments" &&
    fctx.localMap.has("arguments")
  ) {
    const objIdent = ts.factory.createIdentifier("Object");
    (objIdent as { parent?: ts.Node }).parent = expr;
    ts.setTextRange(objIdent, expr.expression.expression);
    const objProtoExpr = ts.factory.createPropertyAccessExpression(objIdent, ts.factory.createIdentifier("prototype"));
    (objProtoExpr as { parent?: ts.Node }).parent = expr.parent ?? expr;
    ts.setTextRange(objProtoExpr, expr);
    const t = compileExpression(ctx, fctx, objProtoExpr, { kind: "externref" });
    if (t) return t.kind === "externref" ? t : { kind: "externref" };
  }

  // (#2743 a) `arguments.constructor` → %Object% (§10.4.4). The arguments object
  // is modeled as a vec (array-like), so `.constructor` would otherwise resolve
  // to the Array constructor. Emit the compiler's own `Object` value-read via a
  // synthetic `Object` identifier so `arguments.constructor === Object`. (The
  // compound `arguments.constructor.prototype` shape is handled above, because
  // the bare `Object` value's `.prototype` is not identity-equal to the
  // `Object.prototype` member-read in this compiler.) Host-mode only.
  if (
    !noJsHost(ctx) &&
    propName === "constructor" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "arguments" &&
    fctx.localMap.has("arguments")
  ) {
    const objIdent = ts.factory.createIdentifier("Object");
    (objIdent as { parent?: ts.Node }).parent = expr.parent ?? expr;
    ts.setTextRange(objIdent, expr.expression);
    const t = compileExpression(ctx, fctx, objIdent, { kind: "externref" });
    if (t) return t.kind === "externref" ? t : { kind: "externref" };
  }

  // (#2901) `Object.getPrototypeOf(<view>.prototype).constructor` → the standalone
  // `%TypedArray%` intrinsic constructor object. This is the test262-runner's
  // injected `const TypedArray = Object.getPrototypeOf(Int8Array.prototype).constructor`
  // shim for the abstract intrinsic (test262-runner.ts ~1823); resolving the whole
  // syntactic chain to the ctor object (whose `.prototype` is `%TypedArray%.prototype`)
  // keeps the harness binding non-null at runtime and lets the §23.2.3 accessor
  // descriptor tests reach the #2893 getters host-free. Keyed on the call shape (not
  // identifier-as-value) so it cannot collide with the name-keyed `new Int8Array()`
  // construction path; standalone-only.
  if (noJsHost(ctx) && propName === "constructor" && isGetProtoOfWiredViewProtoCall(expr.expression)) {
    const t = emitTypedArrayIntrinsicCtorObject(ctx, fctx);
    if (t) return t.kind === "externref" ? t : { kind: "externref" };
  }

  // (#2026 PR-2) `.constructor` on an externref / `any`-typed instance: recover
  // class identity by reading the instance `__tag` and dispatching to the
  // matching `__class_<Name>` singleton, so `a.constructor === A` holds even when
  // `a` flowed through an `any` binding. Only fires for an `any`/`unknown`
  // receiver — a concretely-typed class instance keeps the zero-overhead static
  // arm in `compileInstanceMember`.
  if (propName === "constructor") {
    const isAnyOrUnknown = (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (isAnyOrUnknown) {
      const ctorIdn = tryEmitConstructorViaTag(ctx, fctx, expr, objType);
      if (ctorIdn !== undefined) return ctorIdn;
    }
  }

  // (#3006) Standalone `<Builtin>.prototype.constructor` / `<instance>.constructor`
  // → the GENUINE, identity-stable reified builtin-constructor object (supersedes
  // the #2537 null-fold). Reading `.constructor` on a builtin extern-class receiver
  // otherwise walks the inheritance chain (`compileExternPropertyGet`) to the
  // `Object` base extern class — the only declarer of `constructor`,
  // `importPrefix: "Object"` — and emits an `env::Object_get_constructor` host
  // import (the leak the #2999 round-5 analysis flagged: 9 standalone passes for
  // Set/WeakMap/WeakRef/WeakSet/RegExp/FinalizationRegistry/DisposableStack/
  // SuppressedError plus instance forms). Route it to the SAME per-name
  // `__builtin_ctor_<Name>` singleton the bare identifier now resolves to
  // (identifiers.ts), so `<Builtin>.prototype.constructor === <Builtin>` is
  // GENUINELY true (same object) and the swap-wrong-builtin cross-check
  // `Set.prototype.constructor === Map` is GENUINELY false — NOT the null≡null
  // tautology #2537 relied on.
  //
  // Placed HERE (before the builtin-specific `.prototype`/regexp/native-proto
  // member paths further down) so it fires UNIFORMLY for every target builtin:
  // routing `RegExp.prototype.constructor` through `compileExternPropertyGet` would
  // never reach it (a RegExp-specific member path returns first). Gated on the
  // receiver being a genuine ambient-declared builtin (`isExternalDeclaredClass` +
  // the narrow `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` set) so a user `class Set {}`
  // (not extern-declared) keeps its own `.constructor`. Standalone-only: gc/host
  // keeps the real `Object_get_constructor` read (a genuine value there).
  if (ctx.standalone && propName === "constructor") {
    const builtinName = objType.getSymbol()?.name;
    if (
      builtinName !== undefined &&
      isBuiltinConstructorIdentityName(builtinName) &&
      isExternalDeclaredClass(objType, ctx.checker)
    ) {
      // Evaluate the receiver for its side effects (spec: the object expression is
      // evaluated), then discard it — the constructor identity does not depend on
      // the receiver instance.
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      return emitBuiltinConstructorIdentity(ctx, fctx, builtinName);
    }
  }

  // (#3133) Standalone `.constructor` on a PLAIN-OBJECT or ARRAY receiver → the
  // SAME identity-stable namespace-object singleton the bare `Object` / `Array`
  // identifier resolves to (`emitBuiltinNamespaceObject`, identifiers.ts ~769).
  // #3006 deliberately EXCLUDED `Object`/`Array` from its per-builtin ctor
  // singletons because their bare values already carry genuine namespace-object
  // identity — but the `.constructor` READ path for their instances was never
  // routed anywhere, so `({}).constructor` / `[1].constructor` /
  // `Object.prototype.constructor` / `Array.prototype.constructor` fell through
  // to the dynamic `$Object` own-prop read and returned `undefined`
  // (`({}).constructor === Object` → false). Routing the read to the SAME
  // per-name `__builtin_<Name>` global makes the identity GENUINELY true (same
  // WasmGC object, `ref.eq`) while the swap-wrong-builtin cross-check
  // (`({}).constructor === Array`) stays GENUINELY false (distinct singletons).
  //
  // Conservative gates: static-type-driven like the #3006 arm above; declines
  // (falls through, current behavior) for any/unknown/union receivers, callables,
  // receivers whose type declares a USER-written `constructor` member, and — as
  // a module-wide guard against runtime shadowing — any module that assigns to
  // or deletes a `.constructor` property anywhere. Standalone-only: gc/host mode
  // keeps the genuine `Object_get_constructor` host read.
  if (ctx.standalone && propName === "constructor") {
    const nsName = classifyPlainCtorReceiverNamespace(ctx, objType);
    if (nsName !== undefined && !moduleTouchesConstructorProp(expr.getSourceFile())) {
      // Evaluate the receiver for its side effects (spec: MemberExpression is
      // evaluated), then discard it — the constructor identity is static.
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      const t = emitBuiltinNamespaceObject(ctx, fctx, nsName);
      if (t) return t.kind === "externref" ? t : { kind: "externref" };
    }
  }

  // (#2660 S2) `F.prototype` on a user function constructor (standalone): return
  // the per-fnctor prototype `$Object` global instead of `__extern_get($closure,
  // "prototype")` (which misses `ref.test $Object` → null). Makes
  // `Object.create(F.prototype)` resolve and seeds #2660 S3's `instance.$proto`.
  // Declines (falls through) for classes/builtins/host mode.
  {
    const fnctorProto = tryEmitFnctorPrototypeRead(ctx, fctx, expr, propName);
    if (fnctorProto !== undefined) return fnctorProto;
  }
  return PA_FALLTHROUGH;
}

export function tryPinnedAndDeleteAwareDynamicGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#2681/#2686 A3) Pinned-struct dynamic member READ. When the receiver is the
  // `this` of a lifted fnctor-PROTOTYPE method (`fctx.thisStructName`, set by
  // `resolveLiftedMethodThisStruct`), or a local bound from a single-return-
  // inferable fnctor `new`/call (the `receiverStruct` flow-map), route the
  // dynamic `recv.<field>` read through the finalize-filled `__get_member_<name>`
  // dispatcher. The dispatcher reads the native struct slot — returning the SAME
  // `__fnctor_*` struct externref the field stored — so `this.type === types.name`
  // is a native `ref.eq` and matches. Without this, acorn's Parser instance reads
  // `this.type` via the host-proxy `__extern_get`, whose externref identity
  // diverges from the stored native `__fnctor_TokenType` → the `switch` falls to
  // `default → unexpected()` (#2681) / the operator compare fails (#2686) → throw.
  // The dispatcher keeps `__extern_get` as its terminal, so accessor / genuinely-
  // dynamic props (`Object.defineProperties(Parser.prototype, …)`) still resolve.
  // Runs BEFORE the delete-aware read so it covers BOTH delete and delete-free
  // modules. The `this`-receiver branch intentionally bypasses
  // `resolveReceiverStruct`'s `structMap.has` gate: a reader method often compiles
  // before the `new this()` site registers the struct, but the dispatcher is
  // finalize-filled so a later-registered struct is still enumerated.
  {
    const pinnedThis =
      expr.expression.kind === ts.SyntaxKind.ThisKeyword && fctx.thisStructName !== undefined
        ? fctx.thisStructName
        : undefined;
    const pinned = pinnedThis ?? resolveReceiverStruct(ctx, fctx, expr.expression);
    if (pinned !== undefined) {
      const routed = tryEmitPinnedStructMemberGet(ctx, fctx, expr, propName);
      if (routed !== undefined) return routed;
    }
  }

  // (#2179) Tombstone-aware read for `any`/`unknown` receivers in delete-using
  // JS-host modules. The default `any`-receiver read resolves to an inline
  // `ref.test`+`struct.get` fast-path that reads the LIVE WasmGC field, ignoring
  // the runtime delete tombstone — so `delete o.a; o.a` returned the stale
  // value, and `o.a === undefined` constant-folded to `false` because the
  // field's static type is `f64` (never undefined). Route the read through the
  // tombstone-aware `__extern_get` host helper, which returns an `externref`
  // (real `undefined` when tombstoned, so `=== undefined` is no longer folded)
  // and re-add via `__extern_set`/`_safeSet` clears the tombstone. Gated on the
  // `moduleUsesDelete` pre-scan so delete-free modules keep the byte-identical
  // fast-path; standalone has no `__extern_get` host import (#2179 A7 covers it
  // via $Object representation steering — separate follow-up).
  {
    const dyn = tryEmitDeleteAwareDynamicGet(ctx, fctx, expr, objType, propName);
    if (dyn !== undefined) return dyn;
  }
  return PA_FALLTHROUGH;
}

export function tryBuiltinNamespaceDeferredReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  const jsonParsePropertyType = tryEmitJsonParsePropertyAccess(ctx, fctx, expr);
  if (jsonParsePropertyType !== undefined) return jsonParsePropertyType;

  {
    const temporalPropertyType = tryCompileTemporalPropertyAccess(ctx, fctx, expr);
    if (temporalPropertyType !== undefined) return temporalPropertyType;
  }

  // TextEncoder/TextDecoder read-only Web API properties under no-host
  // targets. These instances are stateless placeholders; preserve receiver
  // evaluation, then return the standard UTF-8/default option values.
  {
    const objSym =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    if (
      (ctx.wasi || ctx.standalone || ctx.strictNoHostImports) &&
      (objSym === "TextEncoder" || objSym === "TextDecoder")
    ) {
      if (propName === "encoding") {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" });
        return compileStringLiteral(ctx, fctx, "utf-8");
      }
      if (objSym === "TextDecoder" && (propName === "fatal" || propName === "ignoreBOM")) {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
    }
  }
  return PA_FALLTHROUGH;
}

export function tryBufferViewAttributeReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#3054 B2) Accessor props on a shared-backing `$__ta_view` receiver
  // (`.byteLength`, `.byteOffset`, `.buffer` identity, `BYTES_PER_ELEMENT`). Runs
  // BEFORE the generic TypedArray accessor arms below, which discriminate on the
  // TS type NAME and would `ref.cast` the view to a native vec (→ read 0 for
  // `.byteLength`, synthesize a fresh non-identity buffer for `.buffer`). The view
  // is discriminated by the receiver's resolved LOCAL typeIdx, so native TAs /
  // plain arrays / non-buffer programs never reach this arm (byte-inert). `.length`
  // stays on the B1 local-type arm further down.
  if (
    propName === "byteLength" ||
    propName === "byteOffset" ||
    propName === "buffer" ||
    propName === "BYTES_PER_ELEMENT"
  ) {
    const tvIdx = taViewReceiverTypeIdx(ctx, fctx, expr.expression);
    if (tvIdx !== undefined) {
      const r = emitTaViewAccessor(ctx, fctx, tvIdx, propName, expr.expression, (e, h) =>
        compileExpression(ctx, fctx, e, h),
      );
      if (r) return r;
    }
  }

  // (#3054 C) Standalone `.maxByteLength` / `.resizable` on an ArrayBuffer
  // receiver. The resizable-ness is the runtime type identity: a
  // `$__resizable_ab` instance (from `new ArrayBuffer(n, {maxByteLength})`) vs a
  // plain `$__vec_i32_byte`. Discriminated with `ref.test $__resizable_ab`:
  //   `.resizable`     → the test result (true for resizable, false for fixed).
  //   `.maxByteLength` → resizable: field 2; fixed: field 0 (byteLength) per
  //                      §25.1.5.4 (a fixed buffer reports its byteLength).
  // Only reached for a static ArrayBuffer receiver in the host-free lane; native
  // TAs / plain arrays / non-buffer programs never take this arm (byte-inert).
  if (
    (ctx.wasi || ctx.standalone || ctx.strictNoHostImports) &&
    (propName === "maxByteLength" || propName === "resizable")
  ) {
    const recvName =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    if (recvName === "ArrayBuffer" && noJsHost(ctx)) {
      const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
      const rabTypeIdx = getOrRegisterResizableAbType(ctx);
      // Recover the receiver as an anyref so `ref.test $__resizable_ab` is valid
      // regardless of whether the local is typed as the vec or externref.
      const recvType = compileExpression(ctx, fctx, expr.expression);
      if (recvType?.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      const abAny = allocLocal(fctx, `__rab_any_${fctx.locals.length}`, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: abAny });
      if (propName === "resizable") {
        fctx.body.push({ op: "local.get", index: abAny });
        fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx });
        // Boolean result. In non-fast mode surface it as an f64 0/1 (truthy in
        // conditionals, and `=== true` compares fold correctly downstream).
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32", boolean: true } : { kind: "f64" };
      }
      // maxByteLength: if resizable read field 2, else the byteLength (field 0).
      fctx.body.push({ op: "local.get", index: abAny });
      fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } as ValType },
        then: [
          { op: "local.get", index: abAny },
          { op: "ref.cast", typeIdx: rabTypeIdx },
          { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 },
        ],
        else: [
          { op: "local.get", index: abAny },
          { op: "ref.cast", typeIdx: vecTypeIdx },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        ],
      });
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
  }

  // (#2159 Slice 2) Standalone/WASI `byteLength` / `byteOffset` view-semantics
  // for ArrayBuffer / SharedArrayBuffer / TypedArrays. In JS-host mode the JS
  // runtime supplies these; with no host they fell through to `__extern_length`
  // / a 0 default. The backing representation (see dataview-native.ts):
  //   ArrayBuffer / SharedArrayBuffer  → vec "i32_byte" (field 0 = *byte* length)
  //   Uint8Array (native)              → vec "i8_byte"  (field 0 = element count)
  //   other TypedArrays                → vec "f64"      (field 0 = element count)
  // `byteLength` is element-size-scaled: ArrayBuffer/Uint8Array byteLength ==
  // field0; Int32Array == field0*4, Float64Array == field0*8, etc. `byteOffset`
  // is always 0 for our non-offset views (a fresh backing store per view), which
  // already reads correctly today — handled here only for the externref-receiver
  // case so it doesn't leak `__extern_get`.
  // (#3061) `.byteLength` / `.byteOffset` on an ArrayBuffer / SharedArrayBuffer
  // are ALSO computed natively in JS-host mode. The host `__extern_get` fallback
  // returns `undefined` for these accessors on the opaque WasmGC byte-vec struct
  // (they are not real struct fields and no `__sget_byteLength` export exists), so
  // `ab.byteLength` / `ab.byteOffset` read back NaN (~45 test262 fails). The
  // `i32_byte` backing (field-0 = byte count, element size 1) is IDENTICAL across
  // host and standalone, so the `isBuffer` arm below is representation-safe in both
  // modes. (#3062) DataView is ALSO host-handled now, via the `__dv_view_byte_attr`
  // helper that reads the `_dvViewMeta` window (see the dedicated arm below).
  // TypedArray stays standalone-only here (its element-scaled backing diverges in
  // host mode — a separate follow-up).
  const hostBufferByteAttr =
    !noJsHost(ctx) && !ctx.strictNoHostImports && (propName === "byteLength" || propName === "byteOffset");
  if (
    (ctx.wasi || ctx.standalone || ctx.strictNoHostImports || hostBufferByteAttr) &&
    (propName === "byteLength" || propName === "byteOffset" || propName === "BYTES_PER_ELEMENT")
  ) {
    const recvNameRaw =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    // (#3062) `DataView.prototype.byteLength` / `ArrayBuffer.prototype.byteLength`
    // etc. — a `.prototype` receiver has the buffer/view TYPE name but is NOT an
    // instance (no [[DataView]] / [[ArrayBufferData]] internal slot), so per spec
    // (§25.3.4.1 / §25.1.5.1 step 3) the getter must throw a TypeError. The native
    // accessor arms below would instead read a bogus 0 off the non-instance
    // prototype object (`__dv_byte_len` misses → 0, or a trapping `ref.cast`
    // standalone). Null out `recvName` for a `<ctor>.prototype` receiver so every
    // arm skips it and the read falls through to the generic reader, which
    // reports the required TypeError (matches pre-#3061/#3062 behaviour).
    const recvName =
      ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "prototype"
        ? undefined
        : recvNameRaw;
    // (#3061) In JS-host mode only the plain ArrayBuffer arm is
    // representation-safe (`i32_byte`, field-0 = byte count, identical to
    // standalone). SharedArrayBuffer's host-mode backing differs (a bare
    // `i32_byte` `ref.test` misses → a wrong `0`), so keep SAB — like
    // TypedArray — gated to no-host; both fall through to the generic reader in
    // host mode exactly as before.
    const isBuffer = recvName === "ArrayBuffer" || (recvName === "SharedArrayBuffer" && noJsHost(ctx));
    const isTypedArr = recvName !== undefined && TYPED_ARRAY_NAMES.has(recvName) && noJsHost(ctx);
    const isDataView = recvName === "DataView";
    // (#2159/#38) DataView `byteOffset` / `byteLength` honour the constructor's
    // window. The receiver is either a `$__dv_window` wrapper (windowed view) or
    // a bare `$__vec_i32_byte` (offset-0 default-length view). For the wrapper,
    // read its byteOffset / byteLength fields; for the bare vec, byteOffset = 0
    // and byteLength = vec.length (one i32 per byte ⇒ length IS the byte count).
    if (isDataView && noJsHost(ctx) && propName !== "BYTES_PER_ELEMENT") {
      const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
      const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
      const fieldIdx = propName === "byteOffset" ? 1 : 2;
      // (#3173) §25.3.4.2/3 — the byteLength/byteOffset getters throw TypeError
      // on a detached buffer (marker: buffer vec length < 0). Template built
      // BEFORE the receiver compile (funcIdx-capture ordering rule).
      const detachedThrow = dvDetachedThrowInstrs(ctx);
      flushLateImportShifts(ctx, fctx);
      const recvType = compileExpression(ctx, fctx, expr.expression);
      const anyLocal = allocLocal(fctx, `__dvp_any_${fctx.locals.length}`, { kind: "anyref" });
      if (recvType?.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      fctx.body.push({ op: "local.set", index: anyLocal });
      const winBranch: Instr[] = [
        // detached? → TypeError
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: dvWinTypeIdx },
        { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 }, // buf
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }, // buf.length
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        { op: "if", blockType: { kind: "empty" }, then: detachedThrow, else: [] },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: dvWinTypeIdx },
        { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx },
      ];
      const vecBranch: Instr[] =
        propName === "byteOffset"
          ? [{ op: "i32.const", value: 0 }]
          : [
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: vecTypeIdx },
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            ];
      fctx.body.push({ op: "local.get", index: anyLocal });
      fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: winBranch,
        else: vecBranch,
      });
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
    // (#3062) JS-host DataView `byteLength` / `byteOffset`. In host mode
    // `new DataView(buf, offset, length)` returns the raw i32_byte buffer struct
    // (no `$__dv_window` wrapper — that shape is `noJsHost`-only, see
    // new-super.ts); the view window is recorded out-of-band in `_dvViewMeta` by
    // `__dv_register_view` at construction. Without this arm the read falls
    // through to `__extern_get(struct, "byteLength")` → undefined → NaN. Recover
    // the window via the `__dv_view_byte_attr(view, sel)` host helper:
    //   sel 0 → byteOffset, sel 1 → byteLength (windowed; sentinel handled host-side).
    if (isDataView && !noJsHost(ctx) && propName !== "BYTES_PER_ELEMENT") {
      const attrIdx = ensureLateImport(
        ctx,
        "__dv_view_byte_attr",
        [{ kind: "externref" }, { kind: "i32" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (attrIdx !== undefined) {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        // The helper takes an externref. DataView locals are already externref;
        // an inline `new DataView(...)` receiver may hand back a GC ref
        // (`ref`/`ref_null`) — recover it to externref before the call.
        if (recvType && recvType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        fctx.body.push({ op: "i32.const", value: propName === "byteOffset" ? 0 : 1 });
        fctx.body.push({ op: "call", funcIdx: attrIdx });
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    if (isBuffer || isTypedArr) {
      // byteOffset on a fresh-backing view is always 0.
      if (propName === "byteOffset") {
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType !== null) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
      // (#2595) `view.BYTES_PER_ELEMENT` — instance element byte width
      // (§23.2.3.1). A constant per constructor name; drop the (possibly
      // side-effecting) receiver and emit it. Only TypedArrays expose it —
      // ArrayBuffer/SharedArrayBuffer/DataView do not, so when the receiver is a
      // buffer, fall through (the read resolves to `undefined` downstream).
      if (propName === "BYTES_PER_ELEMENT") {
        if (isTypedArr) {
          const recvType = compileExpression(ctx, fctx, expr.expression);
          if (recvType !== null) fctx.body.push({ op: "drop" });
          const bytes = TYPED_ARRAY_BYTES_PER_ELEMENT[recvName!] ?? 1;
          fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: bytes });
          return ctx.fast ? { kind: "i32" } : { kind: "f64" };
        }
      } else {
        // byteLength = field0 * BYTES_PER_ELEMENT. ArrayBuffer's field0 is already
        // a byte count, so its element size is 1.
        const bytesPerElem = isBuffer ? 1 : (TYPED_ARRAY_BYTES_PER_ELEMENT[recvName!] ?? 1);
        // (#2593) The vec storage MUST match the receiver's actual backing element
        // type — `typedArrayVecStorage` now packs all integer views standalone
        // (i8/i16/i32_byte), not just Uint8Array. Casting an Int32Array (i32_byte)
        // receiver to an f64 vec read the wrong field-0 → wrong byteLength.
        const storage = isBuffer
          ? { key: "i32_byte", type: { kind: "i8" } as ValType } // (#2835) packed byte buffer
          : typedArrayVecStorage(ctx, recvName!);
        const elemKey = storage.key;
        const elemType: ValType = storage.type;
        const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
        // (#2593) An EMPTY `new TA(0)` literal can compile to a different backing
        // vec type (e.g. an f64/empty vec) than the packed `vecTypeIdx` for the
        // declared view — an unconditional `ref.cast` then traps (`illegal cast`).
        // Read field-0 (length) through a runtime `ref.test`: on a packed-vec hit
        // read its length; on a miss (empty/mismatched backing) the length is 0
        // (`byteLength` of an empty view is 0 regardless of element width).
        const recvType = compileExpression(ctx, fctx, expr.expression);
        if (recvType?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        const lenTmpBL = allocLocal(fctx, `__bl_len_${fctx.locals.length}`, { kind: "anyref" });
        fctx.body.push({ op: "local.set", index: lenTmpBL });
        fctx.body.push({ op: "local.get", index: lenTmpBL });
        fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } as ValType },
          then: [
            { op: "local.get", index: lenTmpBL },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
          ],
          else: [{ op: "i32.const", value: 0 }],
        });
        if (bytesPerElem !== 1) {
          fctx.body.push({ op: "i32.const", value: bytesPerElem });
          fctx.body.push({ op: "i32.mul" });
        }
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
  }

  // (#2596) `view.buffer` for a TypedArray / DataView under no-host. Without a
  // dedicated arm this fell to the generic `__extern_get(view, "buffer")` read
  // whose externref result was `ref.cast` to the `i32_byte` ArrayBuffer vec —
  // and since a `new TA(n)` view's backing is an `f64`/`i8` vec (not an
  // `i32_byte` buffer) and standalone has no real buffer object, the cast
  // trapped `illegal cast` at runtime, breaking EVERY `.buffer`-touching test.
  //
  // §22.2 / §25.x — `.buffer` is the view's [[ViewedArrayBuffer]]. We synthesize
  // a fresh `i32_byte` ArrayBuffer vec whose byte length == the view's byte
  // length (field-0 element count × BYTES_PER_ELEMENT for a TypedArray; the
  // backing byte count for a DataView), zero-filled. This makes
  // `view.buffer.byteLength` correct and non-trapping (the dominant test262 use).
  // TRUE write-through aliasing (mutating `.buffer` mutates the view, and
  // `a.buffer === b.buffer` identity) is OUT OF SCOPE — it needs the unified
  // byte-storage representation (pairs with #2593's packed migration); this slice
  // is the non-trapping floor. Host/gc mode keeps its host-import `.buffer`.
  if (propName === "buffer" && noJsHost(ctx)) {
    const bufRecvName =
      objType.getSymbol()?.name ??
      (ts.isNewExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : undefined);
    const bufIsTypedArr = bufRecvName !== undefined && TYPED_ARRAY_BYTES_PER_ELEMENT[bufRecvName] !== undefined;
    const bufIsDataView = bufRecvName === "DataView";
    if (bufIsTypedArr || bufIsDataView) {
      const byteVecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
      const byteArrTypeIdx = getArrTypeIdxFromVec(ctx, byteVecTypeIdx);
      if (byteArrTypeIdx >= 0) {
        const byteLenLocal = allocLocal(fctx, `__tabuf_len_${fctx.locals.length}`, { kind: "i32" });
        if (bufIsDataView) {
          // (#3173) §25.3.4.1 — a DataView's `.buffer` is its ACTUAL viewed
          // buffer, identity included (`sample.buffer === buffer`, works on a
          // detached buffer too). Standalone DataViews are `$__dv_window`
          // wrappers whose `buf` field HOLDS the shared buffer vec — return it
          // directly instead of synthesizing a fresh zero-filled copy (the
          // pre-#3173 non-identity floor). A bare-vec receiver (legacy shape)
          // IS the buffer — return it unchanged.
          const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
          const recvType = compileExpression(ctx, fctx, expr.expression);
          const anyLocal = allocLocal(fctx, `__tabuf_any_${fctx.locals.length}`, { kind: "anyref" });
          if (recvType?.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" });
          }
          fctx.body.push({ op: "local.set", index: anyLocal });
          const winBranch: Instr[] = [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: dvWinTypeIdx },
            { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 }, // buf (shared)
            { op: "extern.convert_any" },
          ];
          const vecBranch: Instr[] = [{ op: "local.get", index: anyLocal }, { op: "extern.convert_any" }];
          fctx.body.push({ op: "local.get", index: anyLocal });
          fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: winBranch,
            else: vecBranch,
          });
          return { kind: "externref" };
        } else {
          // TypedArray: backing is an f64 vec (or i8 for standalone Uint8Array);
          // byteLen = element-count (field 0) × BYTES_PER_ELEMENT.
          const elemKey = noJsHost(ctx) && bufRecvName === "Uint8Array" ? "i8_byte" : "f64";
          const elemType: ValType = elemKey === "i8_byte" ? { kind: "i8" } : { kind: "f64" };
          const viewVecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
          const recvType = compileExpression(ctx, fctx, expr.expression);
          if (recvType?.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "ref.cast", typeIdx: viewVecTypeIdx });
          } else if (
            (recvType?.kind === "ref" || recvType?.kind === "ref_null") &&
            "typeIdx" in recvType &&
            recvType.typeIdx !== viewVecTypeIdx
          ) {
            fctx.body.push({ op: "ref.cast", typeIdx: viewVecTypeIdx });
          }
          fctx.body.push({ op: "struct.get", typeIdx: viewVecTypeIdx, fieldIdx: 0 });
          const bytesPerElem = TYPED_ARRAY_BYTES_PER_ELEMENT[bufRecvName!] ?? 1;
          if (bytesPerElem !== 1) {
            fctx.body.push({ op: "i32.const", value: bytesPerElem });
            fctx.body.push({ op: "i32.mul" });
          }
          fctx.body.push({ op: "local.set", index: byteLenLocal });
        }
        // Build the i32_byte ArrayBuffer vec: struct.new (byteLen, zero-filled
        // array of byteLen bytes). One i32 per byte (0..255), matching the
        // ArrayBuffer / DataView backing representation (dataview-native.ts).
        fctx.body.push({ op: "local.get", index: byteLenLocal });
        fctx.body.push({ op: "i32.const", value: 0 }); // default byte value
        fctx.body.push({ op: "local.get", index: byteLenLocal });
        fctx.body.push({ op: "array.new", typeIdx: byteArrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: byteVecTypeIdx });
        return { kind: "ref", typeIdx: byteVecTypeIdx };
      }
    }
  }
  return PA_FALLTHROUGH;
}

export function tryStandaloneBuiltinAndWasiMemberReads(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // #1914 — standalone RegExp reflection (`re.source`/`.flags`/`.global`/…/
  // `.lastIndex`) and match-result fields (`m.index`/`m.input`). Must run
  // BEFORE the extern-class property path, which would otherwise emit an
  // `env.RegExp_get_*` host import (a standalone purity leak), and before the
  // generic struct/vec fallbacks, which silently return 0 for `.index`.
  // (#2175 S1) `<Builtin>.prototype.<member>.length` / `.name` — the arity/name
  // of a native-method-closure VALUE, folded at compile time from the glue's
  // advertised metadata (e.g. `RegExp.prototype.test.length === 1`,
  // `.name === "test"`). Must precede the closure-value path so the member is
  // not materialized just to read its arity. Static, zero runtime cost.
  {
    const metaRead = tryCompileStandaloneBuiltinProtoMemberMeta(ctx, fctx, expr);
    if (metaRead !== undefined) return metaRead;
  }

  // (#2175 S1) `<Builtin>.prototype.<member>` as a value (two-level access whose
  // inner is a builtin proto): resolve `<member>` to a native-method/getter
  // closure value via the brand-keyed factory, with a brand-recovery prologue.
  // This is the reflective tier — `RegExp.prototype.test`, the `.flags`-getter,
  // etc. — that chained off the inner `RegExp.prototype` refusal pre-#2175.
  //
  // MUST run BEFORE the #1914 instance-reflection read: the static type of
  // `RegExp.prototype` is `RegExp`, so #1914's `isGlobalRegExpType` guard would
  // otherwise capture `RegExp.prototype.flags` and refuse (the proto object is
  // not a backend-created RegExp *value*). The proto-member path returns the
  // member's accessor/method *closure* — the correct reflective semantics.
  {
    const protoMember = tryCompileStandaloneBuiltinProtoMemberRead(ctx, fctx, expr);
    if (protoMember !== undefined) return protoMember;
  }

  {
    const standaloneRegExpRead = tryCompileStandaloneRegExpPropertyRead(ctx, fctx, expr);
    if (standaloneRegExpRead !== undefined) return standaloneRegExpRead;
    const standaloneMatchResultRead = tryCompileStandaloneRegExpMatchResultRead(ctx, fctx, expr);
    if (standaloneMatchResultRead !== undefined) return standaloneMatchResultRead;
  }

  // #1780 — `TextEncoder.encodeInto(...).read` / `.written` under no-host
  // targets. The call lowers to a native helper returning a
  // `TextEncoderEncodeIntoResult` WasmGC struct; read its fields with a direct
  // `struct.get` (fields: 0 = read, 1 = written, both f64) instead of the
  // generic `__extern_get` host import, which is unavailable standalone/WASI.
  if (
    (ctx.wasi || ctx.standalone || ctx.strictNoHostImports) &&
    (propName === "read" || propName === "written") &&
    objType.getSymbol()?.name === "TextEncoderEncodeIntoResult"
  ) {
    // Compile the receiver first: the `encodeInto(...)` call registers the
    // `TextEncoderEncodeIntoResult` struct and returns it as a ref, so the
    // struct type index is only known *after* the call is lowered.
    const recvType = compileExpression(ctx, fctx, expr.expression);
    const resultTypeIdx = ctx.structMap.get("TextEncoderEncodeIntoResult");
    if (
      resultTypeIdx !== undefined &&
      recvType &&
      (recvType.kind === "ref" || recvType.kind === "ref_null") &&
      recvType.typeIdx === resultTypeIdx
    ) {
      fctx.body.push({ op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: propName === "read" ? 0 : 1 });
      return { kind: "f64" };
    }
    // Receiver didn't lower to the result struct — undo nothing (we already
    // emitted it); coerce/return a sensible f64 fallback.
    if (recvType !== null) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }

  // #1482 — `process.env.X` under `--target wasi`. Short-circuit BEFORE the
  // generic `__extern_get` host-import path: the standalone WASI module has
  // no `process` global, and even with a JS polyfill the generic extern lookup
  // path wouldn't know how to route through the WASI environ table. Lower to
  // a host-import call `__wasi_env_get_str(<key>) -> externref` (registered by
  // `registerWasiImports` when usage is detected). The JS polyfill supplies a
  // `(key) => process.env[key]` shim; a future pure-WASI implementation can
  // replace the host import with an inline call to `environ_get`.
  if (
    ctx.wasi &&
    ctx.wasiEnvGetStrIdx >= 0 &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "process" &&
    expr.expression.name.text === "env"
  ) {
    // Push the property name as an externref string (NativeString → externref).
    const keyType = compileStringLiteral(ctx, fctx, propName);
    if (keyType && keyType.kind !== "externref") {
      coerceType(ctx, fctx, keyType, { kind: "externref" });
    }
    fctx.body.push({ op: "call", funcIdx: ctx.wasiEnvGetStrIdx });
    return { kind: "externref" };
  }
  return PA_FALLTHROUGH;
}

export function tryNativeErrorMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // (#1104 Phase 2) WASI/standalone-mode native Error property access.
  //
  // When the LHS TypeScript type resolves to a built-in Error subclass
  // (Error, TypeError, RangeError, SyntaxError, URIError, EvalError,
  // ReferenceError, AggregateError) and the property is `message` or `name`,
  // emit a direct `struct.get $Error_struct <field>` instead of falling
  // through to the generic `__extern_get` host-import path. The host import
  // is unavailable in standalone mode, so without this fast path
  // `error.message` traps at instantiation time. JS-host mode is unchanged
  // — the fast path is gated on `ctx.wasi`.
  //
  // Field layout in `$Error_struct` (registered by emitWasiErrorConstructor):
  //   0: tag      (i32)        — from BUILTIN_TYPE_TAGS, drives Phase 3 instanceof
  //   1: message  (mut externref) — populated by ctor's first arg
  //   2: name     (externref)   — Phase 1 placeholder (ref.null extern)
  //
  // The struct is converted to externref via `extern.convert_any` at
  // construction time, so call sites see externref. To read the field we
  // round-trip through anyref: `any.convert_extern + ref.cast (ref
  // $Error_struct) + struct.get`. If the receiver is already null at
  // runtime, `ref.cast` traps — but native JS has the same behaviour
  // (`null.message` throws), so the trap is acceptable Phase 1/2 semantics.
  if ((ctx.wasi || ctx.standalone) && (propName === "message" || propName === "name" || propName === "stack")) {
    const lhsTsName = objType.getSymbol()?.name;
    // (#1536c) A user subclass of a built-in Error (`class MyError extends
    // Error {}`) is externref-backed; its instance is the parent's
    // `$Error_struct` (created natively by `__new_<Parent>`). Treat it as an
    // Error LHS so `.message`/`.name`/`.stack` read the struct field directly
    // instead of the generic `__extern_get` host path (unavailable standalone,
    // returns null). The struct field layout is the parent's.
    const lhsUserErrorParent =
      lhsTsName !== undefined && !isBuiltinTypeName(lhsTsName) ? ctx.classBuiltinParentMap.get(lhsTsName) : undefined;
    const isErrorLhs =
      (lhsTsName !== undefined &&
        isBuiltinTypeName(lhsTsName) &&
        isWasiErrorName(lhsTsName) &&
        isBuiltinSubtype(lhsTsName, "Error")) ||
      (lhsUserErrorParent !== undefined && (lhsUserErrorParent === "Error" || isWasiErrorName(lhsUserErrorParent)));
    // #2077: a `catch (e)` binding is typed `any` (or `unknown`), so the static
    // `isErrorLhs` gate above never fires even though the caught value IS the
    // `$Error` struct at runtime — the field read then fell through to the
    // generic `__extern_get` host path, which returns null in standalone mode
    // (no host). For such a binding, emit a runtime `ref.test $Error`–guarded
    // read instead of trusting the static type.
    //
    // CRITICAL scope (#2077 regression fix): this guard MUST be restricted to a
    // `catch`-clause binding, NOT every `any`/`unknown` receiver. A general
    // `const o: any = { message: "x" }` reads `o.message` through the normal
    // object-property path (which works in standalone); hijacking ALL
    // `any.message`/`any.name` reads with the `$Error` guard made the non-Error
    // `else` arm return a null string, so `o.message.length` trapped
    // (null deref) on plain objects. Gating on the catch binding keeps the
    // common plain-object read on its working generic path and applies the
    // `$Error` guard only where the value genuinely originates from a `throw`.
    const isCatchBindingReceiver = receiverIsCatchClauseBinding(ctx, expr.expression);
    const isErrorLikeRuntimeLhs =
      !isErrorLhs && isCatchBindingReceiver && (objType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (isErrorLhs || isErrorLikeRuntimeLhs) {
      const structIdx = getOrRegisterErrorStructType(ctx);
      // $Error_struct field layout: 1=message, 2=name, 3=stack (#1536).
      const fieldIdx = propName === "message" ? 1 : propName === "name" ? 2 : 3;
      // Compile receiver. Mirror the standalone instanceof lowering
      // (identifiers.ts): compile WITHOUT forcing externref, then coerce, so a
      // catch-binding externref holding an `$Error` struct keeps its identity
      // through `any.convert_extern` + `ref.test` (forcing externref as the
      // expected type re-boxed the value and broke the ref.test — #2077).
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult && objResult.kind !== "externref") {
        coerceType(ctx, fctx, objResult, { kind: "externref" });
      } else if (!objResult) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "any.convert_extern" });

      // The `$Error_struct` message/name fields are stored as `externref`
      // (populated by the ctor via `extern.convert_any` over a native
      // string). In nativeStrings/WASI mode every other string producer hands
      // consumers a `$AnyString` ref, so coerce here once and return that ref
      // type. Otherwise the externref result flows into native string ops
      // (`=== `, `.length`, concat, interpolation) that expect `(ref null
      // $AnyString)`, and the per-consumer externref→string coercion either
      // misfires or is skipped → invalid Wasm (#1797).
      const resultType: ValType =
        ctx.nativeStrings && ctx.anyStrTypeIdx >= 0
          ? { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx }
          : { kind: "externref" };

      if (isErrorLhs) {
        // Static Error type — the value is always an `$Error` struct, so cast
        // unconditionally (a runtime non-Error would mean a miscompile elsewhere).
        fctx.body.push({ op: "ref.cast", typeIdx: structIdx });
        fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx });
        if (resultType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, resultType);
        return resultType;
      }

      // #2077 — `any`/`unknown` receiver (the common `catch (e)` case). The
      // anyref is on the stack. Guard with `ref.test $Error`: when it IS an
      // `$Error` struct, cast + read the field + coerce to the native string
      // ref; otherwise produce a null string (a non-Error value, e.g.
      // `throw "str"`, has no struct field to read). The whole read — including
      // the externref→string coercion — lives in the `then` arm so a non-Error
      // never executes a struct.get/cast. Mirrors the instanceof guard in
      // identifiers.ts, which proves the caught struct is recoverable here.
      const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: tmpAny });
      fctx.body.push({ op: "local.get", index: tmpAny });
      fctx.body.push({ op: "ref.test", typeIdx: structIdx });
      // Build the `then` arm (read + coerce) into a swapped body buffer so
      // coerceType's appends land in the arm, not the main body.
      const savedBody = fctx.body;
      fctx.body = [];
      fctx.body.push({ op: "local.get", index: tmpAny });
      fctx.body.push({ op: "ref.cast", typeIdx: structIdx });
      fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx });
      if (resultType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, resultType);
      const thenInstrs = fctx.body;
      fctx.body = savedBody;
      const elseInstrs: Instr[] =
        resultType.kind === "externref"
          ? [{ op: "ref.null.extern" }]
          : [{ op: "ref.null", typeIdx: (resultType as { typeIdx: number }).typeIdx }];
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenInstrs,
        else: elseInstrs,
      });
      releaseTempLocal(fctx, tmpAny);
      return resultType;
    }
  }
  return PA_FALLTHROUGH;
}

export function tryPrivateIdentifierRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // #1365 — Private-name read with spec-compliant brand check.
  //
  // Per ES2022 §15.7 (PrivateFieldGet / PrivateBrandCheck): when reading
  // `obj.#x`, if `obj` lacks the brand of the class that declared `#x`,
  // throw a TypeError. Today the generic property-access path falls
  // through to alternate-struct lookup (which can read `__priv_x` from a
  // DIFFERENT class with the same field-name layout) or to `__extern_get`
  // (which silently returns undefined). Both violate the brand-tied
  // semantics of private names.
  //
  // Implementation: when the property name is a PrivateIdentifier, resolve
  // the lexically-declaring class via parent-chain walk. Compile the
  // receiver, ref.test it against the declaring class's struct, and on
  // failure throw a real TypeError instance (so `assert.throws(TypeError,
  // ...)` passes). On success, ref.cast + struct.get the field.
  //
  // Skips the brand check for:
  //   - `super.#x` — handled by the super branch below; super already
  //     guarantees the right brand structurally.
  //   - PrivateIdentifier accesses inside the class body where
  //     `expr.expression.kind === ThisKeyword` AND the local `this` is
  //     known to be the class struct ref — the legacy struct.get is
  //     correct in that case (TS guarantees the brand, no runtime check
  //     needed). The brand check fires only when the receiver type may
  //     differ from the declaring class.
  if (ts.isPrivateIdentifier(expr.name) && expr.expression.kind !== ts.SyntaxKind.SuperKeyword) {
    const declared = resolveDeclaringClassForPrivateName(ctx, expr.name);
    if (declared) {
      const fieldIdx = ctx.structFields.get(declared.className)!.findIndex((f) => f.name === declared.fieldName);
      if (fieldIdx >= 0) {
        const fieldType = ctx.structFields.get(declared.className)![fieldIdx]!.type;
        // Compile the receiver. Branch by what we got back — class refs
        // emit ref.test directly; externref needs any.convert_extern first.
        const objResult = compileExpression(ctx, fctx, expr.expression);
        // Save the receiver value so we can emit ref.test, then optionally
        // ref.cast against the brand. Use anyref as the saved type so we
        // can hold class-refs and externrefs uniformly.
        const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
        if (objResult?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "local.set", index: tmpAny });
        emitPrivateBrandPredicate(ctx, fctx, tmpAny, declared.className, declared.structTypeIdx);
        // result-type block: on success, return the field value; on
        // failure, throw TypeError (which doesn't return).
        const successInstrs: Instr[] = [
          { op: "local.get", index: tmpAny },
          { op: "ref.cast", typeIdx: declared.structTypeIdx },
          { op: "struct.get", typeIdx: declared.structTypeIdx, fieldIdx },
        ];
        // Capture failure-path instrs by emitting into a saved body buffer.
        // Use pushBody/popBody (not a raw swap): emitThrowTypeError can add a
        // late string-constant import, which shifts every module-global index
        // and runs fixupModuleGlobalIndices. That fixup walks fctx.savedBodies,
        // so the swapped-out real body (which already holds the receiver's
        // `global.get` from `compileExpression(expr.expression)` above when the
        // receiver is a module global, e.g. a closed-over `self`) MUST be
        // registered there — otherwise its `global.get <self>` keeps its
        // pre-shift index and reads the wrong (f64) global → invalid Wasm
        // (#2563, privatefieldget-typeerror-5).
        const savedBody = pushBody(fctx);
        const message = `Cannot read private member #${expr.name.text.slice(1)} from an object whose class did not declare it`;
        emitThrowTypeError(ctx, fctx, message);
        const failureInstrs = fctx.body;
        popBody(fctx, savedBody);
        // Wrap in `if` returning fieldType. The `else` (failure) branch
        // ends with `throw`, which is unreachable per Wasm typing, so the
        // block's result type is satisfied by the `then` arm only.
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: fieldType },
          then: successInstrs,
          else: failureInstrs,
        });
        releaseTempLocal(fctx, tmpAny);
        return fieldType;
      }
    }
    // #1680 — Brand check for private *accessor* (getter) and *method*
    // reads. The field path above only fires for struct-backed private
    // fields; a `get #m()` / `#m() {}` member is registered in
    // classAccessorSet / classMethodSet, not structFields, so `declared`
    // is undefined (or fieldIdx < 0) and the field path is skipped.
    //
    // Per ES2022 §15.7 PrivateFieldGet step 4 (PrivateBrandCheck): reading
    // `o.#m` when `o` lacks the brand of the declaring class throws a
    // TypeError. Without this, the generic getter dispatch below calls the
    // getter with a wrong-brand receiver and silently misbehaves (test262
    // private-{getter,method}-brand-check cases).
    //
    // We emit the same ref.test guard as the field path, then on success
    // dispatch the getter call (accessor) or return the brand-checked
    // receiver as a value (method-as-value). Skipped when the receiver is
    // `this` inside the declaring class body — TS guarantees the brand.
    const cls = classifyPrivateMember(ctx, expr.name);
    if (
      cls &&
      (cls.kind === "method" || cls.kind === "accessor" || cls.kind === "accessor-readonly") &&
      expr.expression.kind !== ts.SyntaxKind.ThisKeyword
    ) {
      const structTypeIdx = ctx.structMap.get(cls.className);
      const getterName = `${cls.className}_get_${cls.fieldName}`;
      const canEmit =
        structTypeIdx !== undefined && (cls.kind === "method" || ctx.funcMap.has(classMemberFuncKey(ctx, getterName)));
      if (canEmit) {
        const objResult = compileExpression(ctx, fctx, expr.expression);
        const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
        if (objResult?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "local.set", index: tmpAny });
        emitPrivateBrandPredicate(ctx, fctx, tmpAny, cls.className, structTypeIdx!);

        // Build the failure (throw) branch FIRST. emitThrowTypeError may
        // register late imports, which shift every funcMap index (the
        // getter's included). Settling those shifts before we read the
        // getter funcIdx keeps the `call` target correct.
        //
        // Use pushBody/popBody so the swapped-out real body is on
        // fctx.savedBodies for fixupModuleGlobalIndices: the receiver's
        // `global.get` (emitted by compileExpression above when the receiver
        // is a module global, e.g. a closed-over `self`) must shift with the
        // late string-constant import too, or it reads the wrong global type
        // → invalid Wasm (#2563, same defect as the field path above).
        const savedBody = pushBody(fctx);
        const message = `Cannot read private member #${expr.name.text.slice(1)} from an object whose class did not declare it`;
        emitThrowTypeError(ctx, fctx, message);
        const failureInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Success path: cast to the declaring struct, then either call the
        // getter (accessor) or answer the method VALUE.
        let successInstrs: Instr[] = [
          { op: "local.get", index: tmpAny },
          { op: "ref.cast", typeIdx: structTypeIdx! },
        ];
        let resultKind: ValType;
        if (cls.kind === "method") {
          // (#3080) Reading a private method as a value must yield the SAME
          // canonical cached singleton the `this.#m` read yields (the
          // `__method_closure_<Owner>_<fieldName>` global minted by
          // `emitCachedMethodClosureAccess`), so
          // `this.#m === (() => this)().#m` holds. The legacy arm returned
          // the brand-checked RECEIVER itself as an externref view — a value
          // that is neither the method nor `===` any other read of it. The
          // brand check above still throws on a wrong-brand receiver.
          const canonicalClass = ctx.classExprNameMap.get(cls.className) ?? cls.className;
          const ownerName = resolveMethodOwnerClass(ctx, canonicalClass, cls.fieldName);
          const methodFullName = `${ownerName}_${cls.fieldName}`;
          const methodFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, methodFullName));
          const ownerStructTypeIdx = ctx.structMap.get(ownerName) ?? structTypeIdx!;
          let emitted = false;
          if (methodFuncIdx !== undefined) {
            // Capture the singleton access into a detached array. The failure
            // (throw) branch was popBody'd above and is DETACHED — register it
            // on savedBodies for the duration of this emission so any late
            // import/global shift the singleton emission triggers reaches its
            // baked indices too (the #2563 hazard class).
            fctx.savedBodies.push(failureInstrs);
            const savedBody2 = pushBody(fctx);
            emitted = emitCachedMethodClosureAccess(ctx, fctx, methodFullName, methodFuncIdx, ownerStructTypeIdx);
            const singletonInstrs = fctx.body;
            popBody(fctx, savedBody2);
            fctx.savedBodies.pop();
            if (emitted) successInstrs = singletonInstrs;
          }
          if (!emitted) {
            // Fallback (signature unresolvable): legacy receiver-view.
            successInstrs.push({ op: "extern.convert_any" });
          }
          resultKind = { kind: "externref" };
        } else {
          // Resolve the getter funcIdx AFTER the throw branch settled imports.
          const getterIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName))!;
          successInstrs.push({ op: "call", funcIdx: getterIdx });
          const funcDef = definedFuncAt(ctx, getterIdx);
          const typeDef = funcDef ? ctx.mod.types[funcDef.typeIdx] : undefined;
          resultKind =
            typeDef && typeDef.kind === "func" && typeDef.results.length > 0
              ? typeDef.results[0]!
              : { kind: "externref" };
        }

        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: resultKind },
          then: successInstrs,
          else: failureInstrs,
        });
        releaseTempLocal(fctx, tmpAny);
        return resultKind;
      }
    }
    // Resolver failure (no enclosing class declares this private name).
    // Fall through to the generic path; it will throw via the existing
    // alternate / __extern_get fallbacks. This shouldn't happen for
    // well-formed source code.
  }
  return PA_FALLTHROUGH;
}

export function trySuperAndImportMetaRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // Handle super.prop — access parent class property/getter on current `this`
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return compileSuperPropertyAccess(ctx, fctx, expr, propName);
  }

  // Handle import.meta.url and other import.meta properties
  if (
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expr.expression.name.text === "meta"
  ) {
    if (propName === "url") {
      // #1494 — Bind to the host's `import.meta.url` (passed by the generated
      // loader via deps.importMetaUrl). Falls back to undefined when no
      // loader is present.
      const funcIdx = ensureLateImport(ctx, "__get_import_meta_url", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      // Fallback when the host import couldn't be registered.
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    // For any other import.meta property, return undefined
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  return PA_FALLTHROUGH;
}

export function tryGlobalThisAndProcessRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // Handle globalThis.prop — compile as __extern_get(<globalThis>, key)
  // globalThis is a genuine JS object (externref), not a WasmGC struct.
  // Without this handler, the TS type `typeof globalThis` resolves to a struct
  // type and struct.get on a real JS object traps with null deref.
  //
  // (#2988) Receiver resolution is dual-mode:
  //   - host/gc: the `env::__get_globalThis` host import (unchanged).
  //   - standalone/WASI (no-JS-host): the native `globalThis` `$Object`
  //     singleton (#2996, `emitNativeGlobalThisObject`) — the SAME singleton that
  //     `Object.defineProperty(globalThis, k, desc)` and `globalThis.x = v`
  //     already write onto (both proven host-free), so reflective reads
  //     round-trip host-free. This retires the last `env::__get_globalThis`
  //     sole-import leak on the `globalThis.prop` member-read path. `__extern_get`
  //     itself is already a DEFINED native helper in these modes (routed via
  //     `ensureLateImport` → `ensureObjectRuntime`), so the read is fully
  //     host-free. If the native object runtime is unavailable, falls through to
  //     the host-import path.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "globalThis") {
    const nativeGlobal = ctx.standalone || ctx.wasi;
    // Import registration order is preserved for the host/gc path
    // (`__get_globalThis` then `__extern_get`, as it was before #2988) so that
    // path stays byte-identical. In standalone/WASI both names resolve to DEFINED
    // native helpers (no host import added, so ordering is immaterial), and the
    // `__extern_get` lookup also brings up the object runtime (incl.
    // `__new_plain_object`) that `emitNativeGlobalThisObject` needs.
    const gtFuncIdx = nativeGlobal ? undefined : ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);

    if (getIdx === undefined || (!nativeGlobal && gtFuncIdx === undefined)) {
      // Fallback: return null externref if imports couldn't be registered
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Emit: __extern_get(<globalThis receiver>, key) -> externref
    if (nativeGlobal) {
      const nativeVt = emitNativeGlobalThisObject(ctx, fctx);
      if (!nativeVt) {
        // Native runtime unavailable — fall back to the host import.
        const gt2 = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (gt2 === undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "call", funcIdx: gt2 });
      }
    } else {
      fctx.body.push({ op: "call", funcIdx: gtFuncIdx! });
    }
    addStringConstantGlobal(ctx, propName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Coerce externref to expected type
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const accessWasm = resolveWasmType(ctx, accessType);
    if (accessWasm.kind === "f64") {
      const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
      }
      return { kind: "f64" };
    }
    if (accessWasm.kind === "i32") {
      const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      return { kind: "i32" };
    }
    return { kind: "externref" };
  }

  // (#1490) Non-WASI Node.js host mode: process.argv / process.env / process.platform.
  // These are JS host imports that read from the live Node process at runtime.
  // The local `process` identifier must not be shadowed by a local variable.
  // In WASI mode, `process.env` is handled separately via WASI environ (#1482),
  // so this path is gated on !ctx.wasi.
  if (!ctx.wasi && ts.isIdentifier(expr.expression) && expr.expression.text === "process") {
    const isShadowed = fctx.localMap.has("process") || (fctx.boxedCaptures?.has("process") ?? false);
    if (!isShadowed) {
      const procProp = propName;
      let hostImport: string | undefined;
      if (procProp === "argv") hostImport = "__get_process_argv";
      else if (procProp === "env") hostImport = "__get_process_env";
      else if (procProp === "platform") hostImport = "__get_process_platform";
      else if (procProp === "arch") hostImport = "__get_process_arch";
      if (hostImport !== undefined) {
        const idx = ensureLateImport(ctx, hostImport, [], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (idx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: idx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        return { kind: "externref" };
      }
    }
  }
  return PA_FALLTHROUGH;
}

export function tryIdentifierNamespaceAndStaticReceiverRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): PADispatchResult {
  // Handle BuiltIn.prop where BuiltIn is a known global constructor/namespace (String, Number,
  // Boolean, Math, Object, Array, etc.) that would otherwise compile to ref.null.extern.
  // Examples: String.prototype, Number.prototype, Boolean.prototype, Math.abs, Array.isArray.
  // Use __get_builtin(name) to get the real JS object, then __extern_get(ref, prop).
  // Skip if the name is shadowed by a local variable.
  if (ts.isIdentifier(expr.expression)) {
    const builtinName = expr.expression.text;
    const isShadowed = fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false);
    // (#1888 S6-c) Under --target standalone, `__get_builtin` refuses-loud (the
    // open-object runtime does not expose it). For builtin constant reads that
    // already have a pure-Wasm fall-through emitter below (Math.PI →
    // `f64.const`, Number.MAX_SAFE_INTEGER → `f64.const`, Symbol.iterator →
    // `i32.const`), this shortcut would pre-empt that native lowering and turn a
    // compilable program into a hard refusal. Skip it for those (builtin, prop)
    // pairs so control reaches the constant emitter. gc/host is unaffected
    // (`__get_builtin` is a real host import there and the early shortcut +
    // the later constant handler are observationally identical for these reads).
    const deferToNativeConstant = ctx.standalone && hasNativeBuiltinConstantHandler(builtinName, propName);
    if (ctx.standalone && BUILTIN_CTOR_NAMES.has(builtinName) && !isShadowed && !deferToNativeConstant) {
      // (#2175 S1) `<Builtin>.prototype` as a value → the native `$NativeProto`
      // object (host-free), for builtins with a registered brand. This is the
      // inner read every reflective form (`RegExp.prototype.test`,
      // `.flags`-getter via descriptor, `[Symbol.match]`) chains off of — it
      // refused at this exact site pre-#2175. Reaches `emitLazyNativeProtoGet`
      // instead of the refusal.
      if (propName === "prototype") {
        const protoBrand = tryEnsureNativeProtoBrand(ctx, builtinName);
        if (protoBrand !== undefined && emitLazyNativeProtoGet(ctx, fctx, protoBrand)) {
          return { kind: "externref" };
        }
      }
      const closure = ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinName, propName, expr);
      if (closure) {
        // (#2963) IDENTITY-STABLE reified builtin value: read via a module-level
        // singleton so `Array.isArray === Array.isArray`, `Number.isInteger ===
        // Number.isInteger`, etc. hold (a fresh `struct.new` per read gave two
        // distinct instances → `!==`). Distinct builtins keep distinct singleton
        // globals, so `Array.isArray !== Number.isInteger` still holds.
        fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
        return closure.type;
      }
      reportUnsupportedStandaloneBuiltinValueRead(ctx, builtinName, propName);
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    if (BUILTIN_CTOR_NAMES.has(builtinName) && !isShadowed && !deferToNativeConstant) {
      const getBuiltinIdx = ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }]);
      const getIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (getBuiltinIdx !== undefined && getIdx !== undefined) {
        // Push builtin name string, call __get_builtin to get the real JS object
        addStringConstantGlobal(ctx, builtinName);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
        fctx.body.push({ op: "call", funcIdx: getBuiltinIdx });
        // Push property name string, call __extern_get to read the property
        addStringConstantGlobal(ctx, propName);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
        fctx.body.push({ op: "call", funcIdx: getIdx });
        return { kind: "externref" };
      }
    }
  }

  // Check for enum member access: EnumName.Member
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const enumKey = `${objName}.${propName}`;
    const enumVal = ctx.enumValues.get(enumKey);
    if (enumVal !== undefined) {
      fctx.body.push({ op: "f64.const", value: enumVal });
      return { kind: "f64" };
    }
    // Check for string enum member access
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) {
      return compileStringLiteral(ctx, fctx, enumStrVal);
    }

    // (#1639) `g.prototype` where `g` is a generator-function declaration must
    // return `%GeneratorPrototype%` (the object whose `next`/`return`/`throw`
    // carry the brand check). The compiled closure backing a `function*` is
    // opaque to the host, so resolve the member access statically here by
    // routing to a dedicated runtime import. Tests reach
    // `%AsyncIteratorPrototype%` via `getPrototypeOf(getPrototypeOf(g.prototype))`.
    if (propName === "prototype" && ctx.generatorFunctions.has(objName)) {
      const sym = ctx.checker.getSymbolAtLocation(expr.expression);
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      const isAsyncGen =
        !!decl &&
        (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl)) &&
        decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
      // (#3236 S1) Standalone sync generators route `genFn.prototype` to the
      // native `%GeneratorPrototype%` singleton (host-free) instead of leaking
      // `__get_generator_prototype`. Async generators keep the host import.
      if (!isAsyncGen && (ctx.standalone || ctx.wasi)) {
        const t = emitGeneratorPrototypeSingleton(ctx, fctx);
        if (t) return t;
      }
      const helperName = isAsyncGen ? "__get_async_generator_prototype" : "__get_generator_prototype";
      const helperIdx = ensureLateImport(ctx, helperName, [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (helperIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: helperIdx });
        return { kind: "externref" };
      }
      // Standalone mode (no host): fall through to legacy path.
    }
  }

  // Check for static property access via 'this' in a static method context.
  // In a static method, 'this' refers to the class constructor (no local 'this' param).
  // e.g., `this.#m` in `static fieldAccess()` where `#m` is a static private field.
  //
  // (#1681) Also fire inside a closure spawned from a static context: an arrow
  // function or inner function declared in a static method captures `this` as a
  // local, so `localMap.get("this")` is defined — but `this` still denotes the
  // class constructor, not a per-instance struct. Without the static-context
  // escape hatch the generic struct path below tries to cast the captured
  // externref `this` to the class struct and emits an invalid
  // `extern.convert_any` / re-enters the accessor trampoline (#1681 RUNFAIL
  // bucket). `fctx.isStaticContext` is propagated through closure spawning, so
  // it identifies exactly this case.
  // #2027: `(this as any).a` / `(this).a` in a static initializer must reach
  // this static-`this` arm too. The receiver is wrapped in an AsExpression /
  // ParenthesizedExpression, so match on the unwrapped form rather than the
  // literal `ThisKeyword` node kind. Plain `this.a` already matched.
  if (
    skipTransparentExpressions(expr.expression).kind === ts.SyntaxKind.ThisKeyword &&
    (fctx.localMap.get("this") === undefined || fctx.isStaticContext)
  ) {
    // Resolve the enclosing class name from context.
    // Try enclosingClassName first (set for closures), then scan the function name
    // for a class name prefix by checking each underscore-delimited prefix against classSet.
    // This handles both simple names ("C_method") and names like "__anonClass_0_method".
    let enclosingClass: string | undefined = fctx.enclosingClassName;
    if (!enclosingClass) {
      const fname = fctx.name;
      let pos = -1;
      while (!enclosingClass) {
        pos = fname.indexOf("_", pos + 1);
        if (pos < 0) break;
        const candidate = fname.substring(0, pos);
        if (candidate && ctx.classSet.has(candidate)) enclosingClass = candidate;
      }
    }
    if (enclosingClass) {
      const fullName = `${enclosingClass}_${propName}`;
      const globalIdx = ctx.staticProps.get(fullName);
      if (globalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: globalIdx });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        return globalDef?.type ?? { kind: "externref" };
      }
      // Static getter access: `this.#f` or `this.g` where the property is a
      // static accessor. Invoke the getter with a dummy `this` — static
      // getters don't read `this` since the backing store is a module global.
      // Without this handler the generic path below compiles `this` →
      // emitUndefined → externref and tries to cast to the class struct,
      // which traps uncatchably (PR #203 follow-up for class/elements TRAP
      // bucket).
      const accessorKey = `${enclosingClass}_${propName}`;
      if (ctx.staticAccessorSet.has(accessorKey)) {
        const getterName = `${enclosingClass}_get_${propName}`;
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
        if (funcIdx !== undefined) {
          const retType = emitGetterCallWithDummy(ctx, fctx, enclosingClass, getterName, funcIdx);
          if (retType) return retType;
        }
      }
      // Static method accessed as value: `this.#m` or `this.m` where `m` is a
      // static method. Return `ref.null.extern` as a non-callable placeholder
      // (same as ClassName.method path at line 992) — avoids generic
      // fallthrough cast of undefined.
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }
  }

  // Check for static property access: ClassName.staticProp
  // #2020: unwrap outer expressions so `(B as any).count` / `(B).count` still
  // resolve the receiver to the class identifier `B`. A cast to `any` otherwise
  // hides the Identifier and the static-field lookup (incl. the inherited-field
  // parent walk below) is skipped, falling through to the dynamic any path.
  const staticReceiver = skipTransparentExpressions(expr.expression);
  if (ts.isIdentifier(staticReceiver)) {
    const objName = staticReceiver.text;

    // (#1639) `genFn.prototype` where `genFn` is a `function*` / `async function*`
    // declaration must return the intrinsic `%GeneratorPrototype%` /
    // `%AsyncGeneratorPrototype%` (= `%GeneratorFunction.prototype%.prototype`).
    // The compiled closure backing the generator is opaque to the host, so we
    // route the member access through a dedicated runtime import — mirroring the
    // `Object.getPrototypeOf(genFn)` handling in calls.ts. Tests rely on the
    // resulting chain: `Object.getPrototypeOf(Object.getPrototypeOf(g.prototype))`
    // === `%(Async)IteratorPrototype%`.
    if (propName === "prototype" && ctx.generatorFunctions.has(objName)) {
      let isAsyncGen = false;
      const sym = ctx.checker.getSymbolAtLocation(expr.expression);
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (decl && (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl))) {
        isAsyncGen = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
      }
      // (#3236 S1) Standalone sync generators route `genFn.prototype` to the
      // native `%GeneratorPrototype%` singleton (host-free) instead of leaking
      // `__get_generator_prototype`. Async generators keep the host import.
      if (!isAsyncGen && (ctx.standalone || ctx.wasi)) {
        const t = emitGeneratorPrototypeSingleton(ctx, fctx);
        if (t) return t;
      }
      const helperName = isAsyncGen ? "__get_async_generator_prototype" : "__get_generator_prototype";
      const helperIdx = ensureLateImport(ctx, helperName, [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (helperIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: helperIdx });
        return { kind: "externref" };
      }
      // Standalone mode (no host import): fall through to legacy handling.
    }

    // Resolve class expressions (var C = class {}) through the expr-name map
    const resolvedClass = ctx.classExprNameMap.get(objName) ?? objName;
    if (ctx.classSet.has(resolvedClass)) {
      const fullName = `${resolvedClass}_${propName}`;
      // #2020: static fields are inherited. `class B extends A {}; B.count`
      // resolves to A's `A_count` global. The own-class lookup misses, so walk
      // the parent chain (classParentMap) retrying `<Ancestor>_<prop>` — own
      // statics still shadow because the own lookup runs first.
      const globalIdx = ctx.staticProps.get(fullName) ?? resolveInheritedStaticProp(ctx, resolvedClass, propName);
      if (globalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: globalIdx });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        return globalDef?.type ?? { kind: "f64" };
      }
      // ClassName.prototype — return a singleton prototype global (externref)
      // so that Object.getPrototypeOf(instance) === ClassName.prototype holds.
      if (propName === "prototype") {
        if (emitLazyProtoGet(ctx, fctx, resolvedClass)) {
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // ClassName.constructor — return the constructor function reference.
      // (#3024) A class may declare a STATIC method literally named
      // `constructor` (`static * constructor() {}` — legal, distinct from the
      // instance constructor; the `grammar-static-ctor-*-meth-valid` test262
      // family). `C.constructor` then reads that static method as a value and
      // must be boxed like any other static method (a closure struct →
      // `extern.convert_any`, the arm below). The legacy raw path here emitted
      // `ref.func <C_constructor>` + `extern.convert_any` — but a funcref is
      // NOT in the anyref hierarchy, so `extern.convert_any` on it is invalid
      // Wasm (`call[N] expected externref, found ref.func of (ref M)`). Skip
      // the raw path when a static method owns the name, letting the
      // static-method closure arm below handle it correctly.
      if (propName === "constructor" && !ctx.staticMethodSet.has(fullName)) {
        const ctorName = `${resolvedClass}_constructor`;
        const funcIdx = ctx.funcMap.get(ctorName);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.func", funcIdx });
          fctx.body.push({ op: "extern.convert_any" });
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // ClassName.staticMethod — return a callable closure-struct externref.
      //
      // (#1388) Previously emitted `ref.null.extern` because funcref isn't a
      // subtype of anyref. Now we wrap the static method in a closure struct
      // (struct.new with a funcref field) via `emitFuncRefAsClosure`, then
      // convert the struct ref to externref with `extern.convert_any`.
      //
      // The call site (calls.ts:5380) sees a callable variable, casts the
      // externref back to the matching closure struct type, and dispatches
      // via `call_ref` through a trampoline. This makes the detached pattern
      // `const gen = C.staticMethod; gen()` actually invoke the method,
      // unblocking 273 test262 cases for class async-generator yield-star
      // tests that follow this exact extraction pattern.
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
        if (funcIdx !== undefined) {
          const closureRef = emitFuncRefAsClosure(ctx, fctx, fullName, funcIdx);
          if (closureRef) {
            fctx.body.push({ op: "extern.convert_any" });
            return { kind: "externref" };
          }
          // Fallback if closure construction fails for any reason
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
      // Instance method accessed as `ClassName.method` (without prototype) —
      // unusual; keep the legacy null placeholder to preserve existing behavior.
      if (ctx.classMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
      // ClassName.accessor — invoke static getter (#848)
      const accessorKey = `${resolvedClass}_${propName}`;
      if (ctx.classAccessorSet.has(accessorKey)) {
        const getterName = `${resolvedClass}_get_${propName}`;
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName));
        if (funcIdx !== undefined) {
          const retType = emitGetterCallWithDummy(ctx, fctx, resolvedClass, getterName, funcIdx);
          return retType ?? { kind: "externref" };
        }
      }
    }
  }
  return PA_FALLTHROUGH;
}

// <<PA_DISPATCH_HELPERS>>
