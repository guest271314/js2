// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Call expression compilation: direct calls, optional calls, closure calls,
 * property method calls, IIFEs, and conditional callees.
 */
import { ts, forEachChild } from "../../ts-api.js";
import {
  isBigIntType,
  isBooleanType,
  isBooleanWrapperType,
  isExternalDeclaredClass,
  isGeneratorType,
  isNumberType,
  isNumberWrapperType,
  isPromiseType,
  isStringType,
  isStringWrapperType,
  isSymbolType,
  isVoidType,
} from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { compileArrayMethodCall, compileArrayPrototypeCall, resolveArrayInfo } from "../array-methods.js";
import { emitGlobalThisGopdFold } from "../dyn-read.js"; // (#2984)
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S3b) stable-regime minting
import { emitCollectionIteratorVec, ensureMapGroupBy } from "../map-runtime.js"; // (#42) native Set/Map → vec, shared with spread / Array.from; (#3149) native Map.groupBy
import { isCollectionReflectiveCallShape, tryCompileCollectionReflectiveCall } from "../collections-brand.js"; // (#2604/#3171) {Map,Set,WeakMap,WeakSet}.prototype.METHOD.call brand-check
import { classMemberFuncKey, fnctorAncestorOfClass } from "../class-member-keys.js"; // (#1983 / #3123)
import {
  ensureIterStepScratchGlobal,
  ensureNativeArrayFromMapped,
  ensureNativeIteratorRuntime,
} from "../iterator-native.js"; // (#2169c) native Array.from drain / (#3146) Iterator-statics intrinsics / (#3206) native Array.from(src, mapFn)
import { reserveClosedMethodDispatch, reserveClosedMethodDispatchVararg } from "../closed-method-dispatch.js";
import { emitNativeDateParse } from "../date-parse-native.js"; // (#2164) pure-Wasm Date.parse / new Date(str)
import { NATIVE_HOF_METHODS } from "../hof-native.js";
import { ensureTaMapFilterHelper } from "../ta-hof-map-filter.js";
import { LAZY_ITER_METHODS } from "../iter-lazy-native.js"; // (#2903 R3b) flatMap closure-path exemption
import {
  ensureObjVecBuilders,
  ensureObjectGroupBy,
  ensureObjectRuntime,
  reserveApplyClosure,
  reserveBindDynHelper,
} from "../object-runtime.js";
import { ensureStringRawHelper } from "../string-raw.js"; // (#3147)
import {
  emitMicrotaskEnqueue,
  emitStandalonePromiseFinally,
  emitStandalonePromiseReject,
  emitStandalonePromiseResolve,
  emitStandalonePromiseThen,
  emitStdinAvailable,
  emitStdinEof,
  emitStdinReadByte,
  emitStdinSetReader,
  emitStdinStop,
  emitTimerAdd,
  emitTimerCallbackWrapper,
  emitTimerCancel,
  ensurePromiseSettleFunctions,
  ensureTimerHeap,
  getDrainFuncIdxForWasiStart,
  getOrRegisterPromiseType,
  getRunLoopNowFuncIdx,
  isStandalonePromiseActive,
  isStandaloneThenChainNativeActive,
  isStdinReactorActive,
  type StandalonePromiseThenCallback,
} from "../async-scheduler.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileArrowAsClosure,
  compileArrowFunction,
  computeClosureWrapperSig,
  getFuncRefWrapperRootTypeIdx,
  getFuncSignature,
  getOrCreateFuncRefWrapperTypes,
} from "../closures.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "../context/speculative.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  ensureExnTag,
  ensureI32Condition,
  getArrTypeIdxFromVec,
  getOrRegisterBoundFnType,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  nativeStringType,
  reserveVecMethodHelper,
  resolveWasmType,
  STRING_METHODS,
  TYPED_ARRAY_NAMES,
  typedArrayVecStorage,
} from "../index.js";
import {
  compileArrayConstructorCall,
  compileObjectLiteralAsExternref,
  compileSymbolCall,
  objectLiteralTakesStandaloneAnyObjectPath,
  resolveComputedKeyExpression,
  resolvePropertyNameText,
} from "../literals.js";
import {
  jsonGapFromStaticSpace,
  staticSpaceValue,
  tryEmitJsonParseLiteral,
  tryEmitJsonStringifyStatic,
} from "../json-standalone.js";
import { emitJsonParsePrimitive, emitJsonQuoteString } from "../json-runtime.js";
import {
  emitJsonParseText,
  emitJsonParseTextReviver,
  emitJsonStringifyValue,
  emitJsonRawJson,
  emitJsonIsRawJson,
} from "../json-codec-native.js";
import {
  compileObjectDefineProperties,
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
  emitDefinePropertyDescRuntime,
  emitNonObjectArgGuard,
} from "../object-ops.js";
import {
  BUILTIN_CTOR_NAMES,
  emitArrayIsArrayExternrefPredicate,
  emitNullCheckThrow,
  receiverIsCaughtErrorStringRead,
  receiverIsNativeStringValType,
  receiverMayBeNativeStringAtRuntime,
  tryEnsureNativeProtoBrand,
  typeErrorThrowInstrs,
} from "../property-access.js";
import { emitToNumber, emitToString } from "../coercion-engine.js";
import type { InnerResult } from "../shared.js";
import {
  brandExternMethodResult,
  coerceType,
  compileExpression,
  resolveThisStructName,
  valTypesMatch,
  VOID_RESULT,
} from "../shared.js";
// (#2193 PR-B) reflective `m.call(thisArg, …)` on a `$NativeProto` member-closure value.
import {
  ensureArrayNativeProtoGlue,
  ensureDataViewNativeProtoGlue,
  ensureDateNativeProtoGlue,
  ensureObjectNativeProtoGlue,
  ensureStringNativeProtoGlue,
  ensureGeneratorPrototypeNativeProtoGlue,
  emitTypedArrayIntrinsicCtorObject,
  emitArrayIteratorPrototypeSingleton,
  emitGeneratorFunctionPrototypeSingleton,
  emitGeneratorPrototypeSingleton,
  emitFunctionPrototypeObjectSingleton,
  isWiredTypedArrayViewName,
} from "../array-object-proto.js";
import {
  emitBrandCheckTypeError,
  ensureStandaloneNativeMethodClosure,
  getNativeProtoBuiltinGlue,
} from "../native-proto.js";
import { BUILTIN_STATIC_METHOD_ARITY, pushBuiltinFnSingletonValueInstrs } from "../builtin-fn-meta.js";
import {
  isSymbolSpeciesKeyExpression,
  resolveBuiltinReceiverName,
  tryEmitStandaloneBuiltinSpeciesGopd,
  tryEmitStandaloneBuiltinStaticGopd,
  tryEmitStandaloneStructGopdKeyDispatch,
} from "../builtin-static-gopd.js"; // (#2984 Phase 3 + bucket-1 alias receivers + arg-2 name coercion + @@species)
import { compileStatement, hoistFunctionDeclarations } from "../statements.js";
import {
  emitSetExtrasArgv,
  ensureArgcGlobal,
  ensureExtrasArgvGlobal,
  maybeSetArgcForKnownCall,
} from "../statements/nested-declarations.js";
import {
  compileGuardedNativeStringMethodCall,
  compileNativeStringMethodCall,
  compileStringLiteral,
  emitBoolToString,
  emitBorrowedStringReceiverToString,
  isStaticUndefinedArg,
} from "../string-ops.js";
import { tryCompileNodeFsCall, tryCompileNodeProcessCall } from "../node-fs-api.js";
import { tryCompileDenoStdioCall } from "../deno-api.js";
import { tryCompileRawWasiCall } from "../raw-wasi-api.js";
import { resolvePromiseSubclassName, tryEmitPromiseSubclassReceiver } from "./promise-subclass.js";
import {
  emitStandalonePromiseCombinator,
  emitStandalonePromiseCombinatorRuntime,
  ensureCombinatorFunctions,
  ensureCombinatorToVec,
  isNativeCombinatorMethod,
  resolveExternrefVecArg,
  type NativeCombinator,
} from "../promise-combinators.js";
import { emitWasiErrorConstructor } from "../registry/error-types.js"; // (#2922) native TypeError for not-iterable reject
import { isSupportedBuiltinStaticProperty, resolveBuiltinNamespaceValueName } from "../builtin-static-globals.js";
import {
  defaultValueInstrs,
  emitGuardedFuncRefCast,
  emitGuardedRefCast,
  pushDefaultValue,
  pushParamSentinel,
} from "../type-coercion.js";
import {
  compileConsoleCall,
  compileDateMethodCall,
  compileMathCall,
  ensureDateDaysFromCivilHelper,
  wasiAllocStringData,
} from "./builtins.js";
import { tryCompileTemporalMethodCall, tryCompileTemporalStaticCall } from "../temporal-native.js";
import {
  compileCallableElementAccessCall,
  compileCallablePropertyCall,
  compileClosureCall,
  compileGetterCallable,
  compileObjectPrototypeFallback,
  tryExternClassMethodOnAny,
} from "./calls-closures.js";
import { compileOptionalCallExpression } from "./calls-optional.js";
import { isFunctionCtorImmediateCall, tryStaticEvalInline, tryStaticFunctionCtorCall } from "./eval-inline.js";
import { compileExternMethodCall, compileSpreadCallArgs, emitLazyProtoGet } from "./extern.js";
import {
  compileStandaloneRegExpConstructor,
  emitStandaloneRegExpToStringFromExpr,
  isGlobalRegExpIdentifier,
  tryCompileStandaloneRegExpExec,
  tryCompileStandaloneRegExpSymbolCall,
  tryCompileStandaloneRegExpTest,
  tryCompileStandaloneRegExpToString,
} from "../regexp-standalone.js";
import {
  buildThrowJsErrorInstrs,
  emitThrowRangeError,
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import {
  tryJsxRuntimeCall,
  tryNamespaceNonCallable,
  tryObjectCoercionCall,
  tryRegExpConstructorCall,
} from "./calls-guards.js";
import { analyzeTdzAccessByPos, emitLocalTdzCheck, emitStaticTdzThrow } from "./identifiers.js";
import {
  emitUndefined,
  ensureGetUndefined,
  ensureLateImport,
  flushLateImportShifts,
  shiftLateImportIndices,
} from "./late-imports.js";
import { undefinedExternInstrs } from "../any-helpers.js";
import { emitSymbolToString, ensureSymbolRegistry } from "../symbol-native.js";
import { resolveStructName } from "./misc.js";
import { compileSuperElementMethodCall, compileSuperMethodCall } from "./new-super.js";
import { compileIdentifierCall } from "./call-identifier.js";
import { compileBuiltinStaticCall } from "./call-builtin-static.js";
import {
  emitNativeGeneratorToVec,
  nativeGeneratorInfoForForOfSubject,
  tryCompileNativeGeneratorMethodCall,
} from "../generators-native.js";
import {
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  ensureStrToCharVecHelper,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "../native-strings.js";
import { ensureTextEncodingHelpers } from "../text-encoding-native.js";
import { emitVariadicStringConcat, hostStringRepr, nativeStringRepr } from "../builtin-scaffold.js";
import { URI_DECODE_MASK, URI_ENCODE_MASK } from "../uri-encoding-native.js";
import {
  emitArrayBufferResize,
  emitArrayBufferSlice,
  emitDataViewAccessor,
  ensureDvAccessorHelper,
  ensureTaDynCopyWithinHelper,
  ensureTaDynFillHelper,
  ensureTaDynReverseHelper,
  getOrRegisterDvWindowType,
  isDataViewAccessor,
} from "../dataview-native.js";
import {
  getLinearU8Buffer,
  getLinearU8ParamIndicesForCall,
  sourceParamCountFromExpanded,
  wasmParamIndexForSourceParam,
} from "../linear-uint8-signatures.js";

/**
 * Known built-in global class/object names that compile to ref.null.extern
 * via compileIdentifier's graceful fallback. These need __get_builtin to
 * resolve the real JS object for host-delegated calls (method dispatch,
 * getOwnPropertyDescriptor, etc.).
 */
export const BUILTIN_CLASS_NAMES = new Set([
  "Object",
  "Array",
  "Function",
  "Symbol",
  "Proxy",
  "Reflect",
  "Math",
  "BigInt",
  "JSON",
  "Date",
  "RegExp",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Promise",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Atomics",
  "Iterator",
  "Map",
  "Set",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "String",
  "Number",
  "Boolean",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * (#2631) Path-based node:fs functions that require a filesystem (path_open /
 * preopens). Distinct from the fd-based synchronous primitives readSync /
 * writeSync (no path). Under --target wasi these are rejected — standalone WASI
 * has no filesystem. `writeFileSync` is intentionally excluded: it has a
 * dedicated WASI lowering above (`__wasi_write_file_sync`).
 */
export const PATH_BASED_FS_FNS = new Set([
  "readFileSync",
  "readFile",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "openSync",
  "open",
  "unlinkSync",
  "unlink",
  "mkdirSync",
  "mkdir",
  "readdirSync",
  "readdir",
  "statSync",
  "stat",
  "existsSync",
]);

/**
 * (#2501) Does `argExpr` denote a value that may be a **Proxy**? A proxy's
 * §20.1.3.6 tag can't be classified statically: `IsArray` (step 4) unwraps the
 * proxy to its target and, for a *revoked* proxy, throws TypeError (§7.2.2 step
 * 3a) — so a static tag is both potentially wrong (the TS type is the *target's*
 * type, e.g. `Proxy.revocable([], …).proxy` types as `never[]`) and unsound (it
 * can't throw). The host's real `Object.prototype.toString` gets every proxy
 * case right (unwrap-to-target, revoked → throw), so the classifier must defer
 * to it. Proxies carry no TS-type brand (`new Proxy(t, h)` types identically to
 * `t`), so detection is purely syntactic on the receiver's provenance:
 *   - `new Proxy(...)` directly,
 *   - `Proxy.revocable(...).proxy`,
 *   - an identifier whose initializer is (transitively) either of the above
 *     (`var p = new Proxy([], {}); …call(p)` / `var pp = new Proxy(p, {})`).
 */
function receiverMayBeProxy(ctx: CodegenContext, argExpr: ts.Expression): boolean {
  const isNewProxy = (node: ts.Expression): boolean =>
    ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy";

  // `Proxy.revocable(...).proxy` — the `.proxy` member of a revocable handle.
  const isRevocableProxyAccess = (node: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "proxy") return false;
    const recv = node.expression;
    return (
      ts.isCallExpression(recv) &&
      ts.isPropertyAccessExpression(recv.expression) &&
      recv.expression.name.text === "revocable" &&
      ts.isIdentifier(recv.expression.expression) &&
      recv.expression.expression.text === "Proxy"
    );
  };

  // `handle.proxy` where `handle = Proxy.revocable(...)` (the revocable result is
  // bound to a variable first — the common test262 shape).
  const isRevocableHandleProxyAccess = (node: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "proxy") return false;
    const recv = node.expression;
    if (!ts.isIdentifier(recv)) return false;
    const sym = ctx.checker.getSymbolAtLocation(recv);
    const decl = sym?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    const init = decl.initializer;
    return (
      ts.isCallExpression(init) &&
      ts.isPropertyAccessExpression(init.expression) &&
      init.expression.name.text === "revocable" &&
      ts.isIdentifier(init.expression.expression) &&
      init.expression.expression.text === "Proxy"
    );
  };

  const exprIsProxy = (node: ts.Expression): boolean => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    return isNewProxy(inner) || isRevocableProxyAccess(inner) || isRevocableHandleProxyAccess(inner);
  };

  if (exprIsProxy(argExpr)) return true;

  // Identifier bound to a proxy (transitively): `var p = new Proxy(t, h)` then
  // `…call(p)`, including the proxy-of-proxy chain `var pp = new Proxy(p, {})`.
  if (ts.isIdentifier(argExpr)) {
    const sym = ctx.checker.getSymbolAtLocation(argExpr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && exprIsProxy(decl.initializer)) {
      return true;
    }
  }
  return false;
}

/**
 * (#3031) Per-source-file syntactic gate for the standalone Proxy [[Call]] arm:
 * does this file contain `new Proxy(...)` or a `Proxy.revocable(...)` call?
 * Cached per SourceFile (WeakMap). This complements the "`__proxy_create`
 * already registered" check in `tryEmitInlineDynamicCall`: a dynamic call site
 * can compile BEFORE the same file's `new Proxy` site (the #2754
 * registration-order class), while a proxy compiled in an earlier file is
 * caught by the funcMap check. A proxy has no TS-type brand
 * (`project_proxy_no_ts_type_brand`), so the gate is syntactic by design.
 */
const sourceCreatesProxyCache = new WeakMap<ts.SourceFile, boolean>();

/**
 * (#3140) True when the source contains any `<expr>.bind(...)` call — a
 * `$__bound_fn` carrier may then exist at runtime, so the dynamic-call
 * dispatch must carry the unwrap arm even when the bind SITE compiles after
 * this call site (compile-order independence; mirrors `sourceCreatesProxy`).
 */
const sourceHasBindCallCache = new WeakMap<ts.SourceFile, boolean>();
function sourceHasBindCall(sf: ts.SourceFile): boolean {
  const cached = sourceHasBindCallCache.get(sf);
  if (cached !== undefined) return cached;
  let found = false;
  if (sf.text.includes(".bind(")) {
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "bind"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  sourceHasBindCallCache.set(sf, found);
  return found;
}
function sourceCreatesProxy(sf: ts.SourceFile): boolean {
  const cached = sourceCreatesProxyCache.get(sf);
  if (cached !== undefined) return cached;
  let found = false;
  // Cheap text pre-filter before the AST walk.
  if (sf.text.includes("Proxy")) {
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy") {
        found = true;
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "revocable" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Proxy"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  sourceCreatesProxyCache.set(sf, found);
  return found;
}

/**
 * (#2501) Resolve the §20.1.3.6 `Object.prototype.toString` builtin tag for a
 * statically-known receiver, returning the tag name (e.g. "Array", "Date") or
 * `undefined` when it can't be classified (caller falls back / refuses).
 *
 * Order follows §20.1.3.6 steps 2-14 (the Symbol.toStringTag override of step
 * 15 is a deferred phase-2 — needs dynamic @@toStringTag property lookup):
 *   undefined → Undefined · null → Null · isArray → Array · callable → Function
 *   · Error → Error · Boolean/Number/String primitive → that tag · Date → Date
 *   · RegExp → RegExp · arguments exotic → Arguments · else → Object.
 */
function resolveObjectToStringTag(ctx: CodegenContext, argExpr: ts.Expression | undefined): string | undefined {
  if (argExpr === undefined) return "Undefined"; // toString.call() with no arg → this=undefined
  // Literal null / undefined keywords.
  if (argExpr.kind === ts.SyntaxKind.NullKeyword) return "Null";
  if (argExpr.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(argExpr) && argExpr.text === "undefined")) {
    return "Undefined";
  }

  // (#2501) IMPORTANT — in **host mode** only return a static tag when we are
  // *certain* it matches §20.1.3.6, and otherwise bail (return undefined) so the
  // caller falls through to the host `__proto_method_call` path, whose real
  // `Object.prototype.toString` already gets every remaining case right
  // (primitives, primitive-wrapper objects, plain objects, `.prototype`
  // objects, and @@toStringTag (step 14/15) objects like JSON / Math). The
  // earlier broad classifier MIS-tagged all of those (`Object([])` /
  // `Object(5)` / `new Number(5)` → [object Object]; `TypeError.prototype` →
  // [object Error]; `JSON` → [object Object]), regressing 35 test262 files.
  //
  // So host mode restricts the static path to exactly the receivers the host
  // gets WRONG — the ones whose underlying Wasm value (a GC vec/struct/closure)
  // is opaque to the host's `Object.prototype.toString`: genuine arrays,
  // callable functions, the `arguments` exotic, and Date/RegExp/Error
  // *instances*. Everything else returns undefined → host fall-through.
  //
  // **Standalone mode** has no host to fall through to (the borrowed `.call`
  // form is otherwise a hard compile error there), so for the would-defer
  // cases it returns the best-available *static* tag instead of undefined:
  // plain objects / primitive wrappers → the §20.1.3.6 step-2-14 builtin tag
  // (the deferred @@toStringTag step-15 override is no worse than the pre-#2501
  // CE). `deferOrStandalone(fallback)` encodes that: host → undefined,
  // standalone → fallback.
  const deferOrStandalone = (fallback: string | undefined): string | undefined =>
    ctx.standalone ? fallback : undefined;

  // Proxy receivers — never static-classify. The §20.1.3.6 tag of a proxy is
  // resolved through `IsArray`, which unwraps to the proxy target and throws
  // TypeError for a *revoked* proxy (§7.2.2 step 3a). The TS type reflects the
  // *target* (a `Proxy.revocable([], …).proxy` types as `never[]`, so the broad
  // array branch below would mis-emit a constant `[object Array]` that can never
  // throw — regressing `proxy-revoked.js`). Defer to the host, which unwraps the
  // proxy and throws on the revoked case correctly. (Standalone has no proxy
  // runtime, so `undefined` → refuse-loud, no worse than the pre-#2501 CE.)
  if (receiverMayBeProxy(ctx, argExpr)) return deferOrStandalone(undefined);

  // Receiver forms that defeat static classification — the spec tag depends on
  // an internal slot the TS type can't reveal. Handle / bail explicitly:
  //   - `Object(x)` ToObject-boxing → §7.1.18: ToObject of a primitive yields
  //     the matching wrapper, ToObject of an object returns it unchanged. So
  //     the §20.1.3.6 tag of `Object(x)` is exactly the tag of `x`. Recurse on
  //     the inner expr (Object([]) → Array, Object(5) → host-defer Number).
  //   - `X.prototype` → a builtin prototype is an ordinary object with NO
  //     [[ErrorData]]/[[Call]] slot, so it is [object Object], not the parent's
  //     tag (TypeError.prototype → Object, Function.prototype → Function — but
  //     the host resolves both precisely, so defer rather than risk a mis-tag).
  if (ts.isCallExpression(argExpr) && ts.isIdentifier(argExpr.expression) && argExpr.expression.text === "Object") {
    return argExpr.arguments.length >= 1 ? resolveObjectToStringTag(ctx, argExpr.arguments[0]) : "Object";
  }
  if (ts.isPropertyAccessExpression(argExpr) && argExpr.name.text === "prototype") {
    return deferOrStandalone("Object");
  }

  const t = ctx.checker.getTypeAtLocation(argExpr);
  const nn = ctx.checker.getNonNullableType(t);
  // null / undefined via the type system (e.g. a `null`-typed binding).
  if ((t.flags & ts.TypeFlags.Null) !== 0) return "Null";
  if ((t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return "Undefined";

  const symName = nn.getSymbol()?.name;

  // (#2597) §23.2.3.38 — `%TypedArray%.prototype[@@toStringTag]` is the typed
  // array's constructor name (`"Int32Array"`, …). §25.x give DataView /
  // ArrayBuffer / SharedArrayBuffer. These receivers are opaque Wasm structs, so
  // the host's `Object.prototype.toString` ALSO mis-tags them — return the static
  // tag unconditionally (correct in BOTH host and standalone), not via
  // `deferOrStandalone`. MUST precede the `resolveArrayInfo` "Array" arm below:
  // a typed array is array-like to that resolver, so without this it would mis-tag
  // `[object Array]` instead of `[object Int32Array]`. `.prototype` of a typed
  // array was filtered earlier (no [[TypedArrayName]] slot → `[object Object]`).
  if (symName !== undefined && TYPED_ARRAY_NAMES.has(symName)) return symName;
  if (symName === "BigInt64Array" || symName === "BigUint64Array") return symName;
  if (symName === "DataView") return "DataView";
  if (symName === "ArrayBuffer") return "ArrayBuffer";
  if (symName === "SharedArrayBuffer") return "SharedArrayBuffer";

  // Array (real `__vec_`/`__arr_` arrays, via the established resolver) — the
  // host sees an opaque GC vec and mis-tags it [object Object].
  if (resolveArrayInfo(ctx, nn)) return "Array";

  // Primitive-wrapper *objects* (`new Number(5)` / `new Boolean(true)` /
  // `new String("")`) box to the corresponding tag, but the host already
  // resolves them correctly — and the static type is unreliable here (one
  // resolves via isStringType, the others fall through). Defer to the host
  // (standalone → emit the matching wrapper tag, the best static answer).
  if (symName === "Number") return deferOrStandalone("Number");
  if (symName === "Boolean") return deferOrStandalone("Boolean");
  if (symName === "String") return deferOrStandalone("String");

  // Named builtin exotic *instances* the host mis-tags (opaque Wasm receiver):
  // Date / RegExp / Error(+subclasses) / arguments. `.prototype` of these was
  // already filtered above, so a match here is a real instance.
  if (symName === "Date") return "Date";
  if (symName === "RegExp") return "RegExp";
  if (symName === "Error" || symName?.endsWith("Error")) return "Error";
  if (symName === "IArguments" || symName === "Arguments") return "Arguments";

  // Callable (function) — has call signatures. The host sees an opaque Wasm
  // closure receiver and mis-tags it [object Object].
  const callSigs = nn.getCallSignatures?.();
  if (callSigs && callSigs.length > 0) return "Function";

  // Bare primitives (string / number / boolean *types*, not wrapper objects) →
  // §20.1.3.6 boxes them to the matching wrapper tag. Host resolves this
  // precisely; standalone emits the static tag.
  if (isStringType(nn)) return deferOrStandalone("String");
  if (isNumberType(nn)) return deferOrStandalone("Number");
  if (isBooleanType(nn)) return deferOrStandalone("Boolean");

  // Everything else (plain objects, class instances, @@toStringTag objects,
  // unresolved shapes). Host → defer so it computes the spec-correct tag
  // including the step-14/15 @@toStringTag override. Standalone → emit the
  // §20.1.3.6 step-13 default "Object" for object-shaped receivers (no host
  // @@toStringTag resolution exists there yet; still better than a hard CE),
  // else give up (undefined → caller's standalone refuse-loud path).
  const wasm = resolveWasmType(ctx, nn);
  if (wasm.kind === "ref" || wasm.kind === "ref_null" || wasm.kind === "externref") return deferOrStandalone("Object");
  if ((nn.flags & ts.TypeFlags.Object) !== 0) return deferOrStandalone("Object");
  return undefined;
}

/**
 * Statically evaluate `ToBoolean(expr)` for descriptor flag literals.
 * Per §6.2.6 ToPropertyDescriptor each attribute flag is ToBoolean-coerced —
 * `configurable: 123` / `'x'` / `{}` / `[]` are all truthy. Used by the
 * Object.create/defineProperties static-expansion fast path so the emitted
 * descriptor flags reflect the spec rather than degrading every non-`true`
 * literal to `false`. Returns `undefined` when the value isn't statically
 * resolvable (caller should fall back to the runtime path).
 */
/**
 * (#2076) Compile an `Object.assign(target, ...sources)` argument, pushing an
 * externref onto the stack. Under `--target standalone`, the native
 * `__object_assign` reads each operand by `ref.test $Object` and iterates its
 * `$PropEntry` table; a *closed-struct* literal fails that test, so its
 * properties are silently dropped and `Object.keys` on the result sees nothing
 * (the bug). The struct path is what `compileObjectLiteral` picks for a literal
 * argument whose TS contextual type — here `Object.assign`'s generic signature
 * resolves it to a CONCRETE object type, not `any` — so the open-`$Object`
 * diversion (literals.ts) never fires.
 *
 * Fix: when the argument is a *plain data-property / spread* object literal
 * (no accessors, methods, or computed/symbol keys — the same shapes the
 * `$Object` builder accepts at literals.ts:870-874), build it directly as a
 * native `$Object` via `compileObjectLiteralAsExternref` so `__object_assign`
 * recognises it. Any other argument (identifiers, calls, accessor-bearing
 * literals) keeps the ordinary `compileExpression` path. Standalone-only — host
 * / WASI mode owns the `__object_assign` JS import and is untouched.
 */
export function compileObjectAssignArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  if (
    ctx.standalone &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.length > 0 &&
    arg.properties.every(
      (p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p),
    ) &&
    arg.properties.every((p) => ts.isSpreadAssignment(p) || resolvePropertyNameText(ctx, p) !== undefined)
  ) {
    const objResult = compileObjectLiteralAsExternref(ctx, fctx, arg);
    if (objResult) {
      if (objResult.kind !== "externref") coerceType(ctx, fctx, objResult, { kind: "externref" });
      return;
    }
    // fall through to the ordinary path if the $Object builder declined.
  }
  const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
}

/**
 * #2580 M3 Stage A — compile a `[[Prototype]]` argument (the proto operand of
 * `Object.create(proto)` / `Object.setPrototypeOf(obj, proto)`) so that an
 * INLINE OBJECT LITERAL proto is built as a native `$Object`, pushing an
 * externref onto the stack.
 *
 * Root cause (standalone): the native `__object_create` / `__object_setPrototypeOf`
 * helpers write the link field `$Object.$proto` only when the proto value
 * `ref.test $Object` succeeds (a non-`$Object` externref coerces to null, by
 * design — see object-runtime.ts `__object_create`/`__object_setPrototypeOf`).
 * `compileObjectLiteral` lowers an inline literal whose TS contextual type is a
 * CONCRETE object type (not `any`) to a CLOSED-shape struct (`struct.new <typeIdx>`),
 * which fails `ref.test $Object`. So `Object.create({foo:7}).foo` and
 * `Object.setPrototypeOf(o,{foo:7}); o.foo` silently lose the proto link (the
 * chain walk reads a null `$proto` → property absent → 0). A proto passed via a
 * `const p:any = {foo:7}` *named variable* already works because the `any`
 * annotation diverts that literal to the open-`$Object` builder (literals.ts).
 *
 * Fix mirrors the merged #2076 `compileObjectAssignArg` precedent: when the proto
 * is a plain data-property / spread object literal (the same shapes the `$Object`
 * builder accepts), build it directly as a native `$Object` via
 * `compileObjectLiteralAsExternref` so `ref.test $Object` succeeds and the link
 * is recorded. Any other proto expression (identifiers, calls, `null`,
 * `Foo.prototype`, accessor-bearing literals) keeps the ordinary
 * `compileExpression` path unchanged. Standalone-only — host/GC mode owns the
 * `__object_create` JS import and a separate (still-broken, tracked) proto-link
 * mechanism, untouched here.
 */
export function compileProtoArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  if (
    ctx.standalone &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.length > 0 &&
    arg.properties.every(
      (p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p),
    ) &&
    arg.properties.every((p) => ts.isSpreadAssignment(p) || resolvePropertyNameText(ctx, p) !== undefined)
  ) {
    const objResult = compileObjectLiteralAsExternref(ctx, fctx, arg);
    if (objResult) {
      if (objResult.kind !== "externref") coerceType(ctx, fctx, objResult, { kind: "externref" });
      return;
    }
    // fall through to the ordinary path if the $Object builder declined.
  }
  const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (!t) {
    // Expression produced no value — push null so the stack stays balanced for
    // the consuming __object_create / __object_setPrototypeOf call.
    fctx.body.push({ op: "ref.null.extern" });
  } else if (t.kind !== "externref") {
    coerceType(ctx, fctx, t, { kind: "externref" });
  }
}

/**
 * #2160 — `String(arr)` / `Number(arr)` array→primitive coercion in standalone.
 *
 * In native-strings (standalone / WASI) mode there is no JS host
 * `__extern_toString` to run ToPrimitive on a WasmGC array struct, so the
 * generic `coerceType` ref→string/number path null-derefs (`String([1,2,3])`)
 * or yields NaN (`Number([5])`). Arrays already have a native ToString — the
 * `Array.prototype.toString` lowering (§23.1.3.36 → `join(",")`) via
 * `compileArrayJoinNative`. This routes the array argument through that path by
 * synthesizing `arg.toString()` and dispatching to the array-method compiler
 * (mirroring `compileArrayPrototypeCall`'s synthesis at array-methods.ts:1856).
 *
 * Returns the emitted native-string ValType on success, or `undefined` when the
 * argument is not a resolvable array (caller then keeps its existing behavior).
 * Does NOT touch the shared coercion engine (#1917) — purely additive.
 */
export function tryEmitArrayToStringNative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
  argTsType: ts.Type,
): ValType | null | undefined {
  // Only meaningful where the native array-join path applies (standalone /
  // WASI native strings). In JS-host mode the existing __extern_toString path
  // already handles arrays, so leave that untouched.
  if (!(ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0)) return undefined;
  if (!resolveArrayInfo(ctx, argTsType)) return undefined;

  // Skip boolean-element arrays: the join-native lowering packs them as i8 and
  // the synthetic-dispatch element-type resolution diverges from the direct
  // `arr.toString()` receiver path, tripping an "invalid array type" validation
  // error. Booleans are a rare String()/Number() argument; leaving them to the
  // existing fall-through avoids touching the shared array-element machinery
  // (the #2160 slice targets numeric/string arrays). `arr.toString()` on a
  // boolean array still works via the direct property-access path.
  const elemIdxType = argTsType.getNumberIndexType();
  if (elemIdxType && isBooleanType(elemIdxType)) return undefined;

  // Synthesize `argExpr.toString()` and route through the array-method
  // compiler. compileArrayJoinNative reads only `propAccess.expression`
  // (the real, type-resolvable array node) and `callExpr.arguments`
  // (empty → default "," separator), so the synthetic wrappers are safe.
  const syntheticPropAccess = ts.factory.createPropertyAccessExpression(argExpr, "toString");
  (syntheticPropAccess as unknown as { parent: ts.Node }).parent = argExpr.parent;
  const syntheticCall = ts.factory.createCallExpression(syntheticPropAccess, undefined, []);
  (syntheticCall as unknown as { parent: ts.Node }).parent = argExpr.parent;

  const result = compileArrayMethodCall(ctx, fctx, syntheticPropAccess, syntheticCall, argTsType, "toString");
  // `undefined` means the dispatcher declined (not an array shape it handles) —
  // surface that so the caller falls back. VOID_RESULT can't occur for toString.
  if (result === undefined || result === VOID_RESULT) return undefined;
  return result;
}

export function staticToBoolean(expr: ts.Expression): boolean | undefined {
  while (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.ParenthesizedExpression
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  switch (expr.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return true;
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return false;
    case ts.SyntaxKind.NumericLiteral:
      return Number((expr as ts.NumericLiteral).text) !== 0;
    case ts.SyntaxKind.BigIntLiteral: {
      const t = (expr as ts.BigIntLiteral).text;
      return BigInt(t.slice(0, -1)) !== 0n;
    }
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return (expr as ts.StringLiteralLike).text.length > 0;
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.ClassExpression:
      return true;
    case ts.SyntaxKind.Identifier: {
      const text = (expr as ts.Identifier).text;
      if (text === "undefined") return false;
      if (text === "NaN") return false;
      if (text === "Infinity") return true;
      return undefined;
    }
    case ts.SyntaxKind.VoidExpression:
      return false;
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const u = expr as ts.PrefixUnaryExpression;
      if (u.operator === ts.SyntaxKind.ExclamationToken) {
        const inner = staticToBoolean(u.operand);
        return inner === undefined ? undefined : !inner;
      }
      if (u.operator === ts.SyntaxKind.MinusToken || u.operator === ts.SyntaxKind.PlusToken) {
        if (u.operand.kind === ts.SyntaxKind.NumericLiteral) {
          return Number((u.operand as ts.NumericLiteral).text) !== 0;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Coerce an already-pushed Number.prototype method argument (toFixed /
 * toPrecision / toExponential digits) to f64. These runtime helpers take an
 * f64 argument, but the source argument may be i32 (boolean) or externref/ref
 * (e.g. a Symbol). Per §21.1.3.x the argument runs through ToInteger, which
 * begins with ToNumber — and ToNumber(Symbol) throws TypeError (§7.1.4).
 * Routing externref/ref through coerceType funnels Symbols into the throwing
 * ToNumber path (#1564) and keeps the value stack f64-typed for the
 * subsequent local.tee/local.set into an f64 local.
 */
function coerceNumberMethodArgToF64(ctx: CodegenContext, fctx: FunctionContext, argType: ValType | null): void {
  if (!argType) return;
  if (argType.kind === "f64") return;
  if (argType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  coerceType(ctx, fctx, argType, { kind: "f64" });
}

/**
 * (#2160 number-wrapper) Returns true when `receiverType` is a Number-prototype
 * method receiver that the numeric arms below should handle — i.e. a primitive
 * number, OR (standalone only) a `new Number(x)` WRAPPER object.
 *
 * `isNumberType` matches only the primitive (`TypeFlags.Number`), NOT the wrapper
 * (`TypeFlags.Object` whose symbol is `Number`), so `new Number(3.14).toFixed(2)`
 * never entered the numeric lowering and fell through to a generic/host path that
 * trapped in standalone ("null pointer" / wrong value). Mirror of the #1878
 * String-wrapper fix. Gated on `ctx.standalone` for the wrapper case — the native
 * `__to_primitive` recovery (see `emitNumberMethodReceiverF64`) is standalone-only;
 * WASI/host keep the existing object machinery.
 */
function isNumberMethodReceiver(ctx: CodegenContext, receiverType: ts.Type): boolean {
  return isNumberType(receiverType) || (ctx.standalone && isNumberWrapperType(receiverType));
}

/**
 * (#3175) Detect a syntactic `Number.prototype` receiver.
 *
 * Per §21.1.3 the Number prototype object is an ordinary object whose internal
 * [[NumberData]] slot is +0, so `Number.prototype.toString(radix)` /
 * `.valueOf()` / `.toFixed(d)` / `.toPrecision(p)` / `.toExponential(d)` all
 * behave as if invoked on the primitive +0 (e.g. `Number.prototype.toString(3)`
 * is `"0"`). This is the dominant standalone gap in the S15.7.4.2 corpus
 * (35 `A1`/`A2` tests open with exactly this assertion).
 *
 * Standalone types `Number.prototype` as the `Number` wrapper interface, so the
 * boxed-wrapper `__to_primitive`/`__unbox_number` recovery runs — but the
 * prototype object carries no [[PrimitiveValue]] slot, so the unbox yields NaN
 * (rendered `"NaN"`). Recover the +0 directly at the receiver site instead.
 *
 * Guarded against a shadowing user binding: a LOCAL `const Number = {...}` /
 * param is caught by `fctx.localMap`/`boxedCaptures` (mirrors the sibling
 * `tryCompileStandaloneBuiltinProtoMemberMeta` shadow check). A module-level
 * shadow does not reach here at all — every caller is gated on the receiver
 * TYPE being the `Number` wrapper (`isNumberMethodReceiver` /
 * `recvSymName === "Number"`), which a non-Number shadow would not satisfy.
 * Uses no direct TS-checker read (oracle-ratchet, #1930).
 */
function isNumberDotPrototype(fctx: FunctionContext, expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text !== "prototype") return false;
  const base = expr.expression;
  if (!ts.isIdentifier(base) || base.text !== "Number") return false;
  const shadowed = fctx.localMap.has("Number") || (fctx.boxedCaptures?.has("Number") ?? false);
  return !shadowed;
}

/**
 * (#2767) Nominal types whose bare-`var` receiver recovery is VERIFIED safe —
 * the substituted `receiverType` routes into a dispatch path whose
 * externref→ref value-recovery is properly guarded and whose method/property
 * lowering is correct for the recovered struct.
 *
 * This safelist is load-bearing, not a perf refinement: the #2228 `merge_group`
 * test262 gate proved that substituting WITHOUT it regresses non-Date receivers
 * (Promise.finally → illegal cast in the recovered closure; RegExp `re.test` /
 * SharedArrayBuffer `.grow` → wrong native dispatch; super call-spread → invalid
 * Wasm). Those gates route the recovered struct through an UNGUARDED `ref.cast`
 * or a partial native path. Date's recovery is guarded + correct (the measured
 * wins: toISOString ×2, annexB setYear ×3). Expand this set ONE type at a time,
 * each gated behind a full `merge_group` validation (tracked on #2768).
 */
const SAFE_BARE_VAR_RECOVERY_NOMINALS: ReadonlySet<string> = new Set(["Date"]);

/**
 * (#2767) Recover the nominal `ts.Type` a bare-`var`/`let` identifier holds when
 * the TS checker reports `any` (no annotation, no initializer — the
 * "evolving-any" case the checker does NOT narrow across statements, so
 * `var d; d = new Date(0); d.toISOString()` types the receiver `any`/externref
 * and the nominal-symbol dispatch gate bails to the generic dynamic path).
 *
 * Conservative-closed on THREE rules so it never substitutes a type the runtime
 * value may not be:
 *   1. every declaration of the symbol is a plain `var`/`let` VariableDeclaration
 *      — excludes PARAMETERS / catch / binding-element bindings whose value
 *      arrives from outside the scanned assignments (a param reassigned
 *      `p = new X()` in the body must NOT be assumed to always hold an `X`;
 *      that drove the Promise.finally illegal-cast regression);
 *   2. the initializer (if any) AND every `<ident> = <rhs>` assignment to the
 *      symbol resolve to the SAME nominal symbol — any divergence, any
 *      non-nominal RHS, or zero assignments ⇒ undefined;
 *   3. that nominal symbol is on the verified `SAFE_BARE_VAR_RECOVERY_NOMINALS`
 *      safelist (the #2228 merge_group gate showed an unrestricted substitution
 *      misdispatches non-Date receivers).
 * Mirrors the symbol-scan in `symbolBindsAsyncFunction` (expressions.ts:262).
 */
function resolveAssignedNominalType(ctx: CodegenContext, ident: ts.Identifier): ts.Type | undefined {
  const sym = ctx.checker.getSymbolAtLocation(ident);
  if (!sym) return undefined;
  const decls = sym.declarations ?? [];
  // Rule 1: only plain var/let bindings (no params / catch / destructuring
  // elements — their value can arrive un-scanned from outside the assignments).
  if (decls.length === 0 || !decls.every((d) => ts.isVariableDeclaration(d))) return undefined;
  const rhsTypes: ts.Type[] = [];
  for (const d of decls) {
    if (ts.isVariableDeclaration(d) && d.initializer) {
      rhsTypes.push(ctx.checker.getTypeAtLocation(d.initializer));
    }
  }
  const sf = ident.getSourceFile();
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      ctx.checker.getSymbolAtLocation(n.left) === sym
    ) {
      rhsTypes.push(ctx.checker.getTypeAtLocation(n.right));
    }
    forEachChild(n, visit);
  };
  visit(sf);
  if (rhsTypes.length === 0) return undefined;
  let name: string | undefined;
  for (const t of rhsTypes) {
    const nm = t.getSymbol()?.name;
    if (!nm) return undefined; // a non-nominal RHS (any / number / …) → bail
    if (name === undefined) name = nm;
    else if (name !== nm) return undefined; // divergent nominal types → union → bail
  }
  // Rule 3: only substitute for a nominal whose recovery is verified safe.
  if (!name || !SAFE_BARE_VAR_RECOVERY_NOMINALS.has(name)) return undefined;
  return rhsTypes[0];
}

/**
 * (#2160 number-wrapper) Emit the receiver of a Number.prototype method as an
 * f64 on the stack.
 *
 * - Primitive number receiver: `compileExpression(propAccess.expression)` then
 *   i32→f64 widen (the prior inline behaviour of every numeric arm).
 * - Standalone Number WRAPPER receiver (`new Number(x)`): the wrapper lowers to a
 *   `$Object` carrying the primitive in the reserved FLAG_INTERNAL
 *   [[PrimitiveValue]] slot (#1910 S2). Recover it via the existing §7.1.1.1
 *   `__to_primitive(hint "number")` engine helper (reads that slot first) →
 *   `__unbox_number` → f64. Reuses the SAME helper the wrapper `.valueOf()` slice
 *   (cs-2160) uses; no new coercion matrix.
 */
function emitNumberMethodReceiverF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  receiverType: ts.Type,
): void {
  // (#3175) `Number.prototype.<m>(...)` — the prototype object's [[NumberData]]
  // is +0 (§21.1.3). Recover the +0 directly; the wrapper `__to_primitive`
  // recovery below finds no [[PrimitiveValue]] slot and would yield NaN.
  if (isNumberDotPrototype(fctx, propAccess.expression)) {
    fctx.body.push({ op: "f64.const", value: 0 });
    return;
  }
  if (ctx.standalone && isNumberWrapperType(receiverType)) {
    ensureObjectRuntime(ctx);
    const toPrimIdx = ctx.funcMap.get("__to_primitive");
    if (toPrimIdx !== undefined) {
      // wrapper externref → __to_primitive(hint "number") → boxed-number externref
      compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
      addStringConstantGlobal(ctx, "number");
      fctx.body.push(...stringConstantExternrefInstrs(ctx, "number"));
      fctx.body.push({ op: "call", funcIdx: toPrimIdx });
      const unboxNumIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxNumIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxNumIdx });
      }
      return;
    }
    // __to_primitive unavailable — fall through to the primitive path (best effort).
  }
  const exprType = compileExpression(ctx, fctx, propAccess.expression);
  if (exprType && exprType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (exprType && exprType.kind !== "f64") {
    // (#3081) A `number`-typed receiver can compile to a BOXED-number externref
    // rather than an f64 — e.g. a namespace-constant read `Number.NaN.toFixed(0)`
    // / `Number.POSITIVE_INFINITY.toExponential()` lowers `Number.NaN` through
    // `__get_builtin` to a boxed externref. The `number_to{Fixed,Precision,
    // Exponential}` runtime helpers expect an f64 receiver, so feeding the raw
    // externref emits invalid Wasm ("call[0] expected type f64, found externref").
    // Route through the #1917 coercion ENGINE (`coerceType` → f64), which unboxes
    // a boxed-number externref exactly as the sibling argument path
    // (`coerceNumberMethodArgToF64`) already does — no hand-rolled coercion
    // vocabulary here (#2108 coercion-sites gate). An externref/ref receiver was
    // ALWAYS invalid Wasm here, so this cannot regress any previously-instantiable
    // module.
    coerceType(ctx, fctx, exprType, { kind: "f64" });
  }
}

/**
 * (#1735) Normalise an f64 local holding a Number.prototype.{toExponential,
 * toPrecision} digits/precision argument so that NaN becomes 0, matching
 * ToIntegerOrInfinity (§7.1.5 / §21.1.3.{3,5} step 5: NaN → +0).
 *
 * The `number_toExponential` / `number_toPrecision` runtime helpers overload
 * NaN as their "no argument supplied" sentinel (the codegen no-arg branch
 * pushes `f64.const NaN`). Without this normalisation an *explicit* NaN
 * argument (`(1).toExponential(NaN)`, `(1).toExponential(0/0)`) carries the
 * same bits as the sentinel and is wrongly handled as no-arg. Rewriting the
 * local in place — `local = (d == d) ? d : 0` via `f64.eq` self-compare (false
 * only for NaN) feeding `select` — keeps the subsequent range-check and call
 * reading a spec-correct value with no host-side change.
 */
function normalizeNaNToZero(fctx: FunctionContext, f64Local: number): void {
  fctx.body.push({ op: "local.get", index: f64Local }); // val-if-true: d
  fctx.body.push({ op: "f64.const", value: 0 }); // val-if-false: 0
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.eq" }); // condition: d == d (0 only when NaN)
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: f64Local });
}

/**
 * Look up closure info for a variable by checking if its local type
 * is a ref to a known closure struct. Handles cases like:
 *   var f = function() { ... }; f();
 *   const f = makeAdder(5); f.call(null, 10);
 */
export function resolveClosureInfoFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): ClosureInfo | undefined {
  const localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) return undefined;
  const localType =
    localIdx < fctx.params.length ? fctx.params[localIdx]?.type : fctx.locals[localIdx - fctx.params.length]?.type;
  if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
    return ctx.closureInfoByTypeIdx.get(localType.typeIdx);
  }
  return undefined;
}

/**
 * (#2193 PR-B) Reflective `m.call(thisArg, …args)` / `m.apply(thisArg, [args])`
 * where `m` is a **value-materialized `$NativeProto` member closure** (e.g.
 * `const m = Array.prototype.slice; m.call(a, 1, 3)`).
 *
 * The closure value is type-erased to `externref` when stored in a variable
 * (its local wasm type is `externref`, not the concrete `(ref $wrap)`), so
 * `resolveClosureInfoFromLocal` can't recover it and the generic `.call`/`.apply`
 * path drops `thisArg`. We instead recover the closure from the receiver's
 * **TypeScript symbol**: a builtin prototype method's symbol declares as a
 * `MethodSignature` on the `Array` / `Object` lib interface. From that we
 * re-resolve the brand + member, ensure the native method closure, and emit a
 * direct `call_ref` with `thisArg → param 1` (the receiver) and the remaining
 * args → params 2.. — exactly the closure's `(self, this, …args)` ABI.
 *
 * Returns the result `ValType` when it handled the call, or `undefined` to fall
 * through to the legacy paths (non-proto receiver, dynamic `.apply` args, etc.).
 */
function tryEmitNativeProtoReflectiveCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  receiver: ts.Expression,
  isCall: boolean,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (expr.arguments.length === 0) return undefined; // need at least a thisArg

  // Resolve the member name + declaring builtin from the receiver's symbol.
  let sym: ts.Symbol | undefined;
  try {
    sym = ctx.checker.getTypeAtLocation(receiver).getSymbol();
  } catch {
    return undefined;
  }
  let member = sym?.getName();
  const decl = sym?.declarations?.[0];
  let ifaceName: string | undefined;
  if (member && decl && ts.isMethodSignature(decl) && decl.parent && ts.isInterfaceDeclaration(decl.parent)) {
    ifaceName = decl.parent.name.text;
  } else {
    // (#3173) LIB-MISSING members (`DataView.prototype.getFloat16` — ES2025
    // members absent from the bundled lib have NO method-signature symbol):
    // resolve from the receiver variable's declaration-initializer SYNTAX —
    // `var m = <Builtin>.prototype.<member>; m.call(x, …)`. The glue's member
    // CSV is string-keyed, so the closure resolution below is lib-independent.
    member = undefined;
    if (ts.isIdentifier(receiver)) {
      const varSym = ctx.checker.getSymbolAtLocation(receiver);
      const varDecl = varSym?.valueDeclaration;
      if (varDecl && ts.isVariableDeclaration(varDecl) && varDecl.initializer) {
        const init = varDecl.initializer;
        if (
          ts.isPropertyAccessExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          init.expression.name.text === "prototype" &&
          ts.isIdentifier(init.expression.expression)
        ) {
          member = init.name.text;
          ifaceName = init.expression.expression.text;
        }
      }
    }
    if (!member || !ifaceName) return undefined;
  }
  if (!member || !ifaceName) return undefined;

  // Map the lib interface → builtin brand. Array<T> / ReadonlyArray<T> / Object.
  let brand: number | undefined;
  if (ifaceName === "Array" || ifaceName === "ReadonlyArray") brand = ensureArrayNativeProtoGlue(ctx);
  else if (ifaceName === "Object") brand = ensureObjectNativeProtoGlue(ctx);
  else if (ifaceName === "String")
    brand = ensureStringNativeProtoGlue(ctx); // (#2875)
  else if (ifaceName === "DataView")
    brand = ensureDataViewNativeProtoGlue(ctx); // (#3173)
  else if (ifaceName === "Date") brand = ensureDateNativeProtoGlue(ctx); // (#3219)
  if (brand === undefined) return undefined;

  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return undefined;
  // Only a `method`-kind member has the `(self, this, …args)` shape we thread.
  if (glue.memberKind(member) !== "method") return undefined;

  return emitReflectiveNativeProtoClosureCall(ctx, fctx, expr, receiver, brand, member, "method", isCall);
}

/**
 * (#2876) Shared tail for a reflective `<closure>.call/apply(thisArg, …args)` on a
 * value-erased native-proto member closure. Ensures the `(brand, member, kind)`
 * closure to obtain the wrapper struct type + lifted func type, reshapes the args
 * to the closure's `(self, this, …args)` ABI, recovers the wrapper from the
 * runtime `receiver` value (`any.convert_extern` + `ref.cast`), and `call_ref`s
 * the funcref stored in its field 0 — so the ACTUAL stored member runs, with
 * `thisArg → param 1`. Works for both `method` and `getter` kinds (a getter's
 * user-arg list is just `[thisArg]`, threaded into the closure's lone `this`
 * param). Returns the result ValType, or `undefined` to fall through.
 */
function emitReflectiveNativeProtoClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  receiver: ts.Expression,
  brand: number,
  member: string,
  kind: "method" | "getter",
  isCall: boolean,
  /**
   * (#3236 Slice 1b) When set, resolve the closure through the factory's
   * `refusalBodyFallback` — the identity-stable throwing stand-in a member with
   * no wired native body reifies to. Needed for the %GeneratorPrototype% members
   * (`next`/`return`/`throw`), whose only body IS the catchable-TypeError refusal
   * and whose stored `$Object` data-property value is exactly that fallback
   * singleton. Off by default so the existing native-bodied callers (Array/Object
   * proto slice/etc.) are byte-identical.
   */
  useRefusalBodyFallback = false,
): ValType | undefined {
  const closure = ensureStandaloneNativeMethodClosure(
    ctx,
    brand,
    member,
    kind,
    useRefusalBodyFallback ? { refusalBodyFallback: true } : undefined,
  );
  if (!closure) return undefined; // member body refuses / not native yet → fall through
  const closureInfo = ctx.closureInfoByTypeIdx.get(closure.type.typeIdx);
  if (!closureInfo) return undefined;

  // (#2193 PR-B) Active by default. The earlier `expected (ref null N) found
  // (ref null N-1)` blocker was NOT a type-renumber bug (the prior diagnosis) —
  // it was the `call_ref` operand: the trailing operand must be the FUNCREF
  // from the wrapper's field 0, not the wrapper struct (see the call-emit tail
  // below, which now mirrors the canonical closure-call sequence). With that
  // corrected the recovery validates and `m.call(a,1,3) === a.slice(1,3)`.
  // `JS2WASM_DISABLE_PRB_REFLECTIVE_CALL` is an escape hatch (falls back to the
  // legacy drop-thisArg path → returns 0, valid Wasm, no worse than pre-PR-B).
  if (process.env.JS2WASM_DISABLE_PRB_REFLECTIVE_CALL) return undefined;

  // Reshape args to the closure's positional ABI: [thisArg, ...userArgs].
  let userArgs: readonly ts.Expression[] | undefined;
  if (isCall) {
    userArgs = expr.arguments; // [thisArg, a, b] → (this, a, b)
  } else if (expr.arguments.length === 1) {
    userArgs = [expr.arguments[0]!]; // .apply(thisArg) → (this)
  } else {
    const argsExpr = expr.arguments[1]!;
    if (ts.isArrayLiteralExpression(argsExpr)) {
      const flattened = flattenStaticArrayElements(argsExpr);
      if (flattened !== undefined) userArgs = [expr.arguments[0]!, ...flattened];
    }
  }
  if (userArgs === undefined) return undefined; // dynamic apply args → fall through

  // Recover the closure value the variable HOLDS — compile the receiver `m`
  // (an externref carrying the `$wrap` struct), then `any.convert_extern` +
  // `ref.cast` to the wrapper struct type. Using the freshly-emitted closure
  // (`ref.func`+`struct.new`) instead tripped a wrapper-struct type-idx
  // consistency check at finalize (the probe vs final wrapper in
  // `ensureStandaloneNativeMethodClosure` register distinct struct types). The
  // receiver's runtime value is exactly the value-read closure, so casting it to
  // `closureInfo.structTypeIdx` yields a `(ref structTypeIdx)` whose type lines
  // up with the lifted func type's self param.
  const structRefT: ValType = { kind: "ref", typeIdx: closureInfo.structTypeIdx };
  const closureLocal = allocLocal(fctx, `__protocall_${fctx.locals.length}`, structRefT);
  const recvType = compileExpression(ctx, fctx, receiver);
  // The receiver is externref (type-erased) or already a (ref $wrap). Normalize
  // to the concrete wrapper struct via any.convert_extern + ref.cast.
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  }
  fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.structTypeIdx });
  fctx.body.push({ op: "local.set", index: closureLocal });

  // call_ref ABI mirrors the canonical closure-call sequence
  // (calls-closures.ts compileClosureCall): the lifted func type is
  //   (ref $wrapStruct, ...userParams) -> result
  // so the wasm stack must be [self_struct, ...userParams, funcref], where the
  // trailing operand is the FUNCREF extracted from the wrapper's field 0 — NOT
  // the wrapper struct itself. The earlier draft pushed the struct as the
  // call_ref operand, which validates as `expected (ref $funcType) found
  // (ref $wrapStruct)` (the off-by-one #2193 gap A actually surfaced here, not
  // in the type-renumber pass).

  // self param 0: the wrapper struct.
  fctx.body.push({ op: "local.get", index: closureLocal });

  const paramTypes = closureInfo.paramTypes; // excludes the self param
  for (let i = 0; i < paramTypes.length; i++) {
    const pType = paramTypes[i]!;
    if (i < userArgs.length) {
      const aType = compileExpression(ctx, fctx, userArgs[i]!, pType);
      if (aType !== null && !valTypesMatch(aType, pType)) {
        coerceType(ctx, fctx, aType, pType);
      }
    } else if (pType.kind === "externref") {
      fctx.body.push({ op: "ref.null.extern" });
    } else {
      pushDefaultValue(fctx, pType, ctx);
    }
  }

  // Trailing operand: funcref from the wrapper struct's field 0, guard-cast to
  // the lifted func type, null-checked (→ TypeError, never a trap) — exactly
  // the canonical closure-call tail (calls-closures.ts ~lines 138-150).
  fctx.body.push({ op: "local.get", index: closureLocal });
  fctx.body.push({ op: "struct.get", typeIdx: closureInfo.structTypeIdx, fieldIdx: 0 });
  emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
  fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
  return closureInfo.returnType ?? { kind: "externref" };
}

/**
 * (#3236 Slice 1b) True when `objExpr` syntactically resolves to the native
 * `%GeneratorPrototype%` singleton — the object whose own `next`/`return`/`throw`
 * are the brand-checked closure values Slice 1 installed. Recognises the two
 * shapes the test262 GeneratorPrototype `this-val-*` tests use, tracing at most
 * ONE variable-initializer indirection (`var GP = <expr>; GP.next.call(x)`):
 *
 *   - `<genFn>.prototype`                    (§27.5.1 — genFn.prototype IS %GP%)
 *   - `Object.getPrototypeOf(<genFn>).prototype`
 *          (getPrototypeOf(genFn) = %Generator%, whose own `.prototype` = %GP%)
 *
 * `<genFn>` must be a `function*` declaration known to `ctx.generatorFunctions`
 * (sync only — async generators keep the host-import path). Conservative: any
 * shape it can't prove returns false, so the caller falls through to the
 * unchanged legacy `.call` lowering (no regression).
 */
function isGeneratorPrototypeReceiver(ctx: CodegenContext, objExpr: ts.Expression): boolean {
  let cur = unwrapTransparent(objExpr);
  // One level of `var GP = <init>` indirection.
  if (ts.isIdentifier(cur)) {
    const sym = ctx.checker.getSymbolAtLocation(cur);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      cur = unwrapTransparent(decl.initializer);
    }
  }
  if (!ts.isPropertyAccessExpression(cur) || cur.name.text !== "prototype") return false;
  const base = unwrapTransparent(cur.expression);
  // Shape A: `<genFn>.prototype`.
  if (ts.isIdentifier(base) && ctx.generatorFunctions.has(base.text)) return true;
  // Shape B: `Object.getPrototypeOf(<genFn>).prototype`.
  if (ts.isCallExpression(base)) {
    const callee = unwrapTransparent(base.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "getPrototypeOf" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      base.arguments.length >= 1
    ) {
      const arg = unwrapTransparent(base.arguments[0]!);
      if (ts.isIdentifier(arg) && ctx.generatorFunctions.has(arg.text)) return true;
    }
  }
  return false;
}

/**
 * (#3236 Slice 1b) Reflective `<GP>.next.call/apply(thisArg, …)` where the
 * `.call`/`.apply` receiver `<GP>.next` is a DYNAMICALLY-READ %GeneratorPrototype%
 * member closure. Unlike `tryEmitNativeProtoReflectiveCall` (which recovers the
 * closure from the receiver's TS symbol), here the receiver object `<GP>` is
 * `any`-typed (`Object.getPrototypeOf(g).prototype`), so `<GP>.next` has no
 * method-signature symbol — the closure value is an own `$Object` data property.
 * We instead resolve the `(brand, member)` from the receiver's syntactic
 * GeneratorPrototype provenance, then reuse the shared reflective closure-call
 * emitter, which compiles `<GP>.next` to the stored closure externref, casts it
 * to the wrapper struct, and `call_ref`s it with `thisArg → this` param. The
 * closure's Slice-1 catchable-TypeError refusal body then fires on the bad
 * `this` (GeneratorValidate §27.5.1.2). Standalone-gated; returns the result
 * ValType when handled, or `undefined` to fall through unchanged.
 */
function tryEmitGeneratorProtoReflectiveCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  innerExpr: ts.Expression,
  isCall: boolean,
): ValType | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const recv = unwrapTransparent(innerExpr);
  if (!ts.isPropertyAccessExpression(recv)) return undefined;
  const member = recv.name.text;
  if (member !== "next" && member !== "return" && member !== "throw") return undefined;
  if (!isGeneratorPrototypeReceiver(ctx, recv.expression)) return undefined;
  const brand = ensureGeneratorPrototypeNativeProtoGlue(ctx);
  if (brand === undefined) return undefined;
  // `useRefusalBodyFallback: true` — the GeneratorPrototype members carry only
  // the catchable-TypeError refusal body (no wired native body), and their
  // stored `$Object` data-property value IS that identity-stable fallback
  // singleton, so the reflective cast must target the same struct type.
  return emitReflectiveNativeProtoClosureCall(ctx, fctx, expr, recv, brand, member, "method", isCall, true);
}

/** Unwrap parenthesized / `as` / non-null wrappers to the underlying expression. */
function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** True if `e` is `Object.getOwnPropertyDescriptor(…)`. */
function isObjectGopdCall(e: ts.Expression): e is ts.CallExpression {
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "getOwnPropertyDescriptor"
  );
}

/** Follow an identifier to its (single) variable-declaration initializer, if any. */
function traceVarInitializer(ctx: CodegenContext, ident: ts.Identifier): ts.Expression | undefined {
  let sym: ts.Symbol | undefined;
  try {
    sym = ctx.checker.getSymbolAtLocation(ident);
  } catch {
    return undefined;
  }
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return decl.initializer;
  return undefined;
}

/**
 * (#2876) Resolve a `.call`/`.apply` receiver to the builtin-proto accessor
 * descriptor it came from: `{ accessorName, gopdCall }` for the shapes
 *   - `gOPD(...).get`                 (inline accessor access)
 *   - `<ident=gOPD(...).get>`         (var holding the accessor closure)
 *   - `<ident=gOPD(...)>.get`         (var holding the descriptor)
 * or `undefined` when it doesn't trace to one.
 */
function resolveDescriptorAccessorSource(
  ctx: CodegenContext,
  recv: ts.Expression,
): { accessorName: string; gopdCall: ts.CallExpression } | undefined {
  const r = unwrapTransparent(recv);

  // `<obj>.get` / `<obj>.set`
  if (ts.isPropertyAccessExpression(r) && (r.name.text === "get" || r.name.text === "set")) {
    const obj = unwrapTransparent(r.expression);
    if (isObjectGopdCall(obj)) return { accessorName: r.name.text, gopdCall: obj };
    if (ts.isIdentifier(obj)) {
      const init = traceVarInitializer(ctx, obj);
      if (init && isObjectGopdCall(unwrapTransparent(init))) {
        return { accessorName: r.name.text, gopdCall: unwrapTransparent(init) as ts.CallExpression };
      }
    }
    return undefined;
  }

  // `<ident>` whose initializer is `gOPD(...).get`
  if (ts.isIdentifier(r)) {
    const init = traceVarInitializer(ctx, r);
    if (!init) return undefined;
    const i = unwrapTransparent(init);
    if (ts.isPropertyAccessExpression(i) && (i.name.text === "get" || i.name.text === "set")) {
      const obj = unwrapTransparent(i.expression);
      if (isObjectGopdCall(obj)) return { accessorName: i.name.text, gopdCall: obj };
    }
  }
  return undefined;
}

/**
 * (#2901) Resolve a module/function-scope variable's initializer expression, or
 * `undefined` if `ident` is not a single-initializer variable. Used by the static
 * data-flow trace that recognises the `testTypedArray.js` harness's
 * `var TypedArray = Object.getPrototypeOf(Int8Array)` / `var P = TypedArray.prototype`
 * intermediate bindings.
 */
function resolveVarInitializer(ctx: CodegenContext, ident: ts.Identifier): ts.Expression | undefined {
  const sym = ctx.checker.getSymbolAtLocation(ident);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  return decl.initializer;
}

/** (#2901) True iff `call` is `Object.getPrototypeOf(<arg>)`; returns the unwrapped arg or undefined. */
function getProtoOfCallArg(expr: ts.Expression): ts.Expression | undefined {
  const e = unwrapTransparent(expr);
  if (!ts.isCallExpression(e) || e.arguments.length < 1) return undefined;
  const callee = e.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    callee.name.text !== "getPrototypeOf"
  ) {
    return undefined;
  }
  return unwrapTransparent(e.arguments[0]!);
}

/**
 * (#2903 R4) Scalar-returning `%TypedArray%.prototype` callback HOFs whose
 * STANDALONE dispatch on a DIRECT (`$__vec_i8_byte`-style) carrier is routed to
 * the native `__call_m_<name>_<arity>` / `__hof_<name>` substrate (see the
 * interception in {@link compileCallExpression}'s array-method arm). Excludes
 * `map`/`filter` (typed-RESULT construction — deferred to R4b) and the mutators.
 */
const STANDALONE_TA_SCALAR_HOFS: ReadonlySet<string> = new Set([
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "some",
  "every",
  "reduce",
  "reduceRight",
]);

/**
 * (#2903 R4b) The PACKED-INTEGER typed-array views whose `map`/`filter` are
 * routed to the native `__ta_map_*`/`__ta_filter_*` typed-RESULT helper (STORE
 * via width-truncation). `Uint8ClampedArray` (#2903 R4c) is handled alongside
 * these but routes to the `clamp` helper variant (round-half-to-even store) — it
 * is NOT in this set because it shares the `i8_byte` carrier and would collide.
 * The float views (`Float32Array`/`Float64Array`) use the `f64` carrier and
 * already `map`/`filter` correctly through the existing array-HOF path
 * (byte-identical, left untouched).
 */
const STANDALONE_TA_MAPFILTER_PACKED_VIEWS: ReadonlySet<string> = new Set([
  "Int8Array",
  "Uint8Array",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
]);

/**
 * (#2901) True iff `expr` (statically, following single-init var bindings) denotes
 * the abstract `%TypedArray%` intrinsic constructor, in either shape the test262
 * TypedArray corpus reaches it:
 *   - `Object.getPrototypeOf(Int8Array)`                      (full `testTypedArray.js`)
 *   - `Object.getPrototypeOf(Int8Array.prototype).constructor` (the test262-runner
 *     injected shim for the abstract intrinsic — test262-runner.ts ~1823)
 */
function isTypedArrayIntrinsicCtorExpr(ctx: CodegenContext, expr: ts.Expression): boolean {
  const e = unwrapTransparent(expr);
  // Object.getPrototypeOf(<wired view ctor>)
  const gpoArg = getProtoOfCallArg(e);
  if (gpoArg && ts.isIdentifier(gpoArg) && isWiredTypedArrayViewName(gpoArg.text)) return true;
  // Object.getPrototypeOf(<wired view ctor>.prototype).constructor
  if (ts.isPropertyAccessExpression(e) && e.name.text === "constructor") {
    const innerArg = getProtoOfCallArg(e.expression);
    if (
      innerArg &&
      ts.isPropertyAccessExpression(innerArg) &&
      innerArg.name.text === "prototype" &&
      ts.isIdentifier(innerArg.expression) &&
      isWiredTypedArrayViewName(innerArg.expression.text)
    ) {
      return true;
    }
  }
  // a var whose initializer denotes the intrinsic ctor
  if (ts.isIdentifier(e)) {
    const init = resolveVarInitializer(ctx, e);
    if (init && isTypedArrayIntrinsicCtorExpr(ctx, init)) return true;
  }
  return false;
}

/**
 * (#2901) True iff `arg0` statically traces to `%TypedArray%.prototype`: it is (or
 * a var whose initializer is) a `<X>.prototype` access where `X` denotes the
 * `%TypedArray%` intrinsic constructor (see `isTypedArrayIntrinsicCtorExpr`). This
 * lets the #2885 gOPD synthesis + #2876 reflective `.call` fire on the harness's
 * *dynamic* (variable-routed) proto receiver — `gOPD(TypedArrayPrototype, m)` where
 * `TypedArrayPrototype = TypedArray.prototype` — not just the syntactic
 * `<Ctor>.prototype` form. Pure static analysis — no runtime dispatch, no rep
 * change; returns false (unchanged behaviour) for any other receiver.
 */
export function tracesToTypedArrayIntrinsicProto(ctx: CodegenContext, arg0: ts.Expression): boolean {
  let pa: ts.Expression = unwrapTransparent(arg0);
  if (ts.isIdentifier(pa)) {
    const init = resolveVarInitializer(ctx, pa);
    if (!init) return false;
    pa = unwrapTransparent(init);
  }
  if (!ts.isPropertyAccessExpression(pa) || pa.name.text !== "prototype") return false;
  return isTypedArrayIntrinsicCtorExpr(ctx, pa.expression);
}

/**
 * (#2876) Parse `Object.getOwnPropertyDescriptor(<Builtin>.prototype, "<member>")`
 * → `{ builtinName, member }`, gated like the gOPD-synthesis site: arg0 is an
 * unshadowed `BUILTIN_CTOR_NAMES` `.prototype` access, arg1 a string literal.
 * (#2901) Also accepts a `%TypedArray%`-intrinsic proto receiver that statically
 * traces through the harness's intermediate vars (see `tracesToTypedArrayIntrinsicProto`).
 */
function parseBuiltinProtoGopdCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): { builtinName: string; member: string } | undefined {
  if (call.arguments.length < 2) return undefined;
  const arg0 = unwrapTransparent(call.arguments[0]!);
  const arg1 = call.arguments[1]!;
  if (!ts.isStringLiteral(arg1)) return undefined;
  // (#2901) Dynamic %TypedArray%.prototype receiver, traced through the harness's
  // intermediate vars (`var TypedArray = getProtoOf(Int8Array); TypedArray.prototype`).
  if (tracesToTypedArrayIntrinsicProto(ctx, arg0)) {
    return { builtinName: "%TypedArray%", member: arg1.text };
  }
  if (
    !ts.isPropertyAccessExpression(arg0) ||
    arg0.name.text !== "prototype" ||
    !ts.isIdentifier(arg0.expression) ||
    !BUILTIN_CTOR_NAMES.has(arg0.expression.text)
  ) {
    return undefined;
  }
  const builtinName = arg0.expression.text;
  if (fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false)) return undefined;
  return { builtinName, member: arg1.text };
}

/**
 * (#2876) Reflective `.call/.apply` on a getter pulled from a builtin-proto
 * accessor descriptor — `var get = Object.getOwnPropertyDescriptor(RegExp.prototype,
 * "global").get; get.call(R)` (and the inline `gOPD(...).get.call(R)` form).
 *
 * The descriptor `get` is the brand-keyed getter closure synthesized by #2885;
 * stored in a variable it erases to `externref`, so `tryEmitNativeProtoReflectiveCall`
 * (which keys off the receiver's TS *symbol*, a MethodSignature on a lib
 * interface) can't recover it. Here we recover (brand, member) by STATICALLY
 * tracing the receiver's data-flow back to its `gOPD(<Builtin>.prototype,
 * "<member>").get` initializer, then reuse the shared call_ref emitter (which
 * call_ref's the funcref stored in the runtime wrapper, so the right member runs
 * with thisArg → its `this` param). The getter body's #2885 proto-identity arm +
 * brand recovery then yield the spec result: undefined for `R === proto`, the
 * field value for a real instance, a catchable TypeError for a non-brand `this`.
 *
 * Standalone-only; returns `undefined` (no behaviour change) when the receiver
 * doesn't trace to a builtin-proto accessor descriptor.
 */
function tryEmitNativeProtoDescriptorAccessorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  recv: ts.Expression,
  isCall: boolean,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (expr.arguments.length === 0) return undefined; // need at least a thisArg

  const resolved = resolveDescriptorAccessorSource(ctx, recv);
  if (!resolved || resolved.accessorName !== "get") return undefined; // setter synthesis not wired

  const info = parseBuiltinProtoGopdCall(ctx, fctx, resolved.gopdCall);
  if (!info) return undefined;

  const brand = tryEnsureNativeProtoBrand(ctx, info.builtinName);
  if (brand === undefined) return undefined;
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue || !glue.memberCsv.split(",").includes(info.member)) return undefined;
  if (glue.memberKind(info.member) !== "getter") return undefined;

  return emitReflectiveNativeProtoClosureCall(ctx, fctx, expr, recv, brand, info.member, "getter", isCall);
}

/**
 * (#1324 primitives slice) Try to emit `JSON.stringify(arg)` for a
 * statically-typed primitive value without the `JSON_stringify` JS host call.
 *
 * Supported shapes (all leave an externref string on the stack):
 *   - `null`       → string `"null"`
 *   - `undefined`  → undefined (ref.null.extern) — per spec §25.5.4.2,
 *                    `JSON.stringify(undefined)` returns `undefined`,
 *                    not the string "null"
 *   - `boolean`    → string `"true"` or `"false"`
 *   - `number`     → result of `number_toString(value)` when available, except
 *                    `NaN`/`±Infinity` serialize to the string `"null"`
 *                    per §25.5.4.2 step 9
 *
 * Deferred to #1353 (full architect spec):
 *   - `string`  — needs runtime JSON-escape helper
 *   - `bigint`  — needs runtime check + TypeError throw
 *   - object / array — needs WasmGC shape walking
 *
 * Returns the emitted type and pushes a string/undefined value onto the wasm
 * stack when emission succeeded; returns `undefined` (no stack effect) otherwise so
 * the caller can fall through to the `JSON_stringify` host import.
 */
function tryEmitJsonStringifyPrimitive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): ValType | null | undefined {
  let argType: ts.Type;
  try {
    argType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return undefined;
  }
  const flags = argType.flags;

  // (#2166) TypeScript models the `boolean` primitive as the union
  // `true | false`, so a `boolean`-typed value (e.g. `const b: boolean = x`)
  // carries the `Union` flag and was wrongly skipped by the ambiguous-mask
  // early-return below — so `JSON.stringify(b)` refused in standalone instead
  // of serializing to "true"/"false". A `BooleanLike` type (the boolean union
  // or a boolean literal) is unambiguously serializable, so recognize it before
  // the mask. Guard on `intrinsicName === "boolean"` for the union so we don't
  // misfire on a mixed union that merely contains a boolean member.
  const isBooleanType =
    (flags & ts.TypeFlags.BooleanLiteral) !== 0 ||
    ((flags & ts.TypeFlags.Boolean) !== 0 &&
      (argType as ts.Type & { intrinsicName?: string }).intrinsicName === "boolean");

  // Skip ambiguous shapes (any/unknown/union/object/intersection) — let
  // the caller fall through to the host import which handles them. The
  // `boolean` union is the documented exception (see above).
  const ambiguousMask =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Union |
    ts.TypeFlags.Intersection |
    ts.TypeFlags.Object |
    ts.TypeFlags.NonPrimitive |
    ts.TypeFlags.TypeParameter;
  if (!isBooleanType && flags & ambiguousMask) return undefined;

  // null literal
  if (flags & ts.TypeFlags.Null) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" });
    return compileStringLiteral(ctx, fctx, "null", arg);
  }

  // undefined / void — `JSON.stringify(undefined)` returns the JS
  // `undefined` value (not the string "undefined" or "null"). Emit via
  // the existing `emitUndefined` helper so JS sees the right value
  // (host-mode pulls it from `__get_undefined`; standalone mode falls
  // back to `ref.null.extern` which JS sees as `null` — acceptable per
  // the existing helper's documented contract).
  if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" });
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // boolean / true / false
  if (flags & ts.TypeFlags.BooleanLike) {
    const argResult = compileExpression(ctx, fctx, arg, { kind: "i32" });
    if (argResult === null) {
      // Failed to compile the arg as i32 — abandon (no stack effect from this fn).
      return undefined;
    }
    const savedBody = fctx.body;
    fctx.body = [];
    const trueType = compileStringLiteral(ctx, fctx, "true", arg);
    const trueBody = fctx.body;
    fctx.body = [];
    const falseType = compileStringLiteral(ctx, fctx, "false", arg);
    const falseBody = fctx.body;
    fctx.body = savedBody;
    const resultType = trueType ?? falseType ?? ({ kind: "externref" } as ValType);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: trueBody,
      else: falseBody,
    });
    return resultType;
  }

  // number / numeric literal
  if (flags & ts.TypeFlags.NumberLike) {
    const numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) return undefined;
    const savedBody = fctx.body;
    fctx.body = [];
    const nullType = compileStringLiteral(ctx, fctx, "null", arg);
    const nullBody = fctx.body;
    fctx.body = savedBody;
    const resultType = (ctx.standalone || ctx.wasi ? nullType : ({ kind: "externref" } as ValType)) ?? {
      kind: "externref",
    };

    const argResult = compileExpression(ctx, fctx, arg, { kind: "f64" });
    if (argResult === null) return undefined;

    // Stack: [f64 value]. Save to a local so we can both test for
    // finiteness AND pass to number_toString in the finite branch.
    const valLocal = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: valLocal });

    // isFinite check: x - x === 0. NaN-NaN and ±Infinity-±Infinity both
    // produce NaN, which fails the equality. Finite values produce 0.
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "f64.sub" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.eq" });

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [
        { op: "local.get", index: valLocal },
        { op: "call", funcIdx: numToStrIdx },
        ...(ctx.standalone || ctx.wasi
          ? ([{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx }] satisfies Instr[])
          : []),
      ],
      else: nullBody,
    });
    releaseTempLocal(fctx, valLocal);
    return resultType;
  }

  // string / String — standalone/WASI have no JSON_stringify host import.
  // Emit the pure-Wasm `__json_quote_string` runtime helper (#1599 Phase 2):
  // it scans the runtime string's UTF-16 code units and produces a
  // JSON-quoted $NativeString per §25.5.4.3 QuoteJSONString. In JS-host mode
  // we fall through to the JSON_stringify import (it observes replacer/space
  // and toJSON, which the helper does not).
  if ((ctx.standalone || ctx.wasi) && flags & ts.TypeFlags.StringLike) {
    const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argResult === null) return undefined;
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const quoteIdx = emitJsonQuoteString(ctx);
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_quote_string") ?? quoteIdx });
    // __json_quote_string returns a native string ref (matches compileStringLiteral
    // in nativeStrings mode), so downstream string ops (===, return) see the same
    // type they expect rather than an over-wrapped externref.
    return nativeStringType(ctx);
  }

  // bigint / unhandled — fall through to the host import. Full
  // pure-Wasm support tracked under #1353.
  return undefined;
}

/**
 * (#1599 Phase 2) Try to emit `JSON.parse(s)` for a runtime string-typed
 * argument in standalone / WASI mode, where there is no `env::JSON_parse`
 * host import. Handles the JSON *primitive* slice — number / `true` / `false`
 * / `null` — via the pure-Wasm `__json_parse_primitive` helper, which boxes
 * the parsed value into the host-free `$AnyValue` tagged union.
 *
 * Returns the emitted `ref $AnyValue` type (so the downstream AnyValue→
 * primitive coercion path unboxes it to number / boolean as the consumer
 * requires) and pushes the value; returns `undefined` (no stack effect) when
 * the argument is not a runtime string — objects, arrays, and string *values*
 * still fall through to the #1599 refusal (they need the full Phase 2 codec).
 *
 * Spec: ECMA-262 §25.5.2 `JSON.parse` / `ParseJSON`, ECMA-404.
 */
function tryEmitJsonParsePrimitive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
  arg: ts.Expression,
): ValType | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  // A property/element read on the result — `JSON.parse(s).x` / `JSON.parse(s)[i]`
  // — means the parsed value is consumed as an object/array, which the primitive
  // slice does not produce. Leave those to the #1599 refusal (full Phase 2 codec).
  const parent = call.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.expression === call) ||
    (ts.isElementAccessExpression(parent) && parent.expression === call)
  ) {
    return undefined;
  }
  let argType: ts.Type;
  try {
    argType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return undefined;
  }
  // Only a string-typed argument routes here. `JSON.parse(<string literal>)`
  // is folded earlier by tryEmitJsonParseLiteral; this handles the runtime
  // string-value case.
  if ((argType.flags & ts.TypeFlags.StringLike) === 0) return undefined;

  const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argResult === null) return undefined;
  if (argResult.kind !== "externref") {
    coerceType(ctx, fctx, argResult, { kind: "externref" });
  }
  const parseIdx = emitJsonParsePrimitive(ctx);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_parse_primitive") ?? parseIdx });
  return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
}

/**
 * Check if a node (function body) uses the `arguments` binding.
 * Skips nested function/function-expression scopes (they have their own `arguments`),
 * but traverses arrow functions (which inherit the enclosing `arguments`).
 */
/**
 * (#1465) Emit an iterable argument for a host-bound Promise combinator
 * (Promise.all / race / allSettled / any).
 *
 * The runtime helper delegates to native `Promise.METHOD.call(C, iter)` which
 * drives the spec's `GetIterator(iter)` algorithm — strings, arguments,
 * generators, custom Symbol.iterator objects, Set/Map/TypedArrays all "just
 * work" when the host engine sees them as real iterables.
 *
 * The pain point is array literals: by default `[p1, p2]` compiles to a
 * wasm vec or tuple struct, which is opaque to the host engine. Native
 * GetIterator on an opaque externref throws "object is not iterable".
 *
 * Fix: when the iterable argument is a syntactic ArrayLiteralExpression,
 * compile each element to externref and push it into a JS array via
 * `__js_array_new` / `__js_array_push`. For any other shape (variables,
 * function returns, spread, …) fall back to plain externref coercion and
 * trust the runtime helper's `_toIterable` to dispatch (it handles strings,
 * known JS iterables, and wasm vec via __vec_len/__vec_get).
 */
function emitIterableArg(ctx: CodegenContext, fctx: FunctionContext, argExpr: ts.Expression): void {
  // Strip parens/as so `(p as any[])` and similar wrappers still match.
  let inner: ts.Expression = argExpr;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isArrayLiteralExpression(inner)) {
    const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
    if (arrNewIdx !== undefined && arrPushIdx !== undefined) {
      // Build a JS array eagerly, push each element coerced to externref.
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      const jsArrLocal = allocLocal(fctx, `__promise_iter_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: jsArrLocal });
      for (const el of inner.elements) {
        // Spread inside the array literal: fall back to a generic coercion of
        // the entire literal to externref. Native engine will iterate the
        // spread source on our behalf.
        if (ts.isSpreadElement(el)) {
          fctx.body.push({ op: "drop" });
          compileExpression(ctx, fctx, argExpr, { kind: "externref" });
          return;
        }
        fctx.body.push({ op: "local.get", index: jsArrLocal });
        // OmittedExpression (sparse array hole) — push undefined sentinel.
        if (ts.isOmittedExpression(el)) {
          emitUndefined(ctx, fctx);
        } else {
          const elType = compileExpression(ctx, fctx, el, { kind: "externref" });
          if (elType && elType.kind !== "externref") {
            // compileExpression with target externref should coerce already;
            // belt-and-braces fallback.
            fctx.body.push({ op: "extern.convert_any" });
          }
        }
        fctx.body.push({ op: "call", funcIdx: arrPushIdx });
      }
      fctx.body.push({ op: "local.get", index: jsArrLocal });
      return;
    }
  }
  // Default: coerce to externref and let the runtime helper dispatch.
  compileExpression(ctx, fctx, argExpr, { kind: "externref" });
}

/**
 * (#1632a) Static-resolve the name of a function-like expression for the
 * `__bind_function` nameHint argument. Returns "" when no static name is
 * available (anonymous function, complex expression). The host falls back to
 * the wrapped callable's own `.name` when the hint is empty.
 *
 * Per spec §15.2.5 / NamedEvaluation: a named function expression
 * `function namedFn(){}` keeps its inner name even when bound to a different
 * identifier (`const fn = function namedFn(){}`); the inner name wins.
 */
function resolveStaticFunctionName(ctx: CodegenContext, expr: ts.Expression): string {
  let cursor: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cursor) ||
    ts.isAsExpression(cursor) ||
    ts.isTypeAssertionExpression(cursor) ||
    ts.isSatisfiesExpression(cursor) ||
    ts.isNonNullExpression(cursor)
  ) {
    cursor = (cursor as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(cursor)) {
    // Look through `const fn = function namedFn(){}` to prefer the inner name
    // (named function expression) over the binding identifier.
    const sym = ctx.checker.getSymbolAtLocation(cursor);
    const decl = sym?.valueDeclaration;
    if (decl && (ts.isVariableDeclaration(decl) || ts.isBindingElement(decl)) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.name) return init.name.text;
    }
    return cursor.text;
  }
  if (ts.isPropertyAccessExpression(cursor)) return cursor.name.text;
  // Named function expression: `(function namedFn(){}).bind(...)`
  if (ts.isFunctionExpression(cursor) && cursor.name) return cursor.name.text;
  return "";
}

/**
 * (#1632a) Static-resolve the declared parameter count of a function-like
 * expression for the `__bind_function` lengthHint. Returns -1 when no static
 * arity is available; the host falls back to the wrapped callable's `.length`.
 *
 * Spec §20.2.4.2: `Function.prototype.length` is the count of formal parameters
 * before the first default-valued, rest, or destructured parameter.
 */
function resolveStaticFunctionLength(ctx: CodegenContext, expr: ts.Expression): number {
  let cursor: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cursor) ||
    ts.isAsExpression(cursor) ||
    ts.isTypeAssertionExpression(cursor) ||
    ts.isSatisfiesExpression(cursor) ||
    ts.isNonNullExpression(cursor)
  ) {
    cursor = (cursor as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  // Inline function expression / arrow — read parameters directly.
  if (ts.isFunctionExpression(cursor) || ts.isArrowFunction(cursor)) {
    return countSpecLength(cursor.parameters);
  }
  // Try the TS checker's call signatures.
  const tsType = ctx.checker.getTypeAtLocation(cursor);
  const sigs = tsType?.getCallSignatures?.() ?? [];
  if (sigs.length > 0) {
    const sig = sigs[0]!;
    const decl = sig.getDeclaration?.();
    if (decl && decl.parameters) {
      return countSpecLength(decl.parameters);
    }
    // Fallback: signature parameter count (less precise — counts optional/rest).
    const minArity = (sig as unknown as { minArgumentCount?: number }).minArgumentCount;
    if (typeof minArity === "number") return minArity;
    return sig.parameters.length;
  }
  return -1;
}

function countSpecLength(params: ts.NodeArray<ts.ParameterDeclaration>): number {
  let count = 0;
  for (const p of params) {
    // Skip the TypeScript `this` pseudo-parameter — it's not part of
    // Function.prototype.length per spec.
    if (ts.isIdentifier(p.name) && p.name.text === "this") continue;
    // Stop at first default, rest, or optional — per spec.
    if (p.questionToken !== undefined) break;
    if (p.dotDotDotToken !== undefined) break;
    if (p.initializer !== undefined) break;
    count++;
  }
  return count;
}

/**
 * (#1632a) Compile `target.bind(thisArg, ...partialArgs)` to a
 * `__bind_function(target, thisArg, argsArray, nameHint, lengthHint)` host
 * import call. The host delegates to `Function.prototype.bind.apply(wrapped,
 * [thisArg, ...partial])` and returns a real JS bound-function exotic.
 *
 * Standalone mode falls back to identity-bind (drops partial args, returns
 * the receiver). Returns `undefined` to signal "no codegen happened, caller
 * should fall through" — this can only happen if `compileExpression` for the
 * receiver returns null (e.g. unresolvable identifier); callers retain the
 * old "throws on missing receiver" behaviour in that case.
 */
/**
 * (#3140) Mint a native `$__bound_fn` value from PRE-EVALUATED externref
 * locals: `{target, thisArg, boundArgs}` where `boundArgs` is a fresh `$ObjVec`
 * of the partial-application args. Leaves the boxed externref on the stack.
 * The carrier is unwrapped by the `__apply_closure` front-guard (boundArgs
 * prepended, recursion on target — bound-of-bound composes) and classified
 * callable by `closure-classifier.ts` (`typeof bound === "function"`).
 * Standalone/WASI lane only (the $ObjVec builders are the native ones).
 */
function emitBoundFnValueFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  thisArgLocal: number | undefined,
  partialArgLocals: readonly number[],
): void {
  const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
  // Reserve the closure bridge so `fillApplyClosure` (which carries the
  // $__bound_fn unwrap front-guard) is guaranteed to run for this module even
  // when the bind result is never visibly called from compiled code paths that
  // would otherwise reserve it.
  reserveApplyClosure(ctx);
  const bfIdx = getOrRegisterBoundFnType(ctx);
  fctx.body.push({ op: "local.get", index: targetLocal });
  if (thisArgLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: thisArgLocal });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const argsVecLocal = allocLocal(fctx, `__bindfn_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: objVecNewIdx });
  fctx.body.push({ op: "local.set", index: argsVecLocal });
  for (const aLocal of partialArgLocals) {
    fctx.body.push({ op: "local.get", index: argsVecLocal });
    fctx.body.push({ op: "local.get", index: aLocal });
    fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
  }
  fctx.body.push({ op: "local.get", index: argsVecLocal });
  fctx.body.push({ op: "struct.new", typeIdx: bfIdx });
  fctx.body.push({ op: "extern.convert_any" });
}

function compileFunctionBind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  const externRef: ValType = { kind: "externref" };
  const i32Ty: ValType = { kind: "i32" };

  // (#3140) Standalone (--target wasi / noJsHost): no JS host — mint the native
  // `$__bound_fn` carrier {target, thisArg, boundArgs}. Replaces the #1632a
  // identity-bind degrade (which DROPPED the partial args, so the test262
  // TypedArray harness `argFactory.bind(undefined, constructor)` lost the bound
  // ctor and every makeCtorArg-style test failed at the harness level).
  // Evaluation order per §20.2.3.2: target (receiver), then thisArg, then
  // partials — each exactly once, into externref locals.
  if (ctx.standalone || noJsHost(ctx)) {
    const recvType = compileExpression(ctx, fctx, propAccess.expression, externRef);
    if (recvType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (recvType.kind !== "externref") {
      coerceType(ctx, fctx, recvType, externRef);
    }
    const targetLocal = allocLocal(fctx, `__bindfn_tgt_${fctx.locals.length}`, externRef);
    fctx.body.push({ op: "local.set", index: targetLocal });
    const argLocals: number[] = [];
    for (const arg of expr.arguments) {
      const src = ts.isSpreadElement(arg) ? arg.expression : arg;
      const t = compileExpression(ctx, fctx, src, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        coerceType(ctx, fctx, t, externRef);
      }
      const aLocal = allocLocal(fctx, `__bindfn_arg_${fctx.locals.length}`, externRef);
      fctx.body.push({ op: "local.set", index: aLocal });
      argLocals.push(aLocal);
    }
    emitBoundFnValueFromLocals(ctx, fctx, targetLocal, argLocals[0], argLocals.slice(1));
    return externRef;
  }

  // Static hints from the receiver expression (host falls back when -1 / "").
  const targetName = resolveStaticFunctionName(ctx, propAccess.expression);
  const targetLength = resolveStaticFunctionLength(ctx, propAccess.expression);

  // 1. Push target externref.
  const recvType = compileExpression(ctx, fctx, propAccess.expression, externRef);
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // 2. Push thisArg externref (or ref.null.extern when omitted).
  const args = expr.arguments;
  if (args.length >= 1) {
    const t = compileExpression(ctx, fctx, args[0]!, externRef);
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (t.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // 3. Build argsArray as a JS Array of partial args (args[1..]).
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  flushLateImportShifts(ctx, fctx);
  const arrNewResolvedIdx = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const arrPushResolvedIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  if (arrNewResolvedIdx === undefined || arrPushResolvedIdx === undefined) {
    // Late-import setup failed (very unusual). Bail to identity-bind for safety.
    fctx.body.push({ op: "drop" }); // drop thisArg
    return externRef;
  }
  fctx.body.push({ op: "call", funcIdx: arrNewResolvedIdx });
  const argsArrayLocal = allocLocal(fctx, `__bind_args_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: argsArrayLocal });
  for (let i = 1; i < args.length; i++) {
    fctx.body.push({ op: "local.get", index: argsArrayLocal });
    const argExpr = args[i]!;
    if (ts.isSpreadElement(argExpr)) {
      // Spread in bind partials is rare — coerce the spread argument to
      // externref and let the host accept it as a single value. Real spread
      // handling would need iterable expansion at compile time.
      const t = compileExpression(ctx, fctx, argExpr.expression, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
    } else {
      const t = compileExpression(ctx, fctx, argExpr, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
    }
    fctx.body.push({ op: "call", funcIdx: arrPushResolvedIdx });
  }
  fctx.body.push({ op: "local.get", index: argsArrayLocal });

  // 4. Push nameHint (string externref or ref.null.extern).
  if (targetName) {
    fctx.body.push(...stringConstantExternrefInstrs(ctx, targetName));
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // 5. Push lengthHint i32 (-1 = unknown).
  fctx.body.push({ op: "i32.const", value: targetLength });

  // 6. Call __bind_function. Result is externref.
  const bindIdx = ensureLateImport(
    ctx,
    "__bind_function",
    [externRef, externRef, externRef, externRef, i32Ty],
    [externRef],
  );
  flushLateImportShifts(ctx, fctx);
  const bindResolvedIdx = ctx.funcMap.get("__bind_function") ?? bindIdx;
  if (bindResolvedIdx === undefined) {
    // Should not happen in host mode — drop the staged args and degrade.
    fctx.body.push({ op: "drop" }); // length hint
    fctx.body.push({ op: "drop" }); // name hint
    fctx.body.push({ op: "drop" }); // args array
    fctx.body.push({ op: "drop" }); // thisArg
    // Leave receiver on the stack as identity-bind fallback.
    return externRef;
  }
  fctx.body.push({ op: "call", funcIdx: bindResolvedIdx });
  return externRef;
}

/**
 * (#1337) True when the callee expression denotes a variable whose initializer
 * is a `Function.prototype.bind` result — i.e. its runtime value is a host
 * bound-function externref. Mirrors the `isBindHostCall` detector in
 * statements/variables.ts (which forces the local to externref). Only the
 * single-assignment `const`/`let`/`var = fn.bind(...)` form is recognised; this
 * matches the bulk of the test262 bound-function-invocation corpus.
 */
export function calleeIsBoundFunctionVar(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  const init = decl.initializer;
  if (!ts.isCallExpression(init)) return false;
  const callee = init.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  // Direct `<receiver>.bind(...)`.
  if (callee.name.text === "bind") return true;
  // Indirect `Function.prototype.bind.call(fn, ...)`.
  if (
    callee.name.text === "call" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "bind" &&
    ts.isPropertyAccessExpression(callee.expression.expression) &&
    callee.expression.expression.name.text === "prototype" &&
    ts.isIdentifier(callee.expression.expression.expression) &&
    callee.expression.expression.expression.text === "Function"
  ) {
    return true;
  }
  return false;
}

/**
 * (#1712 / #1941) Static gate for the host-callable dispatch fallback.
 *
 * The callable-param dispatch below emits an extra `__call_function` arm so a
 * callee that arrives as a non-closure externref (a host builtin held in a JS
 * variable — acorn's `var hasOwn = Object.hasOwn || function(…){…}`) dispatches
 * through the host instead of trapping on `struct.get` of a null cast. That arm
 * is only ever *taken* when the runtime value is NOT a wasm closure struct, but
 * it was emitted for EVERY callable-param dispatch, which unconditionally pulls
 * `__js_array_new` / `__js_array_push` / `__call_function` host imports into the
 * module — even for pure local-closure programs (`applyTwice((x)=>x+1, 10)`,
 * `const add5 = makeAdder(5)`) that need no JS host at all. That regressed the
 * #1941 optimize-differential gate (LinkError: `__js_array_new` not provided)
 * and violated the dual-mode "JS host optional" principle for these programs.
 *
 * Gate the fallback to callees whose runtime value can plausibly be a foreign
 * (non-wasm-closure) callable: a variable whose initializer references a host
 * builtin member directly (`var f = Object.hasOwn`) or as the left operand of a
 * `||` / `??` short-circuit (`Object.hasOwn || function(){}`). Function
 * parameters and locals/globals initialized from wasm expressions (closures,
 * local function results) are always wrapped into the closure struct by the
 * call-site coercion, so the fallback can never fire for them — and we must not
 * burden them with host imports.
 */
export function calleeMayBeHostCallable(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;

  // Does `node` reference a host-builtin member (Object.hasOwn, Math.max, …)?
  const isHostBuiltinMember = (node: ts.Expression): boolean => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      const recv = inner.expression;
      return ts.isIdentifier(recv) && BUILTIN_CLASS_NAMES.has(recv.text);
    }
    return false;
  };

  // Unwrap `<host> || fn` / `<host> ?? fn` short-circuit fallbacks (and nested
  // chains), checking whether any reachable left operand is a host builtin.
  const initMayBeHost = (node: ts.Expression): boolean => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    if (isHostBuiltinMember(inner)) return true;
    if (
      ts.isBinaryExpression(inner) &&
      (inner.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return initMayBeHost(inner.left) || initMayBeHost(inner.right);
    }
    return false;
  };

  return initMayBeHost(decl.initializer);
}

/**
 * (#2028) Is `expr` an identifier resolving to a parameter of a **Promise
 * executor** — the `(resolve, reject) => {…}` arrow/function-expression passed
 * directly to `new Promise(...)`?
 *
 * Those params are bound by the host (native `new Promise` calls the executor
 * with real JS `resolve`/`reject` functions), so they arrive as plain externref
 * JS callables, NOT wasm closure structs. Calling them through the closure-struct
 * `ref.test`/`ref.cast`/`struct.get`/`call_ref` dispatch path nulls the cast and
 * traps on the null deref — they must take the `__call_function` arm instead.
 *
 * This is intentionally narrow. An ordinary callable parameter (`cb` in
 * `function apply(cb, v) { return cb(v); }`) is ALSO lowered with an `externref`
 * wasm type — the closure struct is recovered dynamically at the call site via
 * `ref.test (ref $closure)`. So "externref-typed callable param" alone is NOT a
 * safe discriminator: gating on it would re-emit the `__call_function` arm for
 * pure local-closure programs and regress the #1941 dual-mode guarantee. The
 * precise signal is that the param's *declaring function is a Promise executor*
 * (an arrow/function-expression that is the direct argument of `new Promise`),
 * whose param values are genuinely host-supplied.
 */
export function calleeIsPromiseExecutorParam(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  // The parameter's declaring function must be the executor of `new Promise(...)`:
  // an arrow / function expression that is a direct argument of a `new Promise`.
  const fn = decl.parent;
  if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return false;
  const argParent = fn.parent;
  if (!argParent || !ts.isNewExpression(argParent)) return false;
  const ctor = argParent.expression;
  if (!ts.isIdentifier(ctor) || ctor.text !== "Promise") return false;
  // Confirm the executor is actually in the argument list (not, e.g., a type arg).
  const fnNode: ts.Node = fn;
  return (argParent.arguments ?? []).some((a) => a === fnNode);
}

/**
 * (#1528 / #56 follow-up — class-ctor arm) Is `expr` an identifier resolving to a
 * parameter of a function that is used as a Promise-combinator CAPABILITY
 * CONSTRUCTOR — i.e. the `executor` of a `function Constructor(executor){…}` that
 * flows to `Promise.{all,allSettled,race,any}.call(Constructor, …)`?
 *
 * V8's `NewPromiseCapability(Constructor)` does `Construct(Constructor, «executor»)`
 * (run via #1632b-2's closure-construct bridge). Inside the compiled body the call
 * `executor(resolve, reject)` is a call of a function-typed PARAMETER whose value
 * is a HOST function V8 supplied — NOT a wasm closure struct. The default
 * closure-struct `ref.cast`/`call_ref` dispatch then `illegal cast`s; such a param
 * must take the `__call_function` host-callable arm instead. This mirrors the
 * Promise-executor-param case (#2028) but for the capability-constructor entry.
 *
 * Gate is SYNTACTIC and narrow (NOT whole-program escape analysis), to preserve
 * the #1941 dual-mode guarantee: the param's declaring function must be a
 * `function` declaration / named function-expression whose identifier appears as
 * the FIRST argument of a `Promise.<combinator>.call(...)` somewhere in the
 * source file. Only such functions are entered as capability constructors with
 * host-supplied params; ordinary callable params never match.
 */
export function calleeIsCapabilityCtorParam(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  // The declaring function: a FunctionDeclaration, or a function/arrow expression
  // bound to a variable (so it has a stable referenceable name).
  const fn = decl.parent;
  let fnName: string | undefined;
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    fnName = fn.name.text;
  } else if (
    (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) &&
    fn.parent &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    fnName = fn.parent.name.text;
  }
  if (fnName === undefined) return false;
  // Scan the source file for `Promise.<combinator>.call(<fnName>, …)`.
  // (#2671) `Promise.resolve` / `Promise.reject` are ALSO capability-ctor
  // sites: V8's `Promise.resolve.call(C)` → PromiseResolve(C) →
  // NewPromiseCapability(C) → `Construct(C, «GetCapabilitiesExecutor»)`. The
  // user fn's `executor` param therefore receives a host executor and must
  // wrap its closure args host-callable through `__call_function`, exactly
  // like the four aggregators (executor-function-* test262 family).
  const COMBINATORS = new Set(["all", "allSettled", "race", "any", "resolve", "reject"]);
  const sf = decl.getSourceFile();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // `Promise.<combinator>.call(<id>, …)` — `(Promise.X).call`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "call" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "Promise" &&
      COMBINATORS.has(node.expression.expression.name.text)
    ) {
      // Unwrap `as`/paren/non-null on the capability arg so
      // `Promise.X.call(Constructor as any, …)` matches the bare-identifier form.
      let firstArg = node.arguments[0];
      while (
        firstArg &&
        (ts.isAsExpression(firstArg) || ts.isParenthesizedExpression(firstArg) || ts.isNonNullExpression(firstArg))
      ) {
        firstArg = firstArg.expression;
      }
      if (firstArg && ts.isIdentifier(firstArg) && firstArg.text === fnName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * (#1337) Emit a call to a host bound-function externref via the
 * `__call_function(fn, thisArg, argsArray)` host helper. The bound function
 * already carries [[BoundThis]] and [[BoundArguments]], so `thisArg` is passed
 * as `undefined` (ref.null.extern) and only the call-site arguments are packed.
 *
 * Returns `{ kind: "externref" }` on success, or `null` to let the caller fall
 * through to the normal dispatch (e.g. if late-import wiring fails).
 */
export function emitBoundFunctionCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | null {
  const externRef: ValType = { kind: "externref" };

  // 1. Compile callee → externref, stash in a local.
  const calleeType = compileExpression(ctx, fctx, expr.expression, externRef);
  if (calleeType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (calleeType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  const calleeLocal = allocLocal(fctx, `__bfn_callee_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  // 2. Build the arguments array (JS Array externref).
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  flushLateImportShifts(ctx, fctx);
  const arrNewResolvedIdx = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const arrPushResolvedIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  if (arrNewResolvedIdx === undefined || arrPushResolvedIdx === undefined) return null;

  fctx.body.push({ op: "call", funcIdx: arrNewResolvedIdx });
  const argsArrayLocal = allocLocal(fctx, `__bfn_args_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: argsArrayLocal });
  for (const argExpr of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsArrayLocal });
    const inner = ts.isSpreadElement(argExpr) ? argExpr.expression : argExpr;
    const t = compileExpression(ctx, fctx, inner, externRef);
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (t.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    fctx.body.push({ op: "call", funcIdx: arrPushResolvedIdx });
  }

  // 3. Call __call_function(callee, undefined, argsArray).
  const callIdx = ensureLateImport(ctx, "__call_function", [externRef, externRef, externRef], [externRef]);
  flushLateImportShifts(ctx, fctx);
  const callResolvedIdx = ctx.funcMap.get("__call_function") ?? callIdx;
  if (callResolvedIdx === undefined) return null;

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "ref.null.extern" }); // thisArg — bound fn carries [[BoundThis]]
  fctx.body.push({ op: "local.get", index: argsArrayLocal });
  fctx.body.push({ op: "call", funcIdx: callResolvedIdx });
  return externRef;
}

/**
 * (#1116b) Resolve a Promise-combinator `thisArg`/receiver that names a
 * Wasm-compiled `class X extends Promise`.
 *
 * Such a class is externref-backed (#1366a/b): its instances are real host
 * Promises (built via `__new_Promise`), but the class *identifier itself* has
 * no class-object singleton global, so `compileExpression(MyPromise)` yields
 * `null`/opaque — and `Promise.all.call(MyPromise, iter)` then throws
 * `[object Object] is not a constructor` in V8. The fix: resolve the
 * identifier to a real JS-callable Promise subclass synthesized (and cached)
 * by the `__promise_subclass_ctor` host import, keyed on the class name.
 *
 * Returns true if it emitted a JS-constructor externref for `argExpr`; false
 * if the caller should fall back to plain `compileExpression`.
 */
function resolvePromiseSubclassThisArg(ctx: CodegenContext, fctx: FunctionContext, argExpr: ts.Expression): boolean {
  // (#2623 Slice B) Unified with the value-read path: both the combinator
  // `thisArg` receiver here and a bare-identifier read-as-value in
  // `identifiers.ts` now go through the same cached `__promise_subclass_ctor`
  // singleton, so the constructor the user observes IS the one used to build
  // the subclassed promise (one object, not two). Detection (parent-chain
  // walk, standalone gate) + emission live in `promise-subclass.ts`.
  return tryEmitPromiseSubclassReceiver(ctx, fctx, argExpr);
}

function usesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return false;
  }
  return forEachChild(node, usesArguments) ?? false;
}

/**
 * (#1397) Conservative scope-level reassignment scan: returns true if the
 * source file contains any assignment expression of the form `X.<method> = ...`
 * (any LHS expression, member name === `methodName`).
 *
 * Used to gate static-dispatch fast-paths for wrapper-type method calls
 * (`new String(...).toString()`, `new Number(...).valueOf()`, etc.) so that
 * sources that explicitly reassign these methods fall through to the
 * dynamic-dispatch path (`__extern_method_call`) and pick up the override
 * at runtime — preserving spec semantics where transferred prototype methods
 * throw TypeError on the wrong receiver type.
 *
 * Conservative scan rationale: scope-narrowing (only the enclosing function)
 * would miss patterns like `obj.toString = OtherType.prototype.toString`
 * defined at module scope and used inside a function. False positives
 * (sources that reassign in some unrelated branch) only cost the static
 * fast-path on wrapper objects — not a measurable perf hit because wrappers
 * are uncommon at runtime in real code.
 *
 * Cached per `(sourceFile, methodName)` so repeated calls are O(1).
 */
const _reassignmentCache = new WeakMap<ts.SourceFile, Map<string, boolean>>();
function sourceHasMethodReassignment(ctx: CodegenContext, anchor: ts.Node, methodName: string): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  let perFile = _reassignmentCache.get(sf);
  if (perFile === undefined) {
    perFile = new Map<string, boolean>();
    _reassignmentCache.set(sf, perFile);
  }
  const cached = perFile.get(methodName);
  if (cached !== undefined) return cached;

  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.name) &&
      node.left.name.text === methodName
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(sf);
  perFile.set(methodName, found);
  // Reference ctx so the parameter isn't unused — the cache is keyed on the
  // SourceFile (not ctx) but we keep ctx in the signature for future
  // refinements that need scope-narrowing or per-symbol resolution.
  void ctx;
  return found;
}

/**
 * (#1397) Emit a dynamic-dispatch method call on a wrapper-object receiver:
 *
 *   __extern_method_call(receiver, methodName, [])
 *
 * Used by the wrapper-reassignment branch at the top of compileMethodCall
 * to bypass the static fast-paths when source has reassigned the method.
 * Returns the result type (externref) on success, null if the necessary
 * runtime imports cannot be registered (caller falls through to the
 * static path as a best-effort fallback).
 */
export function emitWrapperDynamicMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
  methodName: string,
  callExpr?: ts.CallExpression,
): ValType | null {
  // (#1888 Slice 2) Standalone routes __extern_method_call native, which reads
  // its args over a $ObjVec — build the (empty) args list with the native
  // $ObjVec builder, not the host __js_array_new. JS-host keeps the host import.
  const arrNewIdx = ctx.standalone
    ? ensureObjVecBuilders(ctx).newIdx
    : ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  // (#1712) Args support: when a call expression with arguments is supplied,
  // pack them into the args array via __js_array_push. JS-host only — the
  // standalone $ObjVec path stays empty-args until it grows a native push.
  const wantArgs = callExpr !== undefined && callExpr.arguments.length > 0 && !ctx.standalone && !ctx.wasi;
  const arrPushIdx = wantArgs
    ? ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], [])
    : undefined;
  const methodCallIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || methodCallIdx === undefined) return null;
  if (wantArgs && arrPushIdx === undefined) return null;

  // Compile receiver as externref.
  const recvType = compileExpression(ctx, fctx, recvExpr, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Push method name as a string constant.
  addStringConstantGlobal(ctx, methodName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));

  // Args array: __js_array_new() → externref (+ per-arg __js_array_push).
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_new") ?? arrNewIdx });
  if (wantArgs) {
    const argsArrLocal = allocLocal(fctx, `__dynm_args_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argsArrLocal });
    for (const argExpr of callExpr!.arguments) {
      fctx.body.push({ op: "local.get", index: argsArrLocal });
      const t = compileExpression(ctx, fctx, argExpr, { kind: "externref" });
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        coerceType(ctx, fctx, t, { kind: "externref" });
      }
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_push") ?? arrPushIdx! });
    }
    fctx.body.push({ op: "local.get", index: argsArrLocal });
  }

  // Re-lookup methodCallIdx in case args compilation triggered shifts.
  const finalMcIdx = ctx.funcMap.get("__extern_method_call") ?? methodCallIdx;
  fctx.body.push({ op: "call", funcIdx: finalMcIdx });
  return { kind: "externref" };
}

/**
 * Emit `global.set __argc` with the actual call-site argument count.
 * This communicates how many args were really passed so the callee can
 * build a correctly-sized `arguments` object (per ES spec, arguments.length
 * equals the number of args passed, not the number of formal params).
 * Only emitted when the callee is known to use `arguments`.
 */
function emitSetArgc(ctx: CodegenContext, fctx: FunctionContext, actualArgCount: number, paramCount: number): void {
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  // Set __argc = min(actualArgCount, paramCount) — the count of formal param
  // slots actually filled. Overflow args are in __extras_argv and tracked by
  // extrasLen, so totalLen = argc + extrasLen gives the correct arguments.length.
  const argc = Math.min(actualArgCount, paramCount);
  fctx.body.push({ op: "i32.const", value: argc });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx });
}

/**
 * Reset the __argc and __extras_argv globals to their sentinel values
 * (-1 / null). Used after closure / indirect call paths where we set the
 * globals unconditionally but can't be sure the callee consumed them
 * (its prologue only consumes when the body reads `arguments`). Without
 * cleanup, a subsequent function that does read `arguments` would
 * inherit a stale extras_argv and produce a wrong arguments.length.
 * (#1511)
 */
export function emitResetArgcExtras(ctx: CodegenContext, fctx: FunctionContext): void {
  const { globalIdx: extrasGlobalIdx, vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  fctx.body.push({ op: "ref.null", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "global.set", index: extrasGlobalIdx });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx });
}

/**
 * For indirect (closure / call_ref) call paths where the callee is not
 * statically known, set `__argc` and (if there are overflow args) build
 * `__extras_argv` from the call-site args beyond `paramCount`. The
 * lifted callee's prologue reads these to compute `arguments.length`
 * correctly even when more args were passed than the lifted function's
 * formal signature accepts.
 *
 * Must be called AFTER the formal args have been compiled / pushed onto
 * the stack (or saved to locals), but BEFORE the call_ref. Pair with
 * `emitResetArgcExtras` after the call to prevent stale-extras leaking
 * into a subsequent callee that DOES read `arguments`. (#1511)
 */
export function emitClosureCallArgcExtras(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  paramCount: number,
): void {
  if (args.length > paramCount) {
    emitSetExtrasArgv(ctx, fctx, args as unknown as ts.Expression[], paramCount);
  }
  emitSetArgc(ctx, fctx, args.length, paramCount);
}

/**
 * Build the wasm instructions that set `__extras_argv` from a list of
 * pre-saved externref locals, and `__argc` to (paramCount + extrasLocals.length).
 *
 * Used by indirect-call paths that have already compiled overflow args
 * into externref locals (so we don't re-evaluate side effects). The
 * returned instruction list leaves the wasm value stack unchanged.
 * (#1511)
 */
export function buildArgcExtrasSetupFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramCount: number,
  extrasLocals: number[],
): Instr[] {
  const out: Instr[] = [];
  const callArgCount = paramCount + extrasLocals.length;
  if (extrasLocals.length > 0) {
    const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTi } = ensureExtrasArgvGlobal(ctx);
    const extrasArrTi = getArrTypeIdxFromVec(ctx, extrasVecTi);
    for (const el of extrasLocals) {
      out.push({ op: "local.get", index: el });
    }
    out.push({ op: "array.new_fixed", typeIdx: extrasArrTi, length: extrasLocals.length });
    const arrTmp = allocLocal(fctx, `__extras_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: extrasArrTi });
    out.push({ op: "local.set", index: arrTmp });
    out.push({ op: "i32.const", value: extrasLocals.length });
    out.push({ op: "local.get", index: arrTmp });
    out.push({ op: "struct.new", typeIdx: extrasVecTi });
    out.push({ op: "global.set", index: extrasGlobalIdx });
  }
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  out.push({ op: "i32.const", value: Math.min(callArgCount, paramCount) });
  out.push({ op: "global.set", index: argcGlobalIdx });
  return out;
}

/**
 * Build the wasm instructions that reset `__argc` and `__extras_argv` to
 * their sentinel values. Useful for inlining into dispatch arms / if
 * bodies. The returned list leaves the wasm value stack unchanged.
 * (#1511)
 */
export function buildArgcExtrasReset(ctx: CodegenContext): Instr[] {
  const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTi } = ensureExtrasArgvGlobal(ctx);
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  return [
    { op: "ref.null", typeIdx: extrasVecTi },
    { op: "global.set", index: extrasGlobalIdx },
    { op: "i32.const", value: -1 },
    { op: "global.set", index: argcGlobalIdx },
  ];
}

/**
 * Reset `__argc` to its -1 sentinel and `__extras_argv` to null WITHOUT
 * lazily creating either global. Unlike {@link buildArgcExtrasReset}, this
 * never calls `ensureExtrasArgvGlobal` — so it cannot register the
 * `__extras_argv` vec heap type for the FIRST time mid-function-body.
 *
 * Why this matters (#2704 / PR #2149): the multi-funcref dispatch arm builds
 * its ref.test/ref.cast/call_ref chain (with type indices already resolved)
 * BEFORE emitting the post-dispatch reset. The preceding setup only registers
 * `__extras_argv` when the call actually has overflow args; a 0-extras callback
 * (e.g. the `() => void` thunk passed to `assert.throws`) leaves it
 * unregistered. Calling `ensureExtrasArgvGlobal` from the reset then becomes
 * the FIRST registration of that global/type at a point where the surrounding
 * function body has already been partially emitted — which desynced codegen
 * and silently miscompiled `new Map/WeakMap/WeakSet(iterable)` inside the
 * callback so it no longer threw (4-test merge_group regression).
 *
 * Resetting `__argc` is always safe (it is an i32 global with no heap type and
 * is already registered by the preceding setup). `__extras_argv` only needs a
 * reset when it was actually used / previously registered: if it was never
 * registered it still holds its null initializer, so there is nothing to leak
 * (#1511) and skipping the reset is correct.
 */
export function buildArgcResetNoLazyExtras(ctx: CodegenContext): Instr[] {
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const out: Instr[] = [];
  if (ctx.extrasArgvGlobalIdx >= 0) {
    out.push({ op: "ref.null", typeIdx: ctx.extrasArgvVecTypeIdx });
    out.push({ op: "global.set", index: ctx.extrasArgvGlobalIdx });
  }
  out.push({ op: "i32.const", value: -1 });
  out.push({ op: "global.set", index: argcGlobalIdx });
  return out;
}

/**
 * Flatten call-site arguments, expanding spread elements on array literals
 * into individual expressions. Returns the flat list of expressions.
 * For spread on non-literal arrays, returns null (cannot flatten at compile time).
 */
function flattenCallArgs(args: readonly ts.Expression[]): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (ts.isArrayLiteralExpression(arg.expression)) {
        for (const el of arg.expression.elements) {
          result.push(el);
        }
      } else {
        return null;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * (#2707c) Does a named function expression's body reference its OWN name? Used
 * to decide whether a `(function f(){ … })()` IIFE is *recursive* and therefore
 * cannot be inlined (the inlined body would have no callable to bind `f` to).
 *
 * Conservative — returns true on ANY identifier occurrence of the own name
 * inside the body, without resolving shadowing. That is safe because the only
 * consequence is compiling the IIFE as a closure instead of inlining it, which
 * is always semantically correct; a false positive merely forgoes the inline
 * optimization. We do NOT descend into nested function/class scopes that
 * re-declare the name as their own (those are separate bindings), to keep the
 * conservative over-approximation from being needlessly broad.
 */
function functionExprBodyReferencesOwnName(fn: ts.FunctionExpression): boolean {
  if (!fn.name) return false;
  const ownName = fn.name.text;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // A nested function/method that declares a parameter or its own name equal
    // to ownName shadows it — but to stay conservative+simple we still descend;
    // a self-call to a shadowing inner binding only ever causes a (correct)
    // closure compile. Identifier match = treat as self-reference.
    if (ts.isIdentifier(node) && node.text === ownName) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function compileOptionalDirectCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  const callee = expr.expression as ts.Identifier;
  const calleeType = compileExpression(ctx, fctx, callee);
  if (!calleeType) return null;

  if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null" && calleeType.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    const syntheticCall = ts.factory.createCallExpression(callee, expr.typeArguments, expr.arguments);
    ts.setTextRange(syntheticCall, expr);
    return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
  }

  const tmp = allocLocal(fctx, `__optdcall_${fctx.locals.length}`, calleeType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  let resultType: ValType = { kind: "externref" };
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      const resolved = resolveWasmType(ctx, retType);
      resultType = resolved.kind === "ref" ? { kind: "ref_null", typeIdx: resolved.typeIdx } : resolved;
    }
  }

  const savedBody = pushBody(fctx);
  const funcName = callee.text;
  const closureInfo = ctx.closureMap.get(funcName);
  const funcIdx = ctx.funcMap.get(funcName);
  let resolved = false;

  if (closureInfo && (calleeType.kind === "ref" || calleeType.kind === "ref_null")) {
    fctx.body.push({ op: "local.get", index: tmp });
    if (calleeType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    const closureTmp = allocLocal(fctx, `__optdcall_cls_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: calleeType.typeIdx,
    });
    fctx.body.push({ op: "local.tee", index: closureTmp });
    fctx.body.push({ op: "local.get", index: closureTmp });
    for (const arg of expr.arguments) compileExpression(ctx, fctx, arg);
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    resolved = true;
  } else if (funcIdx !== undefined) {
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    for (let i = 0; i < expr.arguments.length; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
    }
    if (paramTypes) {
      const optInfo = ctx.funcOptionalParams.get(funcName);
      for (let i = expr.arguments.length; i < paramTypes.length; i++) {
        const opt = optInfo?.find((o) => o.index === i);
        if (opt) {
          pushParamSentinel(fctx, paramTypes[i]!, ctx, opt);
        } else {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
      maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, paramTypes.length);
    }
    fctx.body.push({ op: "call", funcIdx });
    resolved = true;
  }

  if (!resolved) fctx.body.push(...defaultValueInstrs(resultType));

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}

/**
 * Classify an eval call expression as `direct`, `indirect`, or `none`.
 *
 * Per ECMA-262 §19.2.1, a *direct* eval is a call whose callee is the
 * lexical Identifier `eval` (after stripping parentheses).  Anything that
 * forces a reference resolution detour — `(0, eval)(...)` or any other
 * non-Identifier callee that resolves to the eval function — is *indirect*.
 *
 * The compiler-side flag is forwarded to `__extern_eval` so the host shim
 * can preserve the spec-mandated scope distinction (#1164).  Direct eval
 * runs in the caller's lexical scope; indirect eval runs in global scope.
 *
 * Uses the TypeScript checker to verify that any `eval` identifier resolves
 * to the *global* eval, not a locally-shadowed variable or parameter named
 * `eval` (e.g. `function foo(eval) { return eval(42); }`).
 */
function classifyEvalCallExpression(expr: ts.CallExpression, checker: ts.TypeChecker): "direct" | "indirect" | "none" {
  if (expr.questionDotToken) return "none";
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee) && callee.text === "eval") {
    if (isGlobalEvalIdentifier(callee, checker)) return "direct";
    return "none";
  }
  // Indirect form: (0, eval)(src) — a comma expression whose right side is `eval`.
  if (
    ts.isBinaryExpression(callee) &&
    callee.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    ts.isIdentifier(callee.right) &&
    callee.right.text === "eval"
  ) {
    if (isGlobalEvalIdentifier(callee.right, checker)) return "indirect";
    return "none";
  }
  return "none";
}

/**
 * #1229 peephole — detect `eval("/" + X + "/")` and rewrite to `new RegExp(X)`.
 *
 * Test262's BMP-codepoint regex tests are 65k-iteration loops that build a
 * regex literal via eval per iteration:
 *
 * ```js
 * for (var cu = 0; cu <= 0xffff; ++cu) {
 *   var pattern = eval("/" + xx + "/");
 * }
 * ```
 *
 * Each `eval()` call on js2wasm pays the full TS-parse + js2wasm-codegen +
 * Wasm-instantiate pipeline (~50ms). 65,536 × 50ms = an hour of wall-clock,
 * so the test always hits the 30s pool ceiling. By detecting the literal-
 * fence shape `"/" + X + "/"` we can route directly to the RegExp
 * constructor host call — same observable semantics for any code that
 * inspects `.source` / `.flags` / matching behavior, but ~one
 * host-call's worth of work instead of two.
 *
 * Returns:
 *   - `InnerResult` (with stack push of the constructed RegExp externref) on match
 *   - `undefined` if the AST shape doesn't match — caller falls through
 */
function tryEvalAsRegExpPeephole(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  // #1474 — this peephole desugars `eval("/" + X + "/")` to a RegExp_new
  // host call. RegExp has no Wasm-native engine yet, so refuse to register
  // the host import in --target standalone (eval itself is also host-only).
  if (ctx.standalone) return undefined;
  if (expr.arguments.length !== 1) return undefined;

  // Strip parens around the argument.
  let arg = expr.arguments[0]!;
  while (ts.isParenthesizedExpression(arg)) arg = arg.expression;

  // Outer shape: BinaryExpression(`+`, BinaryExpression(`+`, "/", X), "/")
  // (left-associative `+`).
  if (!ts.isBinaryExpression(arg)) return undefined;
  if (arg.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  if (!ts.isStringLiteral(arg.right)) return undefined;
  if (arg.right.text !== "/") return undefined;

  let inner: ts.Expression = arg.left;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isBinaryExpression(inner)) return undefined;
  if (inner.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  if (!ts.isStringLiteral(inner.left)) return undefined;
  if (inner.left.text !== "/") return undefined;

  const xExpr = inner.right;

  // Register `RegExp_new(pattern, flags) -> externref` on demand. The 7 target
  // tests (regexp/S7.8.5_*, comments/S7.4_A6, AnnexB/RegExp/RegExp-*-escape-BMP)
  // build their regex via eval *only* — they never write `new RegExp(...)` or a
  // `/.../` literal in source, so the pre-pass scan in `index.ts` does NOT
  // register `RegExp_new` and `ctx.externClasses` does NOT contain a `"RegExp"`
  // entry at this point. We mirror the on-demand registration pattern from
  // `compileRegExpLiteral` (`src/codegen/typeof-delete.ts:172-180`) so the
  // peephole works even when the source has no other RegExp use.
  //
  // Both the import AND a minimal externClasses entry are needed: the host
  // import resolver (`src/compiler/import-manifest.ts:46-51`) only routes
  // `RegExp_new` to the extern_class constructor when "RegExp" is in
  // `mod.externClasses`. Without that entry, the resolver falls through to
  // the "builtin" branch, which has no handler for `RegExp_new` and resolves
  // to a no-op that returns undefined — making the produced "regex" undefined
  // at runtime even though codegen looked correct.
  if (!ctx.externClasses.has("RegExp")) {
    ctx.externClasses.set("RegExp", {
      importPrefix: "RegExp",
      namespacePath: [],
      className: "RegExp",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }],
      methods: new Map(),
      properties: new Map(),
    });
  }
  let funcIdx = ctx.funcMap.get("RegExp_new");
  if (funcIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const regexpNewType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "RegExp_new", { kind: "func", typeIdx: regexpNewType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    funcIdx = ctx.funcMap.get("RegExp_new");
  }
  if (funcIdx === undefined) return undefined;

  // Argument 0: pattern source (X compiled to externref).
  compileExpression(ctx, fctx, xExpr, { kind: "externref" });
  // Argument 1: flags — empty string. The eval-of-regex shape is
  // `eval("/" + X + "/")` with no flag tail, so flags is always "".
  const emptyFlagsResult = compileStringLiteral(ctx, fctx, "", expr);
  if (!emptyFlagsResult) return undefined;
  const finalIdx = ctx.funcMap.get("RegExp_new") ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalIdx });
  return { kind: "externref" };
}

/** Returns true if the given `eval` identifier resolves to the global eval function (not a local shadow). */
function isGlobalEvalIdentifier(ident: ts.Identifier, checker: ts.TypeChecker): boolean {
  const sym = checker.getSymbolAtLocation(ident);
  if (!sym) return true; // unresolved → assume global eval
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  // Global eval is declared only in .d.ts files. A local shadow has at least one
  // declaration in a non-declaration (.ts) source file.
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * (#3145) True when `ident` refers to a GLOBAL builtin binding (declared only in
 * ambient .d.ts lib files) that is NOT shadowed by a local or captured variable
 * in the current function. Gates builtin-namespace call lowerings (e.g.
 * `Atomics.<m>(...)`) so a user `const Atomics = { … }` never hijacks the
 * fast path. Mirrors `isGlobalEvalIdentifier` with the extra local/capture
 * guard the namespace case needs.
 */
export function isGlobalBuiltinIdentifier(ctx: CodegenContext, fctx: FunctionContext, ident: ts.Identifier): boolean {
  if (fctx.localMap.has(ident.text)) return false;
  if (fctx.boxedCaptures?.has(ident.text)) return false;
  return isGlobalEvalIdentifier(ident, ctx.checker);
}

/**
 * (#2754) Eagerly register the funcref-wrapper closure types for every no-capture
 * `function` DECLARATION that is referenced as a VALUE (passed as an argument,
 * assigned, returned — anything other than a direct call/`new` callee) somewhere
 * in the source file.
 *
 * Why: the inline dynamic-dispatch path (`tryEmitInlineDynamicCall`) builds its
 * `ref.test`/`call_ref` arms from `ctx.closureInfoByTypeIdx` — the wrappers
 * registered SO FAR. A top-level function's wrapper is otherwise registered only
 * LAZILY, at the value site that references it (`emitFuncRefAsClosure`). When that
 * site lives in a later-compiled function (e.g. `main` calling
 * `runNmHost(denoRead, …)`) but the param is invoked from an earlier-compiled
 * body (`read(tmp)` inside `readFillExact`), the dispatch sees ZERO candidates and
 * silently lowers the call to `ref.null.extern` — the function value is never
 * invoked. Pre-registering the wrapper TYPE here (the trampoline is still emitted
 * lazily at the value site; `getOrCreateFuncRefWrapperTypes` is signature-cached,
 * so both sites share one type) makes the candidate visible regardless of compile
 * order.
 *
 * Idempotent (guarded by a per-module flag) and scoped to no-capture function
 * declarations actually used as values, so it is a no-op for programs without
 * function-valued declarations.
 */
function ensureFuncValueWrappersRegistered(ctx: CodegenContext, sf: ts.SourceFile): void {
  const flag = ctx as unknown as { __funcValueWrappersRegistered?: boolean };
  if (flag.__funcValueWrappersRegistered) return;
  flag.__funcValueWrappersRegistered = true;

  const usedAsValue = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isCallee = p && ts.isCallExpression(p) && p.expression === node;
      const isNewCallee = p && ts.isNewExpression(p) && p.expression === node;
      const isOwnName =
        p &&
        (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) &&
        (p as ts.FunctionLikeDeclaration).name === node;
      if (!isCallee && !isNewCallee && !isOwnName) {
        const sym = ctx.checker.getSymbolAtLocation(node);
        const decl = sym?.valueDeclaration;
        if (decl && ts.isFunctionDeclaration(decl) && decl.name) {
          usedAsValue.add(decl.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const name of usedAsValue) {
    const funcIdx = ctx.funcMap.get(name);
    if (funcIdx === undefined) continue;
    // Captured functions register a CUSTOM capture-struct subtype at their value
    // site (emitFuncRefAsClosure's capture path); the runtime value is that
    // struct, not the bare base wrapper, so pre-registering only the base wrapper
    // here would not match. Leave those to the lazy value-site path.
    const caps = ctx.nestedFuncCaptures.get(name);
    if (caps && caps.length > 0) continue;
    const sig = getFuncSignature(ctx, funcIdx);
    if (!sig) continue;
    getOrCreateFuncRefWrapperTypes(ctx, sig.params, sig.results);
  }

  // (#2939) Nested-scope function-expression / arrow callbacks. A callback like
  // `testWith*Constructors(function (TA) { … })` defined INSIDE another function
  // (e.g. the test262 runner's `export function test()` wrapper) registers its
  // funcref-wrapper type only LAZILY when its value site compiles — which is
  // inside a body compiled AFTER the higher-order function whose `fn(...)`
  // dispatch needs the candidate. So the dispatch (`tryEmitInlineDynamicCall`)
  // saw ZERO candidates and silently dropped the call — the ~814 vacuous
  // `testWith*Constructors` harness passes (round-4 leak analysis). Pre-register
  // the SAME wrapper type (computeClosureWrapperSig ≡ the value-site logic;
  // getOrCreateFuncRefWrapperTypes is signature-cached, so the value site reuses
  // it — a capturing callback's custom subtype still shares this funcTypeIdx,
  // which is what the dispatch discriminates on) for every func-expr / arrow used
  // as a call argument or a variable initializer.
  //
  // (#3074) Applied on BOTH lanes. It was originally standalone-gated for
  // byte-inertness on the gc/host lane, but that left the DEFAULT lane's
  // harness-wrapper cluster (`testWith*TypedArrayConstructors(function(TA){…})`)
  // stuck vacuous — measured at 1,535 default records vs 448 standalone, i.e.
  // the LARGER cluster (#3074). Empirically the harness callback compiles to a
  // real closure struct on the gc lane too (`ref.func …; struct.new $__fn_wrap_*;
  // extern.convert_any` — verified via WAT), so the runtime value flowing into
  // the higher-order body IS a wrapper struct that `tryEmitInlineDynamicCall`
  // dispatches correctly; the ONLY reason the gc lane dropped the call was the
  // compile-order candidate gap this pre-registration closes (identical to the
  // declaration loop above, which already runs un-gated on both lanes).
  //
  // Safety on the gc lane (the two reasons for the old gate, both addressed):
  //  1. Byte change on the default lane — intended: #3074 wants the gc lane
  //     fixed, and the affected tests are ALL currently VACUOUS FAILS
  //     (`return -262`), so dispatch can only move them fail→pass or stay fail
  //     (never a pass→fail regression). The caller's only alternative to a
  //     successful inline dispatch is the graceful `ref.null.extern` drop, so
  //     enabling dispatch is a strict improvement.
  //  2. A callback that instead takes the `__make_callback` host path (passed
  //     to a host builtin, e.g. `arr.map(cb)`) never materializes a wrapper
  //     STRUCT — only the wrapper TYPE is pre-registered here (the trampoline /
  //     struct.new stays lazy at the value site). So an extra dispatch arm for
  //     that signature never `ref.test`-matches the JS-function externref at
  //     runtime → falls through to the default → same drop as before. No
  //     behavior change for `__make_callback` callbacks, only the harness /
  //     compiled-HOF callbacks gain dispatch. `getOrCreateFuncRefWrapperTypes`
  //     is signature-cached, so the value site reuses the same funcTypeIdx —
  //     no index inconsistency (the declaration loop already relies on this).
  {
    const seenFnNodes = new Set<ts.Node>();
    const usedAsValueFn = (node: ts.FunctionExpression | ts.ArrowFunction): void => {
      if (seenFnNodes.has(node)) return;
      seenFnNodes.add(node);
      const { params, returnType } = computeClosureWrapperSig(ctx, node);
      // (#2939) Restrict pre-registration to the ALL-EXTERNREF callback shape
      // (externref params + externref/void return). This is exactly the harness
      // callback shape (`function(TA, makeCtorArg)` — `any` params) — the whole
      // ~1421-test target population. A candidate with a NUMERIC (f64/i32) param
      // in an OVER-ARITY position mints a malformed dispatch arm in the
      // higher-order body (`call[0] expected externref, found f64…`) — the
      // over-arity numeric-pad + box path in `tryEmitInlineDynamicCall` is not
      // sound for a speculatively-registered candidate that never matches a real
      // runtime value. Numeric-mixed nested callbacks stay lazily-registered
      // (unchanged from base — they were never candidates), so this both fixes
      // the invalid-Wasm CE and keeps the fix's blast radius to the harness
      // class. (Inner numeric-param callbacks like `findLastIndex(fn)` dispatch
      // via the array-method path, never this inline dispatcher.)
      const allExternref = params.every((p) => p.kind === "externref");
      const externrefOrVoidReturn = returnType === null || returnType.kind === "externref";
      if (!allExternref || !externrefOrVoidReturn) return;
      getOrCreateFuncRefWrapperTypes(ctx, params, returnType ? [returnType] : []);
    };
    const visitFns = (node: ts.Node): void => {
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        const p = node.parent;
        const isCallArg = p && ts.isCallExpression(p) && p.arguments.some((a) => a === node);
        const isVarInit = p && ts.isVariableDeclaration(p) && p.initializer === node;
        // A generator function-expression's value is a Generator object, not a
        // plain closure the inline dispatcher marshals; skip (its wrapper type
        // is externref-returning and harmless, but leave it to the value site).
        const isGen = ts.isFunctionExpression(node) && node.asteriskToken !== undefined;
        if ((isCallArg || isVarInit) && !isGen) usedAsValueFn(node);
      }
      ts.forEachChild(node, visitFns);
    };
    visitFns(sf);
  }
}

/**
 * #1063 Part B: inline dynamic-dispatch for an identifier callee whose static
 * type is `any` (externref) but which may hold a wrapped closure struct at
 * runtime (e.g. `function outer(op: any) { return function (x) { return op(x); } }`).
 *
 * Emits a `ref.test`/`ref.cast`/`struct.get`/`call_ref` chain against every
 * closure struct type in the module whose arity can satisfy the call's arg
 * count. Mirrors `emitClosureCallExport` (__call_fn_0) but specialized to
 * arity N with inline arg marshalling.
 *
 * (#820 / #1543) Two correctness fixes vs. the original exact-arity form:
 *
 *  1. **Discriminate by funcref signature, not struct type.** All
 *     `__fn_wrap_*` closure structs subtype a single *root* wrapper struct
 *     (`getOrCreateFuncRefWrapperTypes` chains every later signature under
 *     the first one created). So `ref.test (ref <some-wrapper-struct>)`
 *     matches wrapper values of *every* arity, not just the candidate's.
 *     A 0-arg call to an extracted 1-formal async-generator method then
 *     matched the arity-0 root arm, did `struct.get 0` + `ref.cast (ref
 *     <arity-0 funcType>)` on an arity-1 funcref, and trapped with `illegal
 *     cast` — the entire `async-gen-meth-dflt-*` test262 cluster. We instead
 *     test the *funcref* (`ref.test (ref funcTypeIdx)`), which encodes the
 *     exact param count + result, so each arm fires only for its own
 *     signature regardless of struct subtyping.
 *
 *  2. **Adapt arity by padding missing trailing args with `undefined`.**
 *     A candidate whose formal-param count is *greater than* the call arity
 *     is now eligible (ES calls a function with fewer args than formals,
 *     filling the rest with `undefined`). Without this a 0-arg call to a
 *     1-formal method found no candidate and silently returned `undefined`
 *     instead of invoking the method (which must apply its default param and
 *     run the destructure / initializer the spec mandates).
 *
 * Returns `{ kind: "externref" }` on success, or `null` to let the caller
 * fall back to the existing `ref.null.extern` behavior.
 */
/**
 * (#3166) Resolve the receiver of an element-access expression to a
 * user-defined class name (present in `ctx.classSet`, incl. class expressions
 * aliased via `classExprNameMap`), or `undefined`. Uses the type oracle
 * (#1930) rather than a raw checker query.
 */
function elemAccessReceiverClassName(ctx: CodegenContext, elemAccess: ts.ElementAccessExpression): string | undefined {
  let name = ctx.oracle.declaredNameOf(elemAccess.expression);
  if (name && !ctx.classSet.has(name)) name = ctx.classExprNameMap.get(name) ?? name;
  return name && ctx.classSet.has(name) ? name : undefined;
}

/**
 * (#3166) True when the element-access receiver resolves to a user-class
 * instance. Gates the field-closure dynamic-call route so primitive / array /
 * host receivers keep their existing lowering.
 */
function elemAccessReceiverIsUserClass(ctx: CodegenContext, elemAccess: ts.ElementAccessExpression): boolean {
  return elemAccessReceiverClassName(ctx, elemAccess) !== undefined;
}

/**
 * (#3166) True when the receiver class of an element access declares a struct
 * field named `fieldName`. A computed-name class field (`[1+1] = …`) lands here
 * under its ToPropertyKey-canonicalised name ("2"); distinguishes a
 * field-holding-closure from a prototype method for the static-key call route.
 */
function classInstanceHasField(
  ctx: CodegenContext,
  elemAccess: ts.ElementAccessExpression,
  fieldName: string,
): boolean {
  const name = elemAccessReceiverClassName(ctx, elemAccess);
  if (!name) return false;
  const fields = ctx.structFields.get(name);
  return !!fields && fields.some((f) => f.name === fieldName);
}

export function tryEmitInlineDynamicCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  isKnownVariable: boolean,
): InnerResult | null {
  if (!isKnownVariable) return null;

  // (#2754) A call on an `any`-typed value (e.g. a callable PARAMETER whose
  // type annotation was stripped by a `bun build` / esbuild transpile) reaches
  // this dynamic-dispatch path. The dispatch is built from the funcref-wrapper
  // closure types registered SO FAR (`ctx.closureInfoByTypeIdx`). But a top-level
  // `function foo(){…}` only gets its wrapper registered LAZILY at the value site
  // that references it as a value (`runNmHost(denoRead, …)`), which is often a
  // LATER-compiled function (e.g. `main`). So when an earlier-compiled body calls
  // the param (`read(tmp)`), there are ZERO candidates and the call silently
  // lowers to `ref.null.extern` — the value is never invoked (the #2754 zero-
  // output Native-Messaging miscompile; the typed `.ts` path is unaffected because
  // a typed funcref param emits a direct `call_ref`). Eagerly register the
  // funcref wrappers for every no-capture function declaration referenced as a
  // value so the dispatch sees them regardless of compile order. Idempotent +
  // gated on a flag, so it runs once per module; a no-op for programs with no
  // function-valued declarations (byte-neutral on the typed corpus).
  ensureFuncValueWrappersRegistered(ctx, expr.getSourceFile());

  const arity = expr.arguments.length;

  // Pre-filter candidates: formal-param count must be able to satisfy the
  // call arity (>= arity — missing trailing args are padded with `undefined`,
  // see #820/#1543), and all param/return types supported by inline
  // marshalling (f64 / i32 / externref / ref / ref_null).
  type Cand = { structTypeIdx: number; info: ClosureInfo };
  const supported = (t: ValType | null): boolean => {
    if (t === null) return true;
    return t.kind === "f64" || t.kind === "i32" || t.kind === "externref" || t.kind === "ref" || t.kind === "ref_null";
  };

  const allCandidates: Cand[] = [];
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    // (#2923) JS §7.3.14: a call whose arg count differs from the callee's
    // declared param count still INVOKES the callee — extra args are ignored,
    // missing params are `undefined`. The per-candidate dispatch arm below
    // already honours this: it marshals exactly `info.paramTypes.length`
    // formals (pulling `argLocals[i]` for `i < arity`, padding `undefined` for
    // `i >= arity`), so an UNDER-arity candidate (fewer params than args)
    // simply drops the extra args, and an OVER-arity candidate pads. Every
    // call-site arg is still evaluated into a temp local above, so a truncated
    // extra arg keeps its side effects. The old `paramTypes.length < arity`
    // hard filter therefore SILENTLY DROPPED an entire class of higher-order
    // calls (the test262 `testWith*TypedArrayConstructors(fn)` harness calls
    // `fn(ctor, makeCtorArg)` — 2 args — but the callback declares `(TA)` — 1
    // param — so the whole test body was dead; 468+ BigInt tests). Removing it
    // adopts the JS arity semantics the direct-closure path (`compileClosureCall`
    // L122-129) already implements.
    //
    // (#1837) Over-arity padding was gated to NON-VOID results: the June-21
    // arm emitter produced a stack-invalid `call_ref` ("not enough arguments
    // on the stack") for padded void candidates — 52 merge_group regressions
    // in Promise/{all,race,any,allSettled} + TypedArray internals. The arm
    // construction has since been reworked (#3031 dynamic-apply, #2611 flush,
    // #2923) and now marshals exactly `paramTypes.length` formals with typed
    // pads plus a `ref.null.extern` block result for void returns — stack-
    // valid for void candidates too.
    //
    // (#3128) Narrowly re-admit over-arity VOID candidates whose padded
    // formals are all externref (`undefined` pad is exact). This is the
    // Promise settle-closure shape: a 0-arg `resolve()` inside a
    // `new Promise(function(resolve){ resolve(); })` executor must dispatch
    // the canonical `(externref) -> ()` settle wrapper with an undefined pad
    // (§7.3.14 missing args are `undefined`) — the gate made the call a
    // silent no-op, so the promise never settled (resolve-settled-*-self).
    // Void candidates needing a non-externref pad stay excluded
    // (conservative: their pad values are NaN/0/typed-null guesses).
    if (info.paramTypes.length > arity && info.returnType === null) {
      let padsAllExternref = true;
      for (let i = arity; i < info.paramTypes.length; i++) {
        if (info.paramTypes[i]!.kind !== "externref") {
          padsAllExternref = false;
          break;
        }
      }
      if (!padsAllExternref) continue;
    }
    if (!supported(info.returnType)) continue;
    let ok = true;
    for (const p of info.paramTypes) {
      if (!supported(p)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    allCandidates.push({ structTypeIdx: typeIdx, info });
  }

  // (#3031) Standalone Proxy [[Call]] arm gate — §0.1 ladder step 1: a Proxy
  // must intercept everything, including a dynamic call of the proxy value
  // itself (`p(...)`). Armed when the module can contain a live `$Proxy`:
  // `__proxy_create` already registered (an earlier-compiled / cross-file
  // `new Proxy`) OR this source file syntactically creates one (a call site can
  // compile BEFORE the same file's `new Proxy` site, so funcMap presence alone
  // misses the registration-order case — the #2754 class). Proxy-free programs
  // never grow the arm (byte-identical, the #2175 S0 discipline). Host lane is
  // untouched: a host proxy is a host externref whose [[Call]] belongs to the
  // K1 inbound-marshalling keystone, not this dispatch.
  const wantProxyArm =
    ctx.standalone === true && (ctx.funcMap.has("__proxy_create") || sourceCreatesProxy(expr.getSourceFile()));
  // (#3140) A `$__bound_fn` (native Function.prototype.bind carrier) may reach a
  // bare dynamic call (`bound(...)`) — add an unwrap arm when a bind site minted
  // the carrier in this module.
  const wantBoundArm =
    (ctx.standalone === true || ctx.wasi === true) &&
    (ctx.boundFnTypeIdx >= 0 || sourceHasBindCall(expr.getSourceFile()));
  if (allCandidates.length === 0 && !wantProxyArm && !wantBoundArm) return null;

  // Dedupe by funcTypeIdx — concrete subtypes share funcTypeIdx with their
  // base wrapper; one dispatch arm per unique funcref type is enough.
  const seenFuncType = new Set<number>();
  const candidates: Cand[] = [];
  for (const c of allCandidates) {
    if (seenFuncType.has(c.info.funcTypeIdx)) continue;
    seenFuncType.add(c.info.funcTypeIdx);
    candidates.push(c);
  }
  // Emit exact-arity arms first (most-specific), then padded over-arity arms,
  // so a value that satisfies an exact wrapper takes that arm before a
  // wider, undefined-padded one.
  candidates.sort((a, b) => a.info.paramTypes.length - arity - (b.info.paramTypes.length - arity));

  // Ensure box/unbox helpers exist (standalone: registered as native defined
  // functions, no import; host: late imports). Their indices are captured AFTER
  // the flush below — capturing them here, BEFORE a real import insertion (the
  // `__get_undefined` pad import), left the captured locals stale-low by the
  // insertion count while `flushLateImportShifts` repaired only `funcMap` and
  // already-emitted bodies. Every dispatch arm then baked `call <box-1>` — the
  // adjacent string-to-number native instead of the box helper — and the
  // module failed validation ("call[0] expected externref, found call_ref
  // of type f64"; the #3031 dynamic-apply invalid-module class).
  const UNBOX_NUMBER = "__unbox_number";
  addUnionImports(ctx);
  if (ensureLateImport(ctx, UNBOX_NUMBER, [{ kind: "externref" }], [{ kind: "f64" }]) === undefined) {
    return null;
  }

  // (#820/#1543) `undefined` externref source for padding missing trailing
  // args (call arity < a candidate's formal count), and (#3031) for the Proxy
  // arm's `thisArgument` (a bare `p(...)` call has `this = undefined`). Host
  // mode pulls it from `__get_undefined`; standalone / native-strings MUST NOT
  // add that env import (it made the module un-instantiable host-free — the
  // #3031 leak): `ensureGetUndefined` gates the import exactly like
  // `emitUndefined`, and the standalone representation is the (#2106 S1)
  // $undefined singleton when active, else `ref.null.extern` (a wasm method's
  // `__extern_is_undefined` default-param guard treats host `undefined` and a
  // null externref alike).
  const maxFormals = candidates.reduce((m, c) => Math.max(m, c.info.paramTypes.length), 0);
  const needsUndefinedPad = maxFormals > arity;
  const needsUndefined = needsUndefinedPad || wantProxyArm;
  const undefinedIdx = needsUndefined ? ensureGetUndefined(ctx) : undefined;
  const undefinedSingletonPad = needsUndefined && undefinedIdx === undefined ? undefinedExternInstrs(ctx) : undefined;
  // (#2611) Flush the deferred late-import shift NOW — every other late-import
  // call site in this file flushes after the add, but this one historically did
  // not, leaving `ctx.pendingLateImportShift` dangling. `ensureLateImport`
  // inserts the import at index `numImportFuncs` and defers the shift; until it
  // is flushed, the funcMap entries + bodies of functions registered BEFORE the
  // import stay stale-low while functions registered AFTER (e.g. `__module_init`,
  // whose funcIdx is recomputed from the post-import `numImportFuncs`) are already
  // correct. A flush left this late is then HALF-applied: shifting it at finalize
  // re-bumps the already-correct post-import indices (`startFuncIdx` → invalid
  // start function), while NOT flushing at all leaves the pre-import native
  // runtime helpers (`__extern_length`/`__extern_get_idx`/…) stale, so a
  // finalize reserve-then-fill resolves `funcMap.get(name) - numImportFuncs` to
  // the WRONG `mod.functions[]` slot and corrupts that body ("local index out of
  // range … #2043 class"). Flushing immediately — before any further function is
  // registered — repairs only the genuinely-stale pre-import indices and keeps
  // the index space self-consistent through the rest of compilation. Idempotent
  // no-op when nothing is pending. This site (`tryEmitInlineDynamicCall` ->
  // `__get_undefined` for the arity-pad path) is the one async-generator /
  // destructuring-param trigger that reaches here, but the flush is correct for
  // every path. (Mirrors `emitUndefined`, which already flushes after the same
  // `ensureGetUndefined` add.)
  flushLateImportShifts(ctx, fctx);
  // Capture the helper indices AFTER the flush: the flush re-bases `funcMap`
  // for defined functions, so these are the settled, final indices (see the
  // stale-capture note above).
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const unboxNumberIdx = ctx.funcMap.get(UNBOX_NUMBER);
  if (boxNumberIdx === undefined || unboxNumberIdx === undefined) return null;

  const pushUndefinedExternref = (body: Instr[]): void => {
    if (undefinedIdx !== undefined) {
      body.push({ op: "call", funcIdx: undefinedIdx });
    } else if (undefinedSingletonPad !== undefined) {
      // FRESH Instr objects per use — the singleton sequence lands in multiple
      // dispatch arms, and a shared Instr aliased into two branches gets
      // double-remapped by finalize index walks (the
      // `reference_shared_instr_object_dce_double_remap` class).
      for (const ins of undefinedSingletonPad) body.push({ ...ins });
    } else {
      body.push({ op: "ref.null.extern" });
    }
  };

  // (#3031) Materialize the Proxy [[Call]] pieces while the gate is live. The
  // object/proxy runtime registers DEFINED functions only (no import → no index
  // shift), so this is safe after the flush + captures above.
  let proxyArm: { proxyTypeIdx: number; dispatchIdx: number; vecNewIdx: number; vecPushIdx: number } | undefined;
  if (wantProxyArm) {
    const vecBuilders = ensureObjVecBuilders(ctx);
    const dispatchIdx = ctx.funcMap.get("__proxy_apply_dispatch");
    const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
    if (dispatchIdx !== undefined && proxyTypeIdx !== undefined) {
      proxyArm = { proxyTypeIdx, dispatchIdx, vecNewIdx: vecBuilders.newIdx, vecPushIdx: vecBuilders.pushIdx };
    }
  }
  // (#3140) Bound-function [[Call]] arm pieces — same DEFINED-only invariant as
  // the proxy pieces above (reserveApplyClosure mints a defined placeholder).
  let boundArm: { bfTypeIdx: number; applyIdx: number; vecNewIdx: number; vecPushIdx: number } | undefined;
  if (wantBoundArm) {
    const vecBuilders = ensureObjVecBuilders(ctx);
    const applyIdx = reserveApplyClosure(ctx);
    boundArm = {
      // Register on demand — the bind SITE may compile after this call site
      // (the pre-scan `sourceHasBindCall` covers that order).
      bfTypeIdx: getOrRegisterBoundFnType(ctx),
      applyIdx,
      vecNewIdx: vecBuilders.newIdx,
      vecPushIdx: vecBuilders.pushIdx,
    };
  }
  if (candidates.length === 0 && proxyArm === undefined && boundArm === undefined) return null;

  // Compile callee (externref) → anyref → temp local.
  const calleeType = compileExpression(ctx, fctx, expr.expression);
  if (calleeType === null) return null;
  // If already a ref type, skip the extern→any convert; otherwise expect externref.
  if (calleeType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null") {
    // Unexpected stack type — bail, the existing fallback will run.
    fctx.body.push({ op: "drop" });
    return null;
  }
  const anyLocal = allocLocal(fctx, `__dyn_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // Compile each argument to externref and stash in a temp local so each
  // dispatch arm can marshal it independently without re-evaluating.
  const argLocals: number[] = [];
  for (let i = 0; i < arity; i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
    const argLocal = allocLocal(fctx, `__dyn_arg${i}_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }

  // Build dispatch chain (innermost = default, outermost = first).
  // Default: ref.null.extern (matches existing fallback semantics).
  let dispatch: Instr[] = [{ op: "ref.null.extern" }];

  for (const cand of candidates) {
    const funcTypeDef = ctx.mod.types[cand.info.funcTypeIdx];
    const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
    const selfTypeIdx =
      selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
        ? (selfParam as { typeIdx: number }).typeIdx
        : cand.structTypeIdx;

    const callBody: Instr[] = [];

    // Self arg: anyref → the concrete struct type this funcref expects.
    callBody.push({ op: "local.get", index: anyLocal });
    callBody.push({ op: "ref.cast", typeIdx: selfTypeIdx });

    // Push each FORMAL of the candidate, marshalling per its declared param
    // type. Call-site args (i < arity) come from the saved arg locals;
    // missing trailing formals (i >= arity) are padded with `undefined`
    // (#820/#1543) so the lifted method applies its default / runs the
    // spec-mandated destructure of the default value.
    for (let i = 0; i < cand.info.paramTypes.length; i++) {
      const pType = cand.info.paramTypes[i]!;
      if (i >= arity) {
        // Missing arg → `undefined`. For ref/ref_null formals there is no
        // valid concrete struct to cast `undefined` to; pass the typed null.
        if (pType.kind === "f64") {
          callBody.push({ op: "f64.const", value: Number.NaN });
        } else if (pType.kind === "i32") {
          callBody.push({ op: "i32.const", value: 0 });
        } else if (pType.kind === "externref") {
          pushUndefinedExternref(callBody);
        } else if (pType.kind === "ref" || pType.kind === "ref_null") {
          callBody.push({ op: "ref.null", typeIdx: (pType as { typeIdx: number }).typeIdx });
        }
        continue;
      }
      callBody.push({ op: "local.get", index: argLocals[i]! });
      if (pType.kind === "f64") {
        callBody.push({ op: "call", funcIdx: unboxNumberIdx });
      } else if (pType.kind === "i32") {
        callBody.push({ op: "call", funcIdx: unboxNumberIdx });
        callBody.push({ op: "i32.trunc_sat_f64_s" });
      } else if (pType.kind === "externref") {
        // already externref
      } else if (pType.kind === "ref" || pType.kind === "ref_null") {
        callBody.push({ op: "any.convert_extern" });
        callBody.push({ op: "ref.cast", typeIdx: (pType as { typeIdx: number }).typeIdx });
      }
    }

    // Extract funcref from field 0 and call_ref.
    callBody.push({ op: "local.get", index: anyLocal });
    callBody.push({ op: "ref.cast", typeIdx: selfTypeIdx });
    callBody.push({ op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 });
    callBody.push({ op: "ref.cast", typeIdx: cand.info.funcTypeIdx });
    callBody.push({ op: "call_ref", typeIdx: cand.info.funcTypeIdx });

    // Coerce return value to externref.
    const ret = cand.info.returnType;
    if (ret === null) {
      callBody.push({ op: "ref.null.extern" });
    } else if (ret.kind === "f64") {
      callBody.push({ op: "call", funcIdx: boxNumberIdx });
    } else if (ret.kind === "i32") {
      callBody.push({ op: "f64.convert_i32_s" });
      callBody.push({ op: "call", funcIdx: boxNumberIdx });
    } else if (ret.kind === "ref" || ret.kind === "ref_null") {
      callBody.push({ op: "extern.convert_any" });
    }
    // externref: no conversion

    // (#820/#1543) Discriminate by the *funcref* signature, not the struct
    // type. Every `__fn_wrap_*` struct subtypes the single root wrapper, so
    // `ref.test (ref <wrapper-struct>)` matches wrapper values of every arity
    // — an arity-0 arm would then fire for an extracted arity-1 method and
    // `ref.cast` its arity-1 funcref to the arity-0 funcType, trapping with
    // `illegal cast`. The funcref's type encodes the exact param count +
    // result, so `ref.test (ref funcTypeIdx)` on field 0 fires this arm only
    // for its own signature. A struct guard is still needed before the
    // `struct.get` (you can't read a field off a non-struct); the *root*
    // wrapper struct is a safe supertype to cast any wrapper to for that read.
    const rootStructIdx =
      (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx ?? selfTypeIdx;
    const testCond: Instr[] = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: rootStructIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: rootStructIdx },
          { op: "struct.get", typeIdx: rootStructIdx, fieldIdx: 0 },
          { op: "ref.test", typeIdx: cand.info.funcTypeIdx },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];

    dispatch = [
      ...testCond,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: dispatch,
      },
    ];
  }

  // (#3031) Standalone Proxy [[Call]] — the OUTERMOST arm (§0.1 ladder step 1,
  // ahead of every closure-shape candidate): `p(...)` where `p` is a live
  // `$Proxy` packs the saved args into the native `$ObjVec` carrier and routes
  // to `__proxy_apply_dispatch(p, undefined, argsVec)` — the §10.5.12 apply
  // trap when installed, a transparent forward to the target otherwise. The
  // `thisArgument` of a bare call is `undefined`.
  if (proxyArm !== undefined) {
    const vecLocal = allocLocal(fctx, `__dyn_pargs_${fctx.locals.length}`, { kind: "externref" });
    const armBody: Instr[] = [
      { op: "call", funcIdx: proxyArm.vecNewIdx },
      { op: "local.set", index: vecLocal },
    ];
    for (const argLocal of argLocals) {
      armBody.push({ op: "local.get", index: vecLocal });
      armBody.push({ op: "local.get", index: argLocal });
      armBody.push({ op: "call", funcIdx: proxyArm.vecPushIdx });
    }
    armBody.push({ op: "local.get", index: anyLocal });
    armBody.push({ op: "extern.convert_any" });
    pushUndefinedExternref(armBody); // thisArgument = undefined
    armBody.push({ op: "local.get", index: vecLocal });
    armBody.push({ op: "call", funcIdx: proxyArm.dispatchIdx });
    dispatch = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: proxyArm.proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: armBody,
        else: dispatch,
      },
    ];
  }

  // (#3140) Bound-function [[Call]] arm: `bound(...)` where `bound` is a
  // `$__bound_fn` minted by a standalone `.bind(...)` site. Pack the args into
  // a `$ObjVec` and route through `__apply_closure`, whose fill-time front
  // guard unwraps the carrier (prepends [[BoundArguments]], applies
  // [[BoundThis]], recurses on the target — bound-of-bound composes).
  if (boundArm !== undefined) {
    const vecLocal = allocLocal(fctx, `__dyn_bargs_${fctx.locals.length}`, { kind: "externref" });
    const armBody: Instr[] = [
      { op: "call", funcIdx: boundArm.vecNewIdx },
      { op: "local.set", index: vecLocal },
    ];
    for (const argLocal of argLocals) {
      armBody.push({ op: "local.get", index: vecLocal });
      armBody.push({ op: "local.get", index: argLocal });
      armBody.push({ op: "call", funcIdx: boundArm.vecPushIdx });
    }
    armBody.push({ op: "local.get", index: anyLocal });
    armBody.push({ op: "extern.convert_any" });
    armBody.push({ op: "ref.null.extern" }); // recv — [[BoundThis]] wins in the guard
    armBody.push({ op: "local.get", index: vecLocal });
    armBody.push({ op: "call", funcIdx: boundArm.applyIdx });
    dispatch = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: boundArm.bfTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: armBody,
        else: dispatch,
      },
    ];
  }

  fctx.body.push(...dispatch);
  return { kind: "externref" };
}

/**
 * (#1299) Emit a tag-based virtual method dispatch for a base-typed
 * receiver where multiple subclasses provide overriding implementations.
 * Mirrors the `instanceof` codegen: load the receiver's `__tag` field
 * (i32, set in each subclass's constructor) and compare against each
 * candidate's known `classTag` value, calling the matching subclass's
 * method body. Receiver and arguments are evaluated once and saved to
 * temp locals so each branch can reference them.
 *
 * Returns the call's IR result type, or undefined if dispatch could not
 * be emitted (caller falls back to the existing static path).
 */
function emitVirtualMethodDispatchByTag(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  candidates: { className: string; funcIdx: number; classTag: number }[],
  baseClassName: string,
): InnerResult | undefined {
  // Resolve the base struct typeIdx for `struct.get __tag` (field 0).
  const baseStructIdx = ctx.structMap.get(baseClassName);
  if (baseStructIdx === undefined) return undefined;

  // Validate first candidate's signature (used as the schema for arg
  // type hints and return-type lookup; all overrides share the same
  // user-visible signature).
  const firstCand = candidates[0]!;
  const firstParamTypes = getFuncParamTypes(ctx, firstCand.funcIdx);
  if (!firstParamTypes || firstParamTypes.length === 0) return undefined;

  // Compile the receiver expression — produces a ref-typed value.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) return undefined;

  const recvLocalType: ValType = { kind: "ref_null", typeIdx: (recvType as { typeIdx: number }).typeIdx };
  const recvLocal = allocTempLocal(fctx, recvLocalType);
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Evaluate args and save each to a temp local. Pad missing args with
  // default values so call sites can omit trailing arguments.
  const argLocals: { idx: number; type: ValType }[] = [];
  const userParamCount = firstParamTypes.length - 1; // exclude self
  const argCount = Math.min(expr.arguments.length, userParamCount);
  for (let i = 0; i < argCount; i++) {
    const expectedArgType = firstParamTypes[i + 1];
    const aType = compileExpression(ctx, fctx, expr.arguments[i]!, expectedArgType);
    if (!aType) return undefined;
    const local = allocTempLocal(fctx, aType);
    fctx.body.push({ op: "local.set", index: local });
    argLocals.push({ idx: local, type: aType });
  }
  for (let i = expr.arguments.length + 1; i < firstParamTypes.length; i++) {
    const paramType = firstParamTypes[i]!;
    pushDefaultValue(fctx, paramType, ctx);
    const local = allocTempLocal(fctx, paramType);
    fctx.body.push({ op: "local.set", index: local });
    argLocals.push({ idx: local, type: paramType });
  }

  // Determine return type from the first candidate's signature.
  const sig = ctx.checker.getResolvedSignature(expr);
  let resultType: ValType | typeof VOID_RESULT = VOID_RESULT;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const fullName0 = `${firstCand.className}_${propAccess.name.text}`;
    if (!isEffectivelyVoidReturn(ctx, retType, fullName0)) {
      const wasmRet = getWasmFuncReturnType(ctx, firstCand.funcIdx);
      resultType = wasmRet ?? resolveWasmType(ctx, retType);
    }
  }
  if (resultType !== VOID_RESULT && wasmFuncReturnsVoid(ctx, firstCand.funcIdx)) {
    resultType = VOID_RESULT;
  }

  const resultIsRef = resultType !== VOID_RESULT && (resultType.kind === "ref" || resultType.kind === "ref_null");

  // (#2564) Each nested `if` in the tag cascade below MUST get its own
  // `blockType` object — never a single shared one. `dead-elimination`'s
  // `remapTypeIdxInBody` remaps a `ref`/`ref_null` block-type via `remapVT`,
  // and its double-remap guard (`seen` WeakSet, #1302) keys on the *instruction*
  // object, not on the `blockType.type` sub-object. The cascade builds one
  // distinct `if` instruction per candidate; if they all alias the SAME
  // `blockType.type` ValType, the second nested `if`'s visit chain-remaps the
  // already-remapped index a second time (observed: 20→16 on the first `if`,
  // then 16→13 on the second — the compaction map shifts each survivor down, so
  // 13 is the fn-wrapper type), while the callee func's result type — remapped
  // exactly once in the type table — lands on 16. The mismatch surfaces as
  // `type error in fallthru[0] (expected (ref null 13), got (ref null 16))`.
  // A fresh `{ ...resultType }` per `if` keeps each block-type remapped once.
  const freshBlockType = (): { kind: "val"; type: ValType } | { kind: "empty" } =>
    resultType === VOID_RESULT
      ? { kind: "empty" }
      : { kind: "val", type: resultIsRef ? { ...(resultType as ValType) } : (resultType as ValType) };

  // Build the call body for one candidate. We need to ref.cast the
  // receiver to the candidate's struct type before calling, so the
  // function-type signature matches.
  function callBody(cand: { className: string; funcIdx: number; classTag: number }): Instr[] {
    const candParams = getFuncParamTypes(ctx, cand.funcIdx);
    if (!candParams || candParams.length === 0) return [];
    const selfType = candParams[0]!;
    if (selfType.kind !== "ref" && selfType.kind !== "ref_null") return [];
    const selfTypeIdx = (selfType as { typeIdx: number }).typeIdx;
    const body: Instr[] = [];
    body.push({ op: "local.get", index: recvLocal });
    // ref.cast_null preserves nullability if the receiver might be null;
    // ref.cast (non-null) traps on null. Use ref.cast_null since the
    // receiver could be null at the static type level.
    body.push({ op: "ref.cast_null", typeIdx: selfTypeIdx });
    for (const a of argLocals) {
      body.push({ op: "local.get", index: a.idx });
    }
    const finalIdx = ctx.funcMap.get(`${cand.className}_${propAccess.name.text}`) ?? cand.funcIdx;
    body.push({ op: "call", funcIdx: finalIdx });
    return body;
  }

  // Build the cascade: load __tag, compare to each candidate's classTag.
  // Outermost: candidates[0]; deepest else: unreachable.
  let elseInstrs: Instr[] = [{ op: "unreachable" }];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const cand = candidates[i]!;
    const branch: Instr[] = [
      { op: "local.get", index: recvLocal },
      { op: "struct.get", typeIdx: baseStructIdx, fieldIdx: 0 },
      { op: "i32.const", value: cand.classTag },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: freshBlockType(),
        then: callBody(cand),
        else: elseInstrs,
      },
    ];
    elseInstrs = branch;
  }
  for (const instr of elseInstrs) fctx.body.push(instr);

  for (const a of argLocals) releaseTempLocal(fctx, a.idx);
  releaseTempLocal(fctx, recvLocal);

  return resultType;
}

/**
 * Statically flatten an array literal's elements into a positional argument
 * list, expanding spreads of nested array literals (`[...[a, b]]` → `a, b`).
 * Returns undefined when the literal contains an element we cannot expand at
 * compile time (a spread of a non-literal, or an elided hole). Used by the
 * `fn.apply(thisArg, [...])` rewrite (#1596).
 */
function flattenStaticArrayElements(arr: ts.ArrayLiteralExpression): ts.Expression[] | undefined {
  const out: ts.Expression[] = [];
  for (const el of arr.elements) {
    if (ts.isOmittedExpression(el)) return undefined;
    if (ts.isSpreadElement(el)) {
      let inner: ts.Expression = el.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (!ts.isArrayLiteralExpression(inner)) return undefined;
      const nested = flattenStaticArrayElements(inner);
      if (nested === undefined) return undefined;
      out.push(...nested);
    } else {
      out.push(el);
    }
  }
  return out;
}

function isNullishPromiseThenCallbackArg(expr: ts.Expression | undefined): boolean {
  if (expr === undefined) return true;
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = (
      cur as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.SatisfiesExpression
        | ts.NonNullExpression
        | ts.TypeAssertion
    ).expression;
  }
  return (
    cur.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(cur) && cur.text === "undefined") ||
    (ts.isVoidExpression(cur) && cur.expression.kind === ts.SyntaxKind.NumericLiteral)
  );
}

function compilePromiseThenReceiverBuffer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  liveBuffers: Instr[][],
): Instr[] {
  const instrs: Instr[] = [];
  liveBuffers.push(instrs);
  ctx.liveBodies.add(instrs);
  // (#2918) Push the real body onto `savedBodies` — NOT just a local — so a
  // late-import funcIdx shift fired while compiling this buffer (e.g. an object-
  // runtime helper import pulled in by an earlier `{}` statement, or `__box_*`
  // for a numeric arg) still walks the outer body and bumps the `call`/`ref.func`
  // indices already emitted there. A bare `savedBody` local left the outer body
  // unreachable to the shifter, so a `call __new_plain_object` baked at N stayed
  // N after everything moved to N+delta → it pointed at a wrong-arity helper
  // ("not enough arguments on the stack for call", the −601 standalone regression).
  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);
  fctx.body = instrs;
  try {
    const type = compileExpression(ctx, fctx, expr, { kind: "externref" });
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
  } finally {
    fctx.savedBodies.pop();
    fctx.body = savedBody;
  }
  return instrs;
}

function compileStandalonePromiseThenCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression | undefined,
  liveBuffers: Instr[][],
): StandalonePromiseThenCallback | null {
  if (arg === undefined || isNullishPromiseThenCallbackArg(arg)) return null;

  const instrs: Instr[] = [];
  liveBuffers.push(instrs);
  ctx.liveBodies.add(instrs);
  // (#2918) Keep the outer body reachable to the late-import shifter — a late
  // import registered while compiling this buffer (e.g. an object-runtime
  // helper, or `__box_*` for a numeric arg) must still be able to walk the
  // outer body and bump the `call`/`ref.func` indices already emitted there.
  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);
  fctx.body = instrs;
  // (#3137) Widen TUPLE-typed callback params to externref for this compile
  // window — the native then-wrapper ABI delivers externref, and the
  // contextually-inferred tuple struct (combinator over a tuple input) can
  // never match the runtime results vec (see computeClosureWrapperSig).
  const savedWidenTuple = ctx.widenTupleCallbackParams;
  ctx.widenTupleCallbackParams = true;
  try {
    const type =
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
        ? compileArrowAsClosure(ctx, fctx, arg)
        : compileExpression(ctx, fctx, arg);
    let closureInfo: ClosureInfo | undefined;
    if (type && (type.kind === "ref" || type.kind === "ref_null")) {
      closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
    }
    if (!closureInfo && ts.isIdentifier(arg)) {
      closureInfo = ctx.closureMap.get(arg.text);
    }
    if (!closureInfo) {
      instrs.length = 0;
      return null;
    }
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
    return { instrs, closureInfo };
  } finally {
    ctx.widenTupleCallbackParams = savedWidenTuple;
    fctx.savedBodies.pop();
    fctx.body = savedBody;
  }
}

/**
 * (#2980 class 1) The pre-widen host `.then`/`.catch` path (`Promise_then` /
 * `Promise_then2` / `Promise_catch` late imports) — unchanged behaviour,
 * extracted into its own function so {@link emitStandaloneThenWithNativeFallback}
 * can bake it into the runtime `else` arm against the ALREADY-EVALUATED
 * receiver local, instead of a second (possibly side-effecting) compile of
 * the receiver expression.
 */
function emitHostPromiseThenFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvLocal: number,
  method: "then" | "catch",
  onFulfilledArg: ts.Expression | undefined,
  onRejectedArg: ts.Expression | undefined,
): void {
  const useThen2 = method === "then" && onRejectedArg !== undefined;
  const importName = useThen2 ? "Promise_then2" : `Promise_${method}`;
  const paramTypes: ValType[] = useThen2
    ? [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }]
    : [{ kind: "externref" }, { kind: "externref" }];
  let funcIdx = ctx.funcMap.get(importName) ?? ensureLateImport(ctx, importName, paramTypes, [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  funcIdx = ctx.funcMap.get(importName) ?? funcIdx;

  if (funcIdx === undefined) {
    // Keep the stack balanced even if the import couldn't be registered.
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }

  fctx.body.push({ op: "local.get", index: recvLocal });

  const firstArg = method === "catch" ? onRejectedArg : onFulfilledArg;
  if (firstArg) {
    const cbType = compileExpression(ctx, fctx, firstArg, { kind: "externref" });
    if (cbType && cbType.kind !== "externref") coerceType(ctx, fctx, cbType, { kind: "externref" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  if (useThen2) {
    const cb2Type = compileExpression(ctx, fctx, onRejectedArg!, { kind: "externref" });
    if (cb2Type && cb2Type.kind !== "externref") coerceType(ctx, fctx, cb2Type, { kind: "externref" });
  }

  const finalIdx = ctx.funcMap.get(importName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalIdx });
}

/**
 * (#2980 class 1) `.then`/`.catch` runtime dispatch on standalone/WASI native
 * chaining. `isStandaloneThenChainNativeActive` only decides whether native
 * `$Promise` chaining is enabled AT ALL for this compile — it cannot know the
 * runtime SHAPE of the receiver, which for several real constructs is NOT a
 * native `$Promise` struct even when native chaining is on: the deferred
 * combinators (`Promise.allSettled` / `Promise.any` — `promise-combinators.ts`
 * only lowers `all`/`race` natively), constructor-executor promises, and
 * `Promise.prototype.then.call` / capability-object shapes all route through
 * host machinery. `emitStandalonePromiseThen`'s unconditional `ref.cast` to
 * `$Promise` TRAPS on any of these — the dominant #2980 decision-measure
 * residual (class 1, −18/60 in the original 262-file corpus measure;
 * re-measured 2026-07-05 against current main at 16/60 regressed in the
 * promise-then-all bucket alone, every one an "illegal cast in test()").
 *
 * Fix: evaluate the receiver ONCE into a local, `ref.test` it against the
 * native `$Promise` struct at RUNTIME, and route to the fast native chain
 * only on a genuine hit. A miss falls back to
 * {@link emitHostPromiseThenFallback} — exactly the pre-widen standalone
 * behaviour for that shape (fails to instantiate cleanly if the host import
 * is unsatisfied, no invalid Wasm — see {@link isStandaloneThenChainNativeActive}).
 *
 * Both arms are pre-compiled Instr buffers spliced into a runtime `if`/`else`
 * (`blockType: {kind:"val", type:{kind:"externref"}}` — both arms leave
 * exactly one externref). The native arm is built FIRST and then held
 * off `fctx.body`/`fctx.savedBodies` while the host arm is built (which can
 * register a NEW late host import and shift already-baked defined-function
 * indices) — so it MUST be registered in `ctx.liveBodies` for that window,
 * exactly the `liveBuffers` pattern this file already uses for the
 * `onFulfilled`/`onRejected` closure buffers (#2918).
 *
 * CALLER CONTRACT: only call this for the NON-wasi case (`ctx.wasi !==
 * true`). WASI's `.then`/`.catch` MUST NEVER gain a `Promise_then` import —
 * that contract is enforced by `tests/issue-1326.test.ts` (asserts the WAT
 * never contains "Promise_then" and instantiates with an EMPTY imports
 * object). The call sites in `compileCallExpression` branch on `ctx.wasi`
 * BEFORE reaching here and keep the original unconditional-cast lowering
 * for wasi untouched.
 */

/**
 * (#2865) Zero-arg `.next()` on a possibly-DRIVEN async-generator receiver.
 * `g()` on a driven producer returns the `$AsyncFrame` carrier (a bare
 * externref); source-level `g().next()` / `it.next()` must route to the
 * per-gen re-entrant driver `__async_gen_next_<stem>(frame) ->
 * Promise<IteratorResult>`. The receiver is dispatched at RUNTIME by
 * `ref.test`ing each registered producer's frame struct (the chain shape
 * `buildNativeGeneratorDispatch` uses for sync gens).
 *
 * Miss arm (a receiver that is none of the driven frames): under BOTH
 * `--target standalone` and `--target wasi`, the legacy host `__gen_next` is
 * kept ONLY when a legacy buffer async gen was actually emitted in this module
 * (`asyncGenLegacyBufferEmitted`); otherwise a plain null result, so an
 * ALL-DRIVEN module stays host-free. (#3132) This dispatch is TYPE-gated to
 * `AsyncGenerator`/`AsyncIterableIterator`/`AsyncIterator` receivers (see the
 * call sites), never user objects or sync gens — so in a module with no legacy
 * buffer async gen, every reachable receiver IS one of the driven frames and
 * the `__gen_next` miss arm is provably DEAD. Dropping it (previously kept
 * unconditionally on standalone) removes the `env::__gen_next` import that
 * blocked these otherwise-driven async gens — consumed via `.next()` — from
 * counting toward the host-free standalone floor, the CONSUMER half of the
 * dstr-param slice. Mixed modules (a driven gen AND a legacy buffer async gen)
 * keep the fallback, exactly as before. Mirrors #2903's `.then` host-arm
 * de-leak; matches the well-tested wasi semantics byte-for-byte.
 *
 * Returns null (no emission) when the module has no driven producers or the
 * target is the JS-host lane — the caller falls through to its original
 * lowering, byte-identical.
 */
function tryEmitAsyncGenNextDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
): ValType | null {
  const producers = ctx.asyncGenProducers;
  if (ctx.standalone !== true && ctx.wasi !== true) return null;
  if (producers === undefined || producers.size === 0) return null;
  // Evaluate the receiver ONCE into an externref local (it may be a call).
  const recvLocal = allocLocal(fctx, `__agen_recv_${fctx.locals.length}`, { kind: "externref" });
  const rt = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
  if (rt !== null && rt !== undefined && (rt as ValType).kind !== "externref") {
    coerceType(ctx, fctx, rt as ValType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: recvLocal });
  // funcMap lookups happen AFTER the receiver compile (which may register late
  // imports and shift defined indices).
  const wantHostFallback = ctx.asyncGenLegacyBufferEmitted === true;
  const hostGenNext = wantHostFallback ? ctx.funcMap.get("__gen_next") : undefined;
  let chain: Instr[] =
    hostGenNext !== undefined
      ? [
          { op: "local.get", index: recvLocal },
          { op: "call", funcIdx: hostGenNext },
        ]
      : [{ op: "ref.null.extern" }];
  for (const p of [...producers.values()].reverse()) {
    const nextIdx = ctx.funcMap.get(p.nextHelperName);
    if (nextIdx === undefined) continue;
    chain = [
      { op: "local.get", index: recvLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: p.stateTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: recvLocal },
          { op: "call", funcIdx: nextIdx },
        ],
        else: chain,
      },
    ];
  }
  fctx.body.push(...chain);
  return { kind: "externref" };
}

/**
 * (#2903) Host-import names that PRODUCE promises the standalone module did
 * not mint natively. Checked (alongside the pre-body syntactic scan flag
 * `ctx.moduleHasHostPromiseSource`) before replacing the `.then`/`.catch`
 * bridge's host fallback arm with a native TypeError: if any of these is
 * registered, a runtime receiver can genuinely be a HOST promise and the host
 * arm must stay (exactly the pre-#2903 lowering — the module was irreducibly
 * host-import-leaky anyway, so keeping the arm sacrifices zero host-free
 * passes). All the *statically-detectable* producers register UPFRONT in the
 * `collectPromiseImports` finalize (declarations.ts) — before any function
 * body compiles — so this check is compile-order-safe for them; the
 * lazily-registered producers (dynamic `import()`, subclass-of-Promise
 * statics) are covered by the pre-body syntactic scan instead. `.finally(…)`
 * is NO LONGER a producer on the active native lane (it lowers to the native
 * §27.2.5.3 machinery, #2903 finally sub-front); `Promise_finally` stays
 * listed below as the funcMap backstop for the residual host-routed shapes
 * (producer modules' legacy route, carrier-fallback modules).
 *
 * Deliberately NOT listed (upfront-registered even when the lowering is
 * native, so funcMap presence is a false-positive that would forfeit the
 * de-leak): `Promise_resolve`/`Promise_reject` (unconditionally native under
 * `isStandalonePromiseActive`, expressions.ts) and `Promise_new` (native for
 * inline executors via `emitStandalonePromiseFromExecutor`; the genuine host
 * fallthrough in new-super.ts sets `ctx.moduleHasHostPromiseSource` at
 * emission instead).
 */
const HOST_PROMISE_PRODUCER_IMPORTS = [
  "Promise_all",
  "Promise_race",
  "Promise_allSettled",
  "Promise_any",
  "Promise_finally",
  "__dynamic_import",
  "__array_from_async",
] as const;

/**
 * (#2903) True when the `.then`/`.catch` receiver bridge's miss arm can be
 * NATIVE (a catchable TypeError) instead of the host `Promise_then*` fallback.
 * Standalone-only (wasi keeps its `nullMiss` contract; gc/host never emits the
 * bridge). Requires that the module provably cannot mint a host promise: no
 * syntactic producer (pre-body scan, `moduleHasHostPromiseSource`) and no
 * producer host import registered. Under that proof every runtime receiver
 * that fails the `ref.test $Promise` is a non-promise (§27.2.5.4 step 2 —
 * TypeError), and dropping the host arm removes the
 * `Promise_then*`/`__make_callback` imports that kept ~626 otherwise-passing
 * standalone modules host-import-leaky (measured 2026-07-10, see
 * plan/issues/2903: 662 then-chain-only leaky passes, 626 with the host arm
 * never CALLED at runtime).
 */
function standaloneThenMissArmCanBeNative(ctx: CodegenContext): boolean {
  if (ctx.standalone !== true || ctx.wasi === true) return false;
  if (ctx.moduleHasHostPromiseSource === true) return false;
  for (const name of HOST_PROMISE_PRODUCER_IMPORTS) {
    if (ctx.funcMap.has(name)) return false;
  }
  return true;
}

function emitStandaloneThenWithNativeFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  method: "then" | "catch",
  onFulfilledArg: ts.Expression | undefined,
  onRejectedArg: ts.Expression | undefined,
  // (#2865) `nullMiss` replaces the HOST miss arm with a plain null result —
  // for `--target wasi` any-receiver dispatch, where the zero-import contract
  // forbids registering `Promise_then*`/`__make_callback` and a host arm could
  // never succeed anyway (no stubs). Native receivers are unaffected.
  opts?: { nullMiss?: boolean },
): void {
  const liveBuffers: Instr[][] = [];
  try {
    const recvLocal = allocLocal(fctx, `__then_recv_${fctx.locals.length}`, { kind: "externref" });
    const recvType = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
    if (recvType && recvType.kind !== "externref") {
      coerceType(ctx, fctx, recvType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: recvLocal });

    const onFulfilled =
      method === "then" ? compileStandalonePromiseThenCallback(ctx, fctx, onFulfilledArg, liveBuffers) : null;
    const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, onRejectedArg, liveBuffers);
    const promiseInstrs: Instr[] = [{ op: "local.get", index: recvLocal }];

    const outerBody = fctx.body;

    const nativeArm: Instr[] = [];
    ctx.liveBodies.add(nativeArm);
    liveBuffers.push(nativeArm);
    fctx.savedBodies.push(outerBody);
    fctx.body = nativeArm;
    try {
      emitStandalonePromiseThen(ctx, fctx, promiseInstrs, onFulfilled, onRejected);
    } finally {
      fctx.savedBodies.pop();
      fctx.body = outerBody;
    }

    const hostArm: Instr[] = [];
    if (opts?.nullMiss === true) {
      hostArm.push({ op: "ref.null.extern" });
    } else {
      ctx.liveBodies.add(hostArm);
      liveBuffers.push(hostArm);
      fctx.savedBodies.push(outerBody);
      fctx.body = hostArm;
      try {
        if (standaloneThenMissArmCanBeNative(ctx)) {
          // (#2903) The module provably cannot mint a HOST promise (no
          // syntactic producer, no producer import), so a receiver failing
          // the `ref.test $Promise` is a non-promise: throw the §27.2.5.4
          // step-2 TypeError NATIVELY instead of baking the dead host
          // `Promise_then*` arm. This is what makes the whole module
          // host-free — the host arm's `ensureLateImport` was the sole
          // source of the `Promise_then*`/`__make_callback` leak in ~626
          // otherwise-passing standalone modules. `throw` is terminal
          // (stack-polymorphic), so the externref-typed arm validates.
          emitThrowTypeError(ctx, fctx, `Promise.prototype.${method} called on a non-Promise receiver`);
        } else {
          emitHostPromiseThenFallback(ctx, fctx, recvLocal, method, onFulfilledArg, onRejectedArg);
        }
      } finally {
        fctx.savedBodies.pop();
        fctx.body = outerBody;
      }
    }

    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: nativeArm,
      else: hostArm,
    });
  } finally {
    for (const b of liveBuffers) ctx.liveBodies.delete(b);
  }
}

/**
 * (#2903) The pre-native host `.finally` path (`Promise_finally` late import) —
 * kept as the receiver bridge's miss arm ONLY when the module can genuinely
 * mint a host promise (`standaloneThenMissArmCanBeNative` false). Mirrors
 * {@link emitHostPromiseThenFallback}: emits against the ALREADY-EVALUATED
 * receiver local (no second receiver compile).
 */
function emitHostPromiseFinallyFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvLocal: number,
  onFinallyArg: ts.Expression | undefined,
): void {
  const paramTypes: ValType[] = [{ kind: "externref" }, { kind: "externref" }];
  let funcIdx =
    ctx.funcMap.get("Promise_finally") ?? ensureLateImport(ctx, "Promise_finally", paramTypes, [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  funcIdx = ctx.funcMap.get("Promise_finally") ?? funcIdx;

  if (funcIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }

  fctx.body.push({ op: "local.get", index: recvLocal });
  if (onFinallyArg) {
    const cbType = compileExpression(ctx, fctx, onFinallyArg, { kind: "externref" });
    if (cbType && cbType.kind !== "externref") coerceType(ctx, fctx, cbType, { kind: "externref" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const finalIdx = ctx.funcMap.get("Promise_finally") ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalIdx });
}

/**
 * (#2903) `.finally` runtime dispatch on standalone/WASI native `$Promise`
 * receivers — the finally twin of {@link emitStandaloneThenWithNativeFallback}.
 * A `ref.test $Promise` HIT lowers §27.2.5.3 natively
 * (`emitStandalonePromiseFinally`); the MISS arm is a native catchable
 * TypeError when the module provably cannot mint a host promise, the exact
 * pre-#2903 `Promise_finally` host call when it can, and a plain null under
 * wasi (`nullMiss` — zero-import contract).
 */
function emitStandaloneFinallyWithNativeFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  onFinallyArg: ts.Expression | undefined,
  opts?: { nullMiss?: boolean },
): void {
  const liveBuffers: Instr[][] = [];
  try {
    const recvLocal = allocLocal(fctx, `__finally_recv_${fctx.locals.length}`, { kind: "externref" });
    const recvType = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
    if (recvType && recvType.kind !== "externref") {
      coerceType(ctx, fctx, recvType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: recvLocal });

    const onFinally = compileStandalonePromiseThenCallback(ctx, fctx, onFinallyArg, liveBuffers);

    const outerBody = fctx.body;
    const nativeArm: Instr[] = [];
    ctx.liveBodies.add(nativeArm);
    liveBuffers.push(nativeArm);
    fctx.savedBodies.push(outerBody);
    fctx.body = nativeArm;
    try {
      emitStandalonePromiseFinally(ctx, fctx, [{ op: "local.get", index: recvLocal }], onFinally);
    } finally {
      fctx.savedBodies.pop();
      fctx.body = outerBody;
    }

    const hostArm: Instr[] = [];
    if (opts?.nullMiss === true) {
      hostArm.push({ op: "ref.null.extern" });
    } else {
      ctx.liveBodies.add(hostArm);
      liveBuffers.push(hostArm);
      fctx.savedBodies.push(outerBody);
      fctx.body = hostArm;
      try {
        if (standaloneThenMissArmCanBeNative(ctx)) {
          emitThrowTypeError(ctx, fctx, "Promise.prototype.finally called on a non-Promise receiver");
        } else {
          emitHostPromiseFinallyFallback(ctx, fctx, recvLocal, onFinallyArg);
        }
      } finally {
        fctx.savedBodies.pop();
        fctx.body = outerBody;
      }
    }

    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: nativeArm,
      else: hostArm,
    });
  } finally {
    for (const b of liveBuffers) ctx.liveBodies.delete(b);
  }
}

/**
 * #2034: compile a `Number.is*` predicate argument as an f64, honouring the
 * spec rule that these predicates do NOT coerce (ES §21.1.2.x): a non-Number
 * argument must yield `false` without ToNumber. (The *global* `isNaN`/`isFinite`
 * DO coerce — they are handled elsewhere and unaffected.)
 *
 * Emits one of two shapes and returns i32 (0/1):
 *   - static number arg → `predicate(arg)` (unchanged fast path).
 *   - any-typed arg → `__typeof_number(box) ? predicate(__unbox_number(box)) : 0`.
 *     The typeof guard runs first, so a string/object/null box short-circuits to
 *     0 (false) and never reaches the numeric test.
 *
 * `emitPredicate` receives the local holding the f64 value and pushes the
 * boolean (i32) test for that value.
 */
export function compileNumberIsPredicate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  emitPredicate: (valLocal: number) => Instr[],
): ValType {
  const argTsType = ctx.checker.getTypeAtLocation(arg);
  const argWasm = resolveWasmType(ctx, argTsType);

  // #2034 follow-up: a `symbol`-typed argument is statically NOT a Number, so
  // every `Number.is*` predicate is `false` (ES §21.1.2.x). A Symbol's Wasm
  // representation is a single-slot reference that BOTH the i32/f64 "static
  // number" fast path AND the runtime `__typeof_number` guard mis-handle (the
  // guard reports it as a number), so neither generic arm yields the spec
  // answer. Fold it at compile time: evaluate the argument for its side effects
  // (the Symbol expression may be an observable call) and push `false`.
  // (test262 Number/{isInteger,isFinite,isSafeInteger}/arg-is-not-number.js.)
  if ((argTsType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Several non-Number primitive types reuse a numeric Wasm representation that
  // would otherwise hijack the "static number" fast path and coerce, violating
  // the no-coercion rule (ES §21.1.2.x):
  //   - `boolean` is i32 (`true`→1.0 / `false`→0.0), and
  //   - `undefined` / `void` / `null` lower to an f64 `NaN` (CLAUDE.md: "null/
  //     undefined in f64 context → f64.const NaN"). For `isInteger`/`isFinite`/
  //     `isSafeInteger` the NaN happens to yield the correct `false`, but
  //     `Number.isNaN(undefined)` would wrongly return `true`.
  // Exclude them so they take the runtime `__typeof_number` guard, which reports
  // a non-number and yields `false`.
  // (test262 Number/{isInteger,isFinite,isNaN,isSafeInteger}/arg-is-not-number.js.)
  const nonNumberMask = ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
  const isNonNumberPrimitive = (argTsType.flags & nonNumberMask) !== 0;
  const isStaticNumber =
    !isNonNumberPrimitive && (isNumberType(argTsType) || argWasm.kind === "f64" || argWasm.kind === "i32");

  if (isStaticNumber) {
    // Fast path: the argument is statically a number — apply the test directly.
    compileExpression(ctx, fctx, arg, { kind: "f64" });
    const valTmp = allocLocal(fctx, `__numpred_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: valTmp });
    for (const instr of emitPredicate(valTmp)) fctx.body.push(instr);
    return { kind: "i32" };
  }

  // Any-typed argument: inspect the box's runtime type. Non-numbers are `false`
  // (no coercion); numbers unbox to f64 and run the test.
  addUnionImports(ctx);
  const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
  const unboxIdx = ctx.funcMap.get("__unbox_number")!;

  compileExpression(ctx, fctx, arg, { kind: "externref" });
  const boxTmp = allocLocal(fctx, `__numpred_box_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxTmp });

  const valTmp = allocLocal(fctx, `__numpred_${fctx.locals.length}`, { kind: "f64" });

  fctx.body.push({ op: "local.get", index: boxTmp });
  fctx.body.push({ op: "call", funcIdx: typeofNumIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: boxTmp },
      { op: "call", funcIdx: unboxIdx },
      { op: "local.set", index: valTmp },
      ...emitPredicate(valTmp),
    ],
    else: [{ op: "i32.const", value: 0 }],
  });
  return { kind: "i32" };
}

/**
 * (#2069) Detect whether a named callee was declared with an explicit
 * TypeScript `this` parameter (`function f(this: T, …)`). Such a function
 * materializes a leading `externref` `this` slot in its Wasm signature, so a
 * `.call`/`.apply` lowering must thread the user's thisArg into that slot
 * rather than dropping it. Returns the function's first ParameterDeclaration
 * when it is the `this` pseudo-parameter, else undefined.
 */
function getExplicitThisParam(ctx: CodegenContext, callee: ts.Expression): ts.ParameterDeclaration | undefined {
  const sym = ctx.checker.getSymbolAtLocation(callee);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (
    decl &&
    (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) &&
    decl.parameters.length > 0
  ) {
    const p0 = decl.parameters[0]!;
    if (ts.isIdentifier(p0.name) && p0.name.text === "this") return p0;
  }
  return undefined;
}

/**
 * #2088 — `String.fromCharCode` / `String.fromCodePoint`, all four lanes
 * (native helper × host import) served by one definition.
 *
 * Each argument becomes a one-char(-or-code-point) string via `helperIdx`;
 * the variadic concatenation that joins them is the shared
 * {@link emitVariadicStringConcat} primitive, so the single-argument-drop bug
 * that #2122 / #1955 fixed independently in every arm can no longer reappear
 * in just one lane.
 *
 * `native` selects the representation: native helpers concat with
 * `__str_concat` over `(ref $NativeString)` parts (zero host imports); the
 * host import path concats with the `wasm:js-string` `concat` builtin over
 * externref parts. `argToCode` is the per-argument numeric coercion the helper
 * expects (`i32.trunc_sat_f64_s` for the i32-typed native helpers,
 * `f64.convert_i32_s` for the f64-typed host imports).
 */
export function compileFromCharCodeFamily(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  opts: { native: boolean; helperIdx: number; isFromCodePoint?: boolean },
): ValType | null {
  const { native, helperIdx, isFromCodePoint } = opts;
  const repr = native ? nativeStringRepr(ctx) : hostStringRepr(ctx);
  if (repr === undefined) return null;

  // Build one string `part` per argument by compiling its code into a buffer
  // and applying the per-rep numeric coercion + the 1-char-string helper. The
  // buffers are registered with `ctx.liveBodies` so a late import added while
  // compiling a *later* argument still shifts indices baked into earlier ones.
  const parts: Instr[][] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const buf: Instr[] = [];
    ctx.liveBodies.add(buf);
    const savedBody = fctx.body;
    fctx.body = buf;
    try {
      const argType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "f64" });
      // #2601 — §22.1.2.2 step 2b/2c: each fromCodePoint code point, after
      // ToNumber, must be an INTEGRAL Number in [0, 0x10FFFF] else RangeError.
      // (fromCharCode does ToUint16 with NO such check — fromCodePoint-only.)
      // Scoped to standalone/WASI (`noJsHost`): the throw uses the in-module
      // `__new_RangeError` constructor with no host bridge. The JS-host lane
      // keeps its existing host-delegated behaviour (the slice is standalone).
      const emitRangeGuard = isFromCodePoint === true && noJsHost(ctx);
      if (emitRangeGuard) {
        // Normalise to f64, then test `trunc(cp) != cp` (catches fractional AND
        // NaN) OR `cp < 0` OR `cp > 0x10FFFF` (±∞ caught by the range test).
        if (argType && argType.kind === "i32") buf.push({ op: "f64.convert_i32_s" });
        const cpTmp = allocLocal(fctx, `__fcp_cp_${fctx.locals.length}`, { kind: "f64" });
        buf.push({ op: "local.tee", index: cpTmp });
        // integral: trunc(cp) != cp  → also true for NaN
        buf.push({ op: "local.get", index: cpTmp });
        buf.push({ op: "f64.trunc" });
        buf.push({ op: "f64.ne" });
        // range: cp < 0
        buf.push({ op: "local.get", index: cpTmp });
        buf.push({ op: "f64.const", value: 0 });
        buf.push({ op: "f64.lt" });
        // range: cp > 0x10FFFF
        buf.push({ op: "local.get", index: cpTmp });
        buf.push({ op: "f64.const", value: 0x10ffff });
        buf.push({ op: "f64.gt" });
        buf.push({ op: "i32.or" });
        buf.push({ op: "i32.or" });
        const throwBuf: Instr[] = [];
        const savedForThrow = fctx.body;
        fctx.body = throwBuf;
        emitThrowRangeError(ctx, fctx, "RangeError: Invalid code point");
        fctx.body = savedForThrow;
        buf.push({ op: "if", blockType: { kind: "empty" }, then: throwBuf });
        // Re-push the validated code point for the helper.
        buf.push({ op: "local.get", index: cpTmp });
      }
      if (native) {
        if (emitRangeGuard) {
          // Already f64 in the temp above — trunc to the i32 the native helper wants.
          buf.push({ op: "i32.trunc_sat_f64_s" });
        } else if (argType && argType.kind !== "i32") {
          // (#2875 slice 5) §7.1.8 ToUint16 computed in the f64 domain BEFORE
          // the i32 conversion: t = trunc(x); m = t − floor(t/2^16)·2^16 ∈
          // [0, 65535]. Division by 2^16 is a pure exponent shift, so every
          // step is exact for all finite f64s; NaN and ±Inf propagate to a NaN
          // m (Inf−Inf), which i32.trunc_sat then maps to the spec's +0.
          // A bare `i32.trunc_sat_f64_s` SATURATES first — +Inf → 0x7FFFFFFF,
          // which the helper's low-16 mask turns into 0xFFFF instead of 0
          // (S9.7_A1 #5), and any |x| ≥ 2^31 loses its true modulo the same
          // way. (The i32-typed arg arm needs none of this: the helper's mask
          // IS ToUint16 for i32-representable integers.)
          const u16Tmp = allocLocal(fctx, `__fcc_u16_${fctx.locals.length}`, { kind: "f64" });
          buf.push({ op: "f64.trunc" });
          buf.push({ op: "local.tee", index: u16Tmp });
          buf.push({ op: "local.get", index: u16Tmp });
          buf.push({ op: "f64.const", value: 65536 });
          buf.push({ op: "f64.div" });
          buf.push({ op: "f64.floor" });
          buf.push({ op: "f64.const", value: 65536 });
          buf.push({ op: "f64.mul" });
          buf.push({ op: "f64.sub" });
          buf.push({ op: "i32.trunc_sat_f64_s" });
        }
      } else {
        if (argType && argType.kind === "i32") buf.push({ op: "f64.convert_i32_s" });
      }
      buf.push({ op: "call", funcIdx: helperIdx });
    } finally {
      fctx.body = savedBody;
    }
    parts.push(buf);
  }

  fctx.body.push(...emitVariadicStringConcat(repr, parts));
  // The part instructions now live (spliced) inside `fctx.body`, which every
  // future `flushLateImportShifts` already walks. Drop the standalone buffer
  // registrations so the same instruction objects are not shifted twice (the
  // shift dedup keys on array identity, not instruction identity).
  for (const buf of parts) ctx.liveBodies.delete(buf);
  return repr.resultType;
}

/**
 * (#2166 PR-D3) Build the array-form `JSON.stringify` replacer allowlist as a
 * plain `$Object` whose own keys are the (String/Number-coerced) elements of an
 * array-literal replacer, and leave it on the stack as an externref. The codec
 * tests membership with `__extern_has`, so the stored value is immaterial — we
 * store the key string itself. Per §25.5.2 SerializeJSONArray-replacer rules
 * only String and Number elements contribute a key; duplicates collapse (a
 * second `__extern_set` of the same key is a no-op for membership). Other
 * element kinds (booleans, objects, dynamic expressions) are ignored, matching
 * the spec's "only String/Number" filter for the common static-array case.
 */
function emitJsonReplacerAllowList(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrayLit: ts.ArrayLiteralExpression,
): void {
  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const allowLocal = allocLocal(fctx, `__json_allow_${fctx.locals.length}`, { kind: "externref" });
  // allow = __new_plain_object()
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  fctx.body.push({ op: "local.set", index: allowLocal });
  const seen = new Set<string>();
  for (const el of arrayLit.elements) {
    let key: string | undefined;
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
      key = el.text;
    } else if (ts.isNumericLiteral(el)) {
      // Number element → its String() form (e.g. 0 → "0").
      key = String(Number(el.text));
    } else if (
      ts.isPrefixUnaryExpression(el) &&
      el.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(el.operand)
    ) {
      key = String(-Number(el.operand.text));
    }
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    // __extern_set(allow, key, key) — value is immaterial (membership only).
    fctx.body.push({ op: "local.get", index: allowLocal });
    for (const instr of nativeStringLiteralInstrs(ctx, key)) fctx.body.push(instr);
    fctx.body.push({ op: "extern.convert_any" });
    for (const instr of nativeStringLiteralInstrs(ctx, key)) fctx.body.push(instr);
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "call", funcIdx: externSetIdx });
  }
  // leave the allowlist object on the stack as externref
  fctx.body.push({ op: "local.get", index: allowLocal });
}

/**
 * #2632 Phase 1 — lower `setTimeout` / `setInterval` / `clearTimeout` /
 * `clearInterval` / `queueMicrotask` onto the WASI timer-heap + run-loop
 * reactor. Returns `undefined` when this is not a WASI timer call (so the
 * generic dispatcher continues), or an `InnerResult` when handled.
 *
 * Only bare-identifier callees fire (a member call like `obj.setTimeout(...)`
 * is a user method, never the global). The timer heap was registered in the
 * deferred-helper phase (`ensureTimerHeap`), so `__timer_add` / `__timer_cancel`
 * func indices are already final.
 */
function tryWasiTimerCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.wasi) return undefined;
  if (!ts.isIdentifier(expr.expression)) return undefined;
  const name = expr.expression.text;

  // #2632 Phase 2 — `__wasiStdinReadByte()` reads the next byte the fd0 reactor
  // buffered into the internal stdin buffer (or -1 if empty), as a JS number.
  // This is the internal-buffer primitive Phase 3's `process.stdin.read()`
  // builds on. The timer heap + run loop were registered in the deferred phase.
  if (name === "__wasiStdinReadByte") {
    emitStdinReadByte(ctx, fctx);
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }

  // #2632 Phase 3 — internal-buffer query primitives the library `process.stdin`
  // Readable builds on: how many bytes are buffered+unread, and whether fd0 has
  // hit EOF with the buffer fully drained.
  if (name === "__wasiStdinAvailable") {
    emitStdinAvailable(ctx, fctx);
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }
  if (name === "__wasiStdinEof") {
    emitStdinEof(ctx, fctx);
    // boolean result (i32 0/1)
    return { kind: "i32" };
  }
  // #2735 — `__wasiStdinStop()` drops the fd0 subscription so the reactor can
  // terminate WITHOUT stdin EOF (in-band shutdown / `process.stdin.destroy()`).
  // The library `Readable.destroy()` lowers to this.
  if (name === "__wasiStdinStop") {
    emitStdinStop(ctx, fctx);
    return VOID_RESULT;
  }
  // #2632 Phase 3 — `__wasiStdinSetReader(cb)` registers the Readable's pump as
  // the reactor-tick hook (run loop call_ref's it each tick after the drain).
  // The callback closure is compiled into a `$__mt_func_type` wrapper + captures
  // exactly like a timer callback, then stored into the hook globals.
  if (name === "__wasiStdinSetReader") {
    ensureTimerHeap(ctx);
    const cbArg = expr.arguments[0];
    if (cbArg === undefined) return VOID_RESULT;
    let capInstrs: Instr[];
    let closureInfo: ClosureInfo | undefined;
    {
      const saved = pushBody(fctx);
      try {
        const type =
          ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
            ? compileArrowAsClosure(ctx, fctx, cbArg)
            : compileExpression(ctx, fctx, cbArg);
        if (type && (type.kind === "ref" || type.kind === "ref_null")) {
          closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
        }
        if (!closureInfo && ts.isIdentifier(cbArg)) {
          closureInfo = ctx.closureMap.get(cbArg.text);
        }
        if (closureInfo && type && type.kind !== "externref") {
          coerceType(ctx, fctx, type, { kind: "externref" });
        }
      } finally {
        capInstrs = fctx.body;
        popBody(fctx, saved);
      }
    }
    if (!closureInfo) return undefined;
    const wrapperFuncIdx = emitTimerCallbackWrapper(ctx, closureInfo);
    emitStdinSetReader(ctx, fctx, [{ op: "ref.func", funcIdx: wrapperFuncIdx }], capInstrs);
    return VOID_RESULT;
  }

  if (
    name !== "setTimeout" &&
    name !== "setInterval" &&
    name !== "clearTimeout" &&
    name !== "clearInterval" &&
    name !== "queueMicrotask"
  ) {
    return undefined;
  }
  // Guard against a user-defined local/function shadowing the global name. The
  // global timer functions are declared ONLY in lib .d.ts files; a user shadow
  // has at least one declaration in a real (.ts) source file. (`setTimeout` &c
  // are also registered as inlinable lib stubs in ctx.funcMap, so a funcMap
  // membership check would false-positive — use the symbol's declarations.)
  {
    const sym = ctx.checker.getSymbolAtLocation(expr.expression);
    const decls = sym?.declarations;
    if (decls && decls.length > 0 && !decls.every((d) => d.getSourceFile().isDeclarationFile)) {
      return undefined; // user-defined shadow → not the global timer
    }
  }

  // Ensure the timer heap exists. It is normally registered eagerly in the
  // deferred-helper phase; this call is idempotent and a safety net.
  ensureTimerHeap(ctx);

  // ── clearTimeout(id) / clearInterval(id) ──────────────────────────────
  if (name === "clearTimeout" || name === "clearInterval") {
    if (expr.arguments.length < 1) return VOID_RESULT;
    // id is a JS number (f64). Convert to the i32 slot id.
    const saved = pushBody(fctx);
    compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
    const idInstrs = fctx.body;
    popBody(fctx, saved);
    idInstrs.push({ op: "i32.trunc_sat_f64_s" });
    emitTimerCancel(ctx, fctx, idInstrs);
    return VOID_RESULT;
  }

  // ── setTimeout / setInterval / queueMicrotask: compile the callback ──
  const cbArg = expr.arguments[0];
  if (cbArg === undefined) return VOID_RESULT;

  // Compile the callback into its own buffer, yielding a closure struct pushed
  // as externref + its ClosureInfo (mirrors compileStandalonePromiseThenCallback).
  let capInstrs: Instr[];
  let closureInfo: ClosureInfo | undefined;
  {
    const saved = pushBody(fctx);
    try {
      const type =
        ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
          ? compileArrowAsClosure(ctx, fctx, cbArg)
          : compileExpression(ctx, fctx, cbArg);
      if (type && (type.kind === "ref" || type.kind === "ref_null")) {
        closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
      }
      if (!closureInfo && ts.isIdentifier(cbArg)) {
        closureInfo = ctx.closureMap.get(cbArg.text);
      }
      if (closureInfo && type && type.kind !== "externref") {
        coerceType(ctx, fctx, type, { kind: "externref" });
      }
    } finally {
      capInstrs = fctx.body;
      popBody(fctx, saved);
    }
  }
  if (!closureInfo) {
    // Not a recognised closure (e.g. a string-bodied setTimeout, unsupported).
    // Bail to the generic path, which will reject/handle it.
    return undefined;
  }

  const wrapperFuncIdx = emitTimerCallbackWrapper(ctx, closureInfo);

  // ── queueMicrotask(cb) — enqueue directly onto the microtask queue ────
  if (name === "queueMicrotask") {
    emitMicrotaskEnqueue(
      ctx,
      fctx,
      [{ op: "ref.func", funcIdx: wrapperFuncIdx }],
      capInstrs, // captures externref = the closure struct
      [{ op: "ref.null.extern" }], // value = undefined
    );
    return VOID_RESULT;
  }

  // ── setTimeout(cb, ms) / setInterval(cb, ms) ──────────────────────────
  // delayNs = max(0, ms) * 1e6 ; deadlineNs = now + delayNs.
  const nowIdx = getRunLoopNowFuncIdx(ctx);
  const delayNsLocal = allocLocal(fctx, `__timer_delay_${fctx.locals.length}`, { kind: "i64" });

  // Compute delayNs into a local: trunc(ms) clamped to >= 0, times 1e6.
  if (expr.arguments.length >= 2) {
    compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
  }
  // Clamp negative / NaN ms to 0 (Node treats ms<=0 or NaN as 0).
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.max" });
  fctx.body.push({ op: "i64.trunc_sat_f64_s" });
  fctx.body.push({ op: "i64.const", value: 1000000n });
  fctx.body.push({ op: "i64.mul" });
  fctx.body.push({ op: "local.set", index: delayNsLocal });

  const deadlineInstrs: Instr[] = [
    { op: "call", funcIdx: nowIdx },
    { op: "local.get", index: delayNsLocal },
    { op: "i64.add" },
  ];
  // interval period: setInterval re-arms with delayNs; setTimeout = 0 (one-shot).
  const intervalInstrs: Instr[] =
    name === "setInterval" ? [{ op: "local.get", index: delayNsLocal }] : [{ op: "i64.const", value: 0n }];

  emitTimerAdd(
    ctx,
    fctx,
    deadlineInstrs,
    [{ op: "ref.func", funcIdx: wrapperFuncIdx }],
    capInstrs, // captures externref = the closure struct
    intervalInstrs,
  );
  // __timer_add returns the i32 id; setTimeout/setInterval return a JS number.
  fctx.body.push({ op: "f64.convert_i32_s" });
  return { kind: "f64" };
}

/**
 * (#3146) Iterator-statics prelude intrinsics — the four `__j2w_iter_*`
 * bare-identifier calls the injected standalone `Iterator.zip / zipKeyed /
 * concat / from` prelude (src/iterator-statics-prelude.ts) rides on. Each
 * lowers onto the NATIVE iterator runtime (iterator-native.ts), so the
 * prelude inherits the full GetIterator ladder (vec / vec-family / USER
 * closed-struct / OBJ plain-object / host-gen / async-gen carriers),
 * receiver-correct `.next()` stepping, and `.return()`-forwarding
 * IteratorClose without any new host import:
 *   - `__j2w_iter_rec(o)`    → `__iterator(o)`             (externref rec)
 *   - `__j2w_iter_step(rec)` → `__iterator_next(rec)`; the step VALUE is
 *     parked in the scratch global, the i32 done flag is returned as f64 0/1
 *   - `__j2w_iter_value()`   → reads the parked step value
 *   - `__j2w_iter_close(rec)`→ `__iterator_return(rec)`    (IteratorClose)
 *
 * Returns `undefined` when this is not an intrinsic call (generic dispatch
 * continues). Gated to the host-free targets — the prelude is only ever
 * injected under `--target standalone|wasi`, and in JS-host mode the
 * runtime.ts polyfills own these helpers (#1464).
 */
function tryIteratorStaticsIntrinsicCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (!ts.isIdentifier(expr.expression)) return undefined;
  const name = expr.expression.text;
  if (
    name !== "__j2w_iter_rec" &&
    name !== "__j2w_iter_step" &&
    name !== "__j2w_iter_value" &&
    name !== "__j2w_iter_close"
  ) {
    return undefined;
  }

  ensureNativeIteratorRuntime(ctx);

  if (name === "__j2w_iter_value") {
    const scratchIdx = ensureIterStepScratchGlobal(ctx);
    fctx.body.push({ op: "global.get", index: scratchIdx });
    return { kind: "externref" };
  }

  const arg = expr.arguments[0];
  if (arg === undefined) return undefined; // malformed — let generic dispatch report
  const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argType && argType.kind !== "externref") {
    coerceType(ctx, fctx, argType, { kind: "externref" });
  }
  flushLateImportShifts(ctx, fctx);

  if (name === "__j2w_iter_rec") {
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator")! });
    return { kind: "externref" };
  }
  if (name === "__j2w_iter_step") {
    const scratchIdx = ensureIterStepScratchGlobal(ctx);
    // (i32 done, externref value) — park the value, surface done as f64 0/1.
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator_next")! });
    fctx.body.push({ op: "global.set", index: scratchIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }
  // __j2w_iter_close
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator_return")! });
  return VOID_RESULT;
}

function compileCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  expectedType?: ValType,
): InnerResult {
  // Optional chaining on calls: obj?.method() and obj.method?.().
  //
  // In the TS AST the `?.` of `o?.m(args)` sits on the inner
  // PropertyAccessExpression, NOT on the CallExpression — only `o.m?.(args)`
  // sets `expr.questionDotToken`. Gating on the call token alone (#2049) missed
  // the common `o?.m(args)` form, so it fell into the regular method-call path
  // which evaluates arguments unconditionally and derefs the receiver (trapping
  // on a null class instance). Gate on the optional chain itself so both forms
  // route to the short-circuiting path.
  if (ts.isOptionalChain(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    return compileOptionalCallExpression(ctx, fctx, expr);
  }

  // (#1732/#2180) Calling a built-in non-constructor namespace (Math, JSON,
  // Reflect, Atomics, Proxy) as a function must throw TypeError ("no [[Call]]").
  // Extracted to calls-guards.ts (#742).
  {
    const r = tryNamespaceNonCallable(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#1540) JSX runtime call intercept — `_jsx` / `_jsxs` / `_jsxDEV`. Routed to
  // the matching `__jsx_runtime_*` host import. Extracted to calls-guards.ts (#742).
  {
    const r = tryJsxRuntimeCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // #2632 Phase 1 — WASI event-loop timers / microtasks. setTimeout/setInterval/
  // clearTimeout/clearInterval/queueMicrotask lower onto the timer heap + run-loop
  // reactor (async-scheduler.ts). Only fires under --target wasi; everything else
  // falls through to the JS-host import path unchanged.
  {
    const r = tryWasiTimerCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#2924) Constant `Function("<params>", …, "<body>")` compile-away — both
  // the plain-call value form and the immediate-call form
  // (`new Function(...)(args)` / `Function(...)(args)`). Non-constant args or
  // a local `Function` shadow fall through to the existing paths.
  {
    const r = tryStaticFunctionCtorCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#2960) DYNAMIC immediate-call `new Function(<non-const>)(args)` /
  // `Function(<non-const>)(args)` in JS-host mode. The constant compile-away
  // above declined (non-constant args), so the callee compiles to the
  // meta-circular shim's real host-callable value. A wasm-side `f(args)` on a
  // plain host-function externref returns undefined (the general any-callee
  // host-function limitation), so route the call through the `__call_function`
  // host helper (the same packer bound functions use).
  if (!noJsHost(ctx) && !ctx.nativeStrings && isFunctionCtorImmediateCall(expr, ctx.checker)) {
    const r = emitBoundFunctionCall(ctx, fctx, expr);
    if (r !== null) return r;
  }

  // (#2921) `__drain_microtasks()` — explicit microtask-queue drain intrinsic
  // (banked from the closed #2367/#2867 PR-B; the funcIdx-shift half already
  // landed via #2918). Lets a standalone/WASI embedder — and, once the carrier
  // is activated for `--target standalone` (blocked on #2864's native $Frame),
  // the test262 harness verdict-read — flush pending native `$Promise` reactions
  // before observing module state. Native `.then` reactions are QUEUED, not run
  // synchronously, so assertions inside them set state only once the queue drains.
  //
  // Fully INERT until something *calls* it: it emits the native drain ONLY when
  // the microtask queue is already registered (some `.then`/Promise lowered
  // earlier on a carrier target, `getDrainFuncIdxForWasiStart` non-null).
  // Otherwise — every JS-host compile (the host owns its own microtask queue),
  // and any carrier module with no Promise — it is a silent VOID no-op that emits
  // NOTHING, so the identifier can be introduced into a wrapper unconditionally
  // without leaking an import, forcing queue infra into Promise-free modules, or
  // disturbing JS-host / gc / linear codegen (byte-identical off the carrier path).
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "__drain_microtasks" &&
    expr.arguments.length === 0
  ) {
    const drainIdx = getDrainFuncIdxForWasiStart(ctx);
    if (drainIdx !== null) {
      fctx.body.push({ op: "call", funcIdx: drainIdx });
    }
    return VOID_RESULT;
  }

  // (#3146) Iterator-statics prelude intrinsics (`__j2w_iter_*`) — lower onto
  // the native iterator runtime under the host-free targets. Byte-neutral for
  // every program the prelude was not injected into.
  {
    const r = tryIteratorStaticsIntrinsicCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // Node-shaped process APIs are lowered in their own module so the generic
  // call-expression compiler does not accumulate host API special cases.
  const nodeProcessCall = tryCompileNodeProcessCall(ctx, fctx, expr);
  if (nodeProcessCall !== undefined) return nodeProcessCall;

  // #2657 — raw `wasi_snapshot_preview1` fd_read/fd_write → direct WASI import
  // call (the most honest pure-WASI-P1 path; no node:fs surface). Sits before the
  // node:fs path; byte-neutral unless the source imports the raw WASI module.
  const rawWasiCall = tryCompileRawWasiCall(ctx, fctx, expr);
  if (rawWasiCall !== undefined) return rawWasiCall;

  // #2631 — node:fs fd-based readSync/writeSync → `node:fs` shim calls.
  const nodeFsCall = tryCompileNodeFsCall(ctx, fctx, expr);
  if (nodeFsCall !== undefined) return nodeFsCall;

  // #2684 — Deno synchronous stdio (`Deno.stdin.readSync` /
  // `Deno.{stdout,stderr}.writeSync`) → direct WASI fd_read/fd_write. Ambient
  // global, recognized by member-call shape; byte-neutral unless `Deno.` is used.
  const denoStdioCall = tryCompileDenoStdioCall(ctx, fctx, expr);
  if (denoStdioCall !== undefined) return denoStdioCall;

  // RegExp(pattern, flags) called without `new`. Extracted to calls-guards.ts (#742).
  {
    const r = tryRegExpConstructorCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // `Object(x)` called without `new` — §20.1.1.1 / §7.1.18 ToObject.
  // Extracted to calls-guards.ts (#742).
  {
    const r = tryObjectCoercionCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // Optional chaining on direct call: fn?.()
  if (expr.questionDotToken && ts.isIdentifier(expr.expression)) {
    return compileOptionalDirectCall(ctx, fctx, expr);
  }

  // eval(...) — first try static inlining (#1163): if the source argument is
  // a compile-time-constant string, parse it and splice the AST inline at the
  // call site.  This is the zero-runtime-cost path.  If the argument is not
  // a constant (or parsing fails), fall through to __extern_eval (#1006/#1164).
  // Covers direct `eval(src)` and indirect `(0, eval)(src)` / `(0,eval)(src)`.
  // In standalone/WASI mode the host import is unavailable and will trap at
  // instantiation time — callers that need eval must use a JS host.
  //
  // #1164: signature is `(externref src, i32 isDirect) -> externref`.  The
  // isDirect flag (1 = direct call, 0 = indirect) lets the host shim
  // preserve ECMA-262 §19.2.1 scope semantics — direct eval has access to
  // the caller's lexical scope, indirect eval runs in global scope.
  {
    const evalKind = classifyEvalCallExpression(expr, ctx.checker);
    if (evalKind !== "none") {
      // #1229 — peephole: `eval("/" + X + "/")` → `new RegExp(X)`.
      // Test262's BMP-codepoint regex tests build a regex literal per
      // iteration via eval; the eval pipeline (TS+codegen+wasm-instantiate)
      // is ~50ms per call, hitting the 30s pool ceiling on the first few
      // hundred of 65k iterations. Rewriting to the RegExp constructor
      // avoids the eval pipeline entirely — one host call (regex parse +
      // compile) instead of two (eval pipeline + regex parse + compile).
      // The semantic difference (eval throws SyntaxError-by-eval; new RegExp
      // throws SyntaxError-by-RegExp) is invisible to callers that only
      // inspect `.source` / `.flags` / matching behavior, which is the
      // entire test set this targets.
      const rewritten = tryEvalAsRegExpPeephole(ctx, fctx, expr);
      if (rewritten !== undefined) return rewritten;
      const inlined = tryStaticEvalInline(ctx, fctx, expr);
      if (inlined !== undefined) return inlined;
      // (#2960) No-JS-host (standalone / wasi): the `__extern_eval` host import
      // is unsatisfiable and previously leaked into the binary, trapping only at
      // instantiation with zero compile-time signal. Instead emit a
      // source-located WARNING and, for the dynamic case, a CATCHABLE throw at
      // the eval call site (a program that never reaches this eval keeps
      // working). The static-constant path (tryStaticEvalInline above) already
      // splices inline and returned; only genuine dynamic eval reaches here.
      if (noJsHost(ctx)) {
        reportError(
          ctx,
          expr,
          "Warning: dynamic eval is not supported in --target standalone/wasi — no " +
            "runtime-eval host is available; this eval call throws at runtime " +
            "(tracking: runtime-eval goal, bytecode interpreter #2928)",
          "warning",
        );
        // Evaluate the argument expressions for their side effects first.
        for (const a of expr.arguments) {
          const t = compileExpression(ctx, fctx, a);
          if (t !== null) fctx.body.push({ op: "drop" });
        }
        emitThrowTypeError(ctx, fctx, "dynamic eval is not supported in standalone mode (#2928)");
        // The throw is stack-polymorphic; return the nominal eval result type.
        return { kind: "externref" };
      }
      let evalIdx = ctx.funcMap.get("__extern_eval");
      if (evalIdx === undefined) {
        const importsBefore = ctx.numImportFuncs;
        const evalType = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "__extern_eval", { kind: "func", typeIdx: evalType });
        shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
        evalIdx = ctx.funcMap.get("__extern_eval");
      }
      if (evalIdx === undefined) {
        fctx.body.push({ op: "unreachable" });
        return null;
      }
      if (expr.arguments.length === 0) {
        // eval() with no args returns undefined per spec.  Avoid the host
        // round-trip entirely.
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      const srcArg = expr.arguments[0]!;
      const srcType = compileExpression(ctx, fctx, srcArg);
      if (srcType && srcType.kind !== "externref") {
        coerceType(ctx, fctx, srcType, { kind: "externref" });
      }
      // Push isDirect flag.
      fctx.body.push({ op: "i32.const", value: evalKind === "direct" ? 1 : 0 });
      for (let ai = 1; ai < expr.arguments.length; ai++) {
        const extraType = compileExpression(ctx, fctx, expr.arguments[ai]!);
        if (extraType) fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "call", funcIdx: evalIdx });
      return { kind: "externref" };
    }
  }

  // import.defer(...) / import.source(...) — Stage 3 proposals not implemented.
  // Without this guard, falling through to type-resolution lower in the call
  // pipeline triggers `Debug Failure: Trying to get the type of import.defer
  // in import.defer(...)` from the TypeScript checker (it doesn't know how to
  // type these meta-properties). Emit a clean compile error instead — for
  // negative parse/early SyntaxError tests this counts as the expected error
  // (compilation rejecting the source). #1315.
  if (
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    (expr.expression.name.text === "defer" || expr.expression.name.text === "source")
  ) {
    reportError(
      ctx,
      expr,
      `SyntaxError: import.${expr.expression.name.text}(...) is not supported (Stage 3 proposal — import-defer / source-phase-imports)`,
    );
    return null;
  }

  // Dynamic import() — delegate to __dynamic_import host import.
  // Takes a specifier (externref string) and returns an externref (Promise).
  // In standalone (no JS host) mode, this will trap since there is no host.
  if (expr.expression.kind === ts.SyntaxKind.ImportKeyword) {
    // Ensure __dynamic_import is registered
    let dynIdx = ctx.funcMap.get("__dynamic_import");
    if (dynIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const dynType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__dynamic_import", { kind: "func", typeIdx: dynType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      dynIdx = ctx.funcMap.get("__dynamic_import");
    }
    if (dynIdx === undefined) {
      fctx.body.push({ op: "unreachable" });
      return null;
    }
    // Compile the specifier argument
    const specArg = expr.arguments[0];
    if (specArg) {
      const specResult = compileExpression(ctx, fctx, specArg);
      // Coerce to externref if needed
      if (specResult && specResult.kind !== "externref") {
        coerceType(ctx, fctx, specResult, { kind: "externref" });
      }
    } else {
      // No argument — pass undefined (null externref)
      fctx.body.push({ op: "ref.null.extern" });
    }

    // Evaluate remaining arguments (e.g. import attributes/options) for side effects.
    // Per spec, the second argument (optionsExpression) is evaluated before the
    // host import is performed. If it throws, the throw propagates synchronously.
    // We evaluate and drop the result since __dynamic_import only takes the specifier.
    for (let ai = 1; ai < expr.arguments.length; ai++) {
      const extraArg = expr.arguments[ai];
      const extraResult = compileExpression(ctx, fctx, extraArg);
      // Drop the value from the stack if the expression produced one
      if (extraResult) {
        fctx.body.push({ op: "drop" });
      }
    }

    fctx.body.push({ op: "call", funcIdx: dynIdx });
    return { kind: "externref" };
  }

  // Unwrap parenthesized callee: (fn)(...), ((obj.method))(...) etc.
  // This handles patterns like (0, fn)() which are already handled below,
  // but also (fn)(), ((fn))(), (obj.method)() etc. which would otherwise fail.
  if (ts.isParenthesizedExpression(expr.expression)) {
    let unwrapped: ts.Expression = expr.expression;
    // Strip parentheses AND type-only callee wrappers (`as T`, `satisfies T`,
    // `<T>x`). A type cast is a compile-time no-op, so `(eval as any)()` must
    // behave exactly like `eval()`. Critically, `AsExpression` /
    // `SatisfiesExpression` / `TypeAssertion` are NOT `LeftHandSideExpression`s,
    // so if we left them wrapped and fell through to the generic synthetic-call
    // path below, `ts.factory.createCallExpression` would re-wrap the callee in
    // a `ParenthesizedExpression` and the re-entry would rebuild an identical
    // synthetic call → unbounded recursion (#3005). Stripping them here lets the
    // inner expression reach its normal callee handling (e.g. eval special-casing).
    while (
      ts.isParenthesizedExpression(unwrapped) ||
      ts.isAsExpression(unwrapped) ||
      ts.isSatisfiesExpression(unwrapped) ||
      ts.isTypeAssertionExpression(unwrapped)
    ) {
      unwrapped = unwrapped.expression;
    }
    // Only unwrap if it's NOT a function expression or arrow (those are IIFEs, handled later)
    // and NOT a binary/comma expression (handled separately below)
    if (
      !ts.isFunctionExpression(unwrapped) &&
      !ts.isArrowFunction(unwrapped) &&
      !(ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken)
    ) {
      // Handle conditional callee inline: (cond ? fn1 : fn2)(args)
      // Cannot create a synthetic call because ts.factory wraps non-LeftHandSide
      // expressions in ParenthesizedExpression, causing infinite recursion.
      if (ts.isConditionalExpression(unwrapped)) {
        return compileConditionalCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle assignment/binary expressions as callee: (x = fn)(), (a || fn)()
      // These are non-LeftHandSideExpressions, so ts.factory.createCallExpression
      // would re-wrap them in ParenthesizedExpression, causing infinite recursion.
      // Instead, compile the expression for its side effects and value, then use
      // the generic closure-matching path to call the result.
      if (ts.isBinaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle prefix/postfix unary as callee (rare but possible)
      if (ts.isPrefixUnaryExpression(unwrapped) || ts.isPostfixUnaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      const syntheticCall = ts.factory.createCallExpression(
        unwrapped as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Unwrap `expr!(...)` non-null assertions on the callee (#1298). The TS type
  // of NonNullExpression is the original type minus null/undefined, so the
  // underlying PropertyAccessExpression / Identifier / etc. dispatch sees a
  // callable type. Mirrors the ParenthesizedExpression unwrap above.
  if (ts.isNonNullExpression(expr.expression)) {
    let inner: ts.Expression = expr.expression.expression;
    // Strip nested non-null assertions: `obj.fn!!(...)`
    while (ts.isNonNullExpression(inner)) {
      inner = inner.expression;
    }
    // Only build a synthetic CallExpression for LeftHandSide-shaped inner
    // expressions; non-LHS (e.g. binary, conditional) would be re-wrapped in
    // ParenthesizedExpression by ts.factory and infinite-recurse. For those,
    // fall through to compileExpressionCallee.
    if (
      !ts.isFunctionExpression(inner) &&
      !ts.isArrowFunction(inner) &&
      !ts.isBinaryExpression(inner) &&
      !ts.isConditionalExpression(inner) &&
      !ts.isPrefixUnaryExpression(inner) &&
      !ts.isPostfixUnaryExpression(inner)
    ) {
      const syntheticCall = ts.factory.createCallExpression(
        inner as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle super.method() calls — resolve to ParentClass_method with this as first arg
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return compileSuperMethodCall(ctx, fctx, expr);
  }

  // (#1467) AggregateError(errors, message, options?) — called WITHOUT `new`.
  // Per ES §20.5.7.1, AggregateError called as a function must construct
  // normally (same effective semantics as `new`). Mirror the codegen in
  // new-super.ts so the without-new and with-new failures resolve together.
  // Must run BEFORE the property-access dispatch since the expression is a
  // bare identifier, and BEFORE the BUILTIN_CLASS_NAMES generic path which
  // would otherwise emit a host-method call without spec coercion.
  // Unwrap parenthesized expressions and as/satisfies casts so
  // `(AggregateError as any)([], 'msg')` also reaches this dispatch.
  let _aggCallee: ts.Expression = expr.expression;
  while (
    ts.isParenthesizedExpression(_aggCallee) ||
    ts.isAsExpression(_aggCallee) ||
    ts.isTypeAssertionExpression(_aggCallee) ||
    ts.isSatisfiesExpression(_aggCallee) ||
    ts.isNonNullExpression(_aggCallee)
  ) {
    _aggCallee = (_aggCallee as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(_aggCallee) && _aggCallee.text === "AggregateError") {
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      const errorsType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      if (errorsType && errorsType.kind !== "externref") {
        coerceType(ctx, fctx, errorsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    if (args.length >= 2) {
      const msgType = compileExpression(ctx, fctx, args[1]!, { kind: "externref" });
      if (msgType && msgType.kind !== "externref") {
        coerceType(ctx, fctx, msgType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    if (args.length >= 3) {
      const optsType = compileExpression(ctx, fctx, args[2]!, { kind: "externref" });
      if (optsType && optsType.kind !== "externref") {
        coerceType(ctx, fctx, optsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_AggregateError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // (#1634) SuppressedError(error, suppressed, message, options?) — called
  // WITHOUT `new`. Per ES §20.5.10.1, called as a function it constructs
  // normally. Mirror the new-super.ts codegen so without-new and with-new
  // resolve together. Unwrap parenthesized/cast wrappers like the AggregateError
  // dispatch above.
  let _suppCallee: ts.Expression = expr.expression;
  while (
    ts.isParenthesizedExpression(_suppCallee) ||
    ts.isAsExpression(_suppCallee) ||
    ts.isTypeAssertionExpression(_suppCallee) ||
    ts.isSatisfiesExpression(_suppCallee) ||
    ts.isNonNullExpression(_suppCallee)
  ) {
    _suppCallee = (_suppCallee as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(_suppCallee) && _suppCallee.text === "SuppressedError") {
    const args = expr.arguments ?? [];
    for (let i = 0; i < 4; i++) {
      if (args.length > i) {
        const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
        if (t && t.kind !== "externref") {
          coerceType(ctx, fctx, t, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_SuppressedError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle property access calls: console.log, Math.xxx, extern methods
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const propAccess = expr.expression;

    // (#2838 L6) Dynamic-`this` method-call dispatch. When the receiver is `this`
    // and the runtime `this` is DYNAMIC (the fctx `this` local is not a concrete
    // struct ref — e.g. inside a runtime-installed accessor getter whose body runs
    // with `__current_this` set, NOT a real typed method) BUT TypeScript has
    // contextually typed `this` as a concrete struct/object (acorn's getter `this`
    // is typed as the descriptor literal `__anon_N`), the static method-dispatch
    // arms below resolve the receiver against that WRONG nominal type. None match
    // the real method, so the call silently degrades to a member-get-then-drop
    // (returns null) and the method never runs — the acorn `this.currentVarScope()`
    // wall (L6). Route such calls through `__extern_method_call`, which binds the
    // receiver via `__current_this` and walks the runtime prototype chain
    // (`_fnctorProtoLookup`) — exactly what the any/externref-receiver fallback
    // already does for a correctly-`any`-typed receiver. The predicate is precise:
    // `resolveThisStructName` (the fctx local's actual ref type) is undefined
    // (dynamic), yet `resolveStructName` of the TS type IS a struct (the lie) — so
    // a genuine typed class/fnctor method (truth AGREES → struct name defined) is
    // never intercepted, and a truly-`any`/module-level `this` (no struct either
    // way) is left to the existing fallback. JS-host only (the dynamic MOP path);
    // the reflective `.call`/`.apply`/`.bind` forms keep their dedicated handlers.
    {
      const mName = propAccess.name.text;
      // Fire ONLY for the descriptor-literal mistype (the acorn getter case): the
      // fctx `this` is dynamic (not a concrete struct ref) AND TS typed it as an
      // `__anon` descriptor object. A genuine typed method (concrete `this`) or a
      // static-method `this` (TS = a real `typeof C` struct, needed for static /
      // private dispatch) is NEVER intercepted — mirrors the L5 read-side rule.
      const tsThisName =
        propAccess.expression.kind === ts.SyntaxKind.ThisKeyword
          ? resolveStructName(ctx, ctx.checker.getTypeAtLocation(propAccess.expression))
          : undefined;
      if (
        !noJsHost(ctx) &&
        propAccess.expression.kind === ts.SyntaxKind.ThisKeyword &&
        // Private members (`this.#m()`) are brand-checked WasmGC elements the host
        // MOP can never see — never route them dynamically (would break static/
        // instance private-method dispatch). The acorn getter chain is all public.
        !ts.isPrivateIdentifier(propAccess.name) &&
        mName !== "call" &&
        mName !== "apply" &&
        mName !== "bind" &&
        resolveThisStructName(ctx, fctx) === undefined &&
        tsThisName !== undefined &&
        // ONLY the descriptor-literal anon struct (`__anon_<n>`, the acorn getter's
        // `this`), NEVER an anonymous CLASS struct (`__anonClass_<n>`) whose
        // static/instance method dispatch must stay static (the #2325 regression).
        tsThisName.startsWith("__anon_")
      ) {
        const dynThisResult = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, mName, expr);
        if (dynThisResult !== null) return dynThisResult;
      }
    }

    const standaloneRegExpExec = tryCompileStandaloneRegExpExec(ctx, fctx, expr, propAccess);
    if (standaloneRegExpExec !== undefined) return standaloneRegExpExec;

    const standaloneRegExpTest = tryCompileStandaloneRegExpTest(ctx, fctx, expr, propAccess);
    if (standaloneRegExpTest !== undefined) return standaloneRegExpTest;

    const standaloneRegExpToString = tryCompileStandaloneRegExpToString(ctx, fctx, expr, propAccess);
    if (standaloneRegExpToString !== undefined) return standaloneRegExpToString;

    // Handle Array.prototype.METHOD.call(obj, ...args) — inline as array method on shape-inferred obj
    {
      const callResult = compileArrayPrototypeCall(ctx, fctx, expr, propAccess);
      if (callResult !== undefined) return callResult;
    }

    // (#1337) Function.prototype.bind.call(fn, thisArg, ...args) reshape.
    // Mirrors the #1596 reshape for Function.prototype.{apply,call}.call: rewrite
    // to `fn.bind(thisArg, ...args)` so the existing #1632a bind dispatch fires
    // and routes through __bind_function instead of leaking to the host's
    // Function.prototype.bind on a wasm-struct receiver ("Bind must be called
    // on a function"). Only the outer `.call` form is matched —
    // `Function.prototype.bind.apply(fn, [thisArg, ...args])` is rare.
    //
    // Narrowing: only fires when the `fn` target has TS call signatures.
    // This preserves the legacy "Function.prototype.bind.call(undefined, ...)
    // throws TypeError" behaviour for spec tests like S15.3.4.5_A13 — the
    // bind dispatch only intercepts callable receivers; non-callable
    // targets fall through to the legacy host path which throws correctly.
    if (
      propAccess.name.text === "call" &&
      ts.isPropertyAccessExpression(propAccess.expression) &&
      propAccess.expression.name.text === "bind" &&
      ts.isPropertyAccessExpression(propAccess.expression.expression) &&
      propAccess.expression.expression.name.text === "prototype" &&
      ts.isIdentifier(propAccess.expression.expression.expression) &&
      propAccess.expression.expression.expression.text === "Function" &&
      expr.arguments.length >= 1
    ) {
      const fnExpr = expr.arguments[0]!;
      const fnTsType = ctx.checker.getTypeAtLocation(fnExpr);
      const fnHasCallSig = (fnTsType?.getCallSignatures?.()?.length ?? 0) > 0;
      if (fnHasCallSig) {
        const reshapedArgs = expr.arguments.slice(1);
        const reshapedProp = ts.factory.createPropertyAccessExpression(fnExpr as ts.LeftHandSideExpression, "bind");
        ts.setTextRange(reshapedProp, propAccess);
        const reshapedCall = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
        ts.setTextRange(reshapedCall, expr);
        (reshapedCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, reshapedCall as ts.CallExpression);
      }
    }

    // Handle fn.bind(thisArg, ...partialArgs).
    //
    // (#1632a) JS-host mode: lower to `__bind_function(target, thisArg, argsArray,
    // nameHint, lengthHint)` which delegates to `Function.prototype.bind` on the host.
    // The host owns [[BoundTargetFunction]] / [[BoundThis]] / [[BoundArguments]] /
    // .name (`"bound " + target.name`) / .length (max(0, target.length - bound.length)) /
    // [[Call]] / [[Construct]] — see runtime.ts:__bind_function. Wasm closure structs
    // are wrapped via `_wrapWasmClosure` so the host receives a real JS callable.
    //
    // Standalone (--target wasi / noJsHost): fall back to identity-bind (drop partial
    // args, return target unchanged). Documented gap: standalone needs a native
    // bound-function struct, tracked as a follow-up to #1632a.
    //
    // Narrowing: only fires when the receiver's TS type has call signatures. This
    // preserves the legacy "throws on non-function receiver" behavior that a
    // handful of test262 assertions implicitly rely on
    // (e.g. `assert.throws(TypeError, () => nonFn.bind())` and `JSON.bind()`).
    //
    // Exclusion: fn.bind(...)(...) (immediate bind+call) is already handled later
    // with proper argument threading — don't intercept it here.
    if (propAccess.name.text === "bind" && !(ts.isCallExpression(expr.parent) && expr.parent.expression === expr)) {
      const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvHasCallSig = (recvTsType?.getCallSignatures?.()?.length ?? 0) > 0;
      if (recvHasCallSig) {
        const bindResult = compileFunctionBind(ctx, fctx, expr, propAccess);
        if (bindResult !== undefined) return bindResult;
      }
    }

    // Handle fn.call(thisArg, ...args) and fn.apply(thisArg, argsArray)
    // For standalone functions (no `this`), drop thisArg and call directly.
    // For class methods, use thisArg as the receiver.
    if (propAccess.name.text === "call" || propAccess.name.text === "apply") {
      const isCall = propAccess.name.text === "call";
      const innerExpr = propAccess.expression;

      // (#2604/#3171) Reflective `X.prototype.METHOD.call(recv, …)` /
      // `inst.METHOD.call(recv, …)` for the four keyed collections — brand-check
      // the receiver ([[MapData]]/[[SetData]]/[[WeakMapData]]/[[WeakSetData]],
      // struct + COLLECTION_KIND tag) and dispatch to the native collection
      // runtimes. Runs BEFORE the generic #2193 member-closure recovery (which
      // has no native-collection knowledge), and only matches a collection
      // method closure under nativeStrings, so it ADDS a collection-specific
      // pre-check without rewriting the generic path. addUnionImports up-front
      // (mirrors extern.ts's direct-path setup) so the arg-boxing `__box_number`
      // the dispatch emits is registered without a mid-body shift.
      if (isCollectionReflectiveCallShape(ctx, expr)) {
        addUnionImports(ctx);
        const collReflResult = tryCompileCollectionReflectiveCall(ctx, fctx, expr);
        if (collReflResult !== undefined) return collReflResult;
      }

      // (#2193 PR-B) Reflective `m.call/apply(thisArg, …)` on a value-erased
      // `$NativeProto` member closure (e.g. `const m = Array.prototype.slice`).
      // Recover the closure from the receiver's TS symbol and call_ref it with
      // thisArg threaded into param 1. Unwrap `as`/parenthesized casts so both
      // `m.call(…)` and `(m as any).call(…)` resolve the underlying symbol.
      {
        let recv: ts.Expression = innerExpr;
        while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv) || ts.isNonNullExpression(recv)) {
          recv = recv.expression;
        }
        const reflResult = tryEmitNativeProtoReflectiveCall(ctx, fctx, expr, recv, isCall);
        if (reflResult !== undefined) return reflResult;

        // (#2876) Reflective `.call`/`.apply` on a getter pulled from a
        // builtin-proto accessor descriptor (`gOPD(RegExp.prototype, "global").get`),
        // recovered by data-flow trace rather than a TS symbol.
        const descAccResult = tryEmitNativeProtoDescriptorAccessorCall(ctx, fctx, expr, recv, isCall);
        if (descAccResult !== undefined) return descAccResult;

        // (#3236 Slice 1b) Reflective `.call`/`.apply` on a dynamically-read
        // %GeneratorPrototype% member closure (`GeneratorPrototype.next.call(x)`).
        // The receiver object is `any`-typed so the symbol-based paths above miss;
        // resolve the (brand, member) from the receiver's GeneratorPrototype
        // provenance and invoke the stored closure with `thisArg → this`, so its
        // Slice-1 brand-check fires on the bad `this`. Standalone-gated.
        const genProtoResult = tryEmitGeneratorProtoReflectiveCall(ctx, fctx, expr, recv, isCall);
        if (genProtoResult !== undefined) return genProtoResult;
      }

      // Sub-fix 3 (#1596): Function.prototype.{apply,call}.call(fn, ...) reshape.
      // Rewrite `Function.prototype.apply.call(fn, thisArg, argsArr)` to
      // `fn.apply(thisArg, argsArr)` (and analogous for .call.call) so the
      // existing Case 0 / Case 1 handlers fire. Only the outer `.call` form is
      // matched — `Function.prototype.apply.apply(fn, [thisArg, argsArr])` is
      // rare and would need a packed-args reshape.
      if (
        isCall &&
        ts.isPropertyAccessExpression(innerExpr) &&
        (innerExpr.name.text === "apply" || innerExpr.name.text === "call") &&
        ts.isPropertyAccessExpression(innerExpr.expression) &&
        innerExpr.expression.name.text === "prototype" &&
        ts.isIdentifier(innerExpr.expression.expression) &&
        innerExpr.expression.expression.text === "Function" &&
        expr.arguments.length >= 1
      ) {
        const innerMethod = innerExpr.name.text; // "apply" or "call"
        const fnExpr = expr.arguments[0]!;
        const reshapedArgs = expr.arguments.slice(1);
        const reshapedProp = ts.factory.createPropertyAccessExpression(
          fnExpr as ts.LeftHandSideExpression,
          innerMethod,
        );
        ts.setTextRange(reshapedProp, propAccess);
        const reshapedCall = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
        ts.setTextRange(reshapedCall, expr);
        (reshapedCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, reshapedCall as ts.CallExpression);
      }

      // (#2069) `.call`/`.apply` on a callee declared with an explicit
      // TypeScript `this` parameter (`function f(this: T, …)`). Such a function
      // has a leading `externref` `this` slot in its Wasm signature, so the
      // legacy "evaluate thisArg, drop it" lowering passed `undefined` for
      // `this` AND shifted every user argument into the wrong slot. Rewrite to a
      // direct call that supplies the thisArg as the first positional argument —
      // it lands in param 0 (the `this` slot, boxed to externref by the regular
      // arg coercion) and the remaining args fill the declared params in order.
      // Only fires when the thisArg can be threaded soundly: a named callee with
      // a static this-param, and (for `.apply`) a statically-flattenable args
      // array. Anything else falls through to the legacy paths below.
      if (getExplicitThisParam(ctx, innerExpr) !== undefined && expr.arguments.length > 0) {
        const thisArg = expr.arguments[0]!;
        let directArgs: ts.Expression[] | undefined;
        if (isCall) {
          directArgs = [thisArg, ...expr.arguments.slice(1)];
        } else if (expr.arguments.length === 1) {
          // .apply(thisArg) — no args array
          directArgs = [thisArg];
        } else {
          const argsExpr = expr.arguments[1]!;
          if (ts.isArrayLiteralExpression(argsExpr)) {
            const flattened = flattenStaticArrayElements(argsExpr);
            if (flattened !== undefined) directArgs = [thisArg, ...flattened];
          }
        }
        if (directArgs !== undefined) {
          const directCall = ts.factory.createCallExpression(
            innerExpr as ts.LeftHandSideExpression,
            undefined,
            directArgs,
          );
          ts.setTextRange(directCall, expr);
          (directCall as { parent?: ts.Node }).parent = expr.parent;
          return compileCallExpression(ctx, fctx, directCall as ts.CallExpression);
        }
      }

      // Case 0: (function(){}).call/apply(...) and (() => {}).call/apply(...).
      // A compiled function is a WasmGC funcref/struct, not a JS Function, so a
      // host-side `.apply`/`.call` lookup fails ("apply is not a function").
      // Rewrite statically to a direct invocation of the function expression,
      // dropping thisArg (standalone functions ignore `this`). This reuses the
      // IIFE-inlining path, which also binds `arguments` correctly (#1596).
      {
        let fnExpr: ts.Expression = innerExpr;
        while (ts.isParenthesizedExpression(fnExpr)) fnExpr = fnExpr.expression;
        const isFnLiteral =
          (ts.isFunctionExpression(fnExpr) && fnExpr.asteriskToken === undefined) || ts.isArrowFunction(fnExpr);
        if (isFnLiteral) {
          let directArgs: readonly ts.Expression[] | undefined;
          if (isCall) {
            // fn.call(thisArg, a, b, ...) → fn(a, b, ...)
            directArgs = expr.arguments.slice(1);
          } else if (expr.arguments.length < 2) {
            // fn.apply(thisArg) / fn.apply() → fn()
            directArgs = [];
          } else {
            // fn.apply(thisArg, [a, b, ...]) → fn(a, b, ...). Statically flatten
            // the args-array literal into positional call arguments so the
            // IIFE-inlining path sees a fixed argument count (it binds
            // `arguments` from the literal arg list and does not expand spreads
            // itself). A spread of a nested array literal (`[...[3,4,5]]`, the
            // common test262 shape) is flattened recursively. Anything we
            // cannot statically flatten (dynamic spread source, elided holes)
            // is left to the generic path.
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const flattened = flattenStaticArrayElements(argsExpr);
              if (flattened !== undefined) directArgs = flattened;
            }
          }
          if (directArgs !== undefined) {
            // Evaluate the receiver-position thisArg for side effects (spec:
            // arguments are evaluated even though standalone functions ignore
            // `this`). For .call/.apply the thisArg is expr.arguments[0].
            if (expr.arguments.length > 0) {
              const thisType = compileExpression(ctx, fctx, expr.arguments[0]!);
              if (thisType !== null) fctx.body.push({ op: "drop" });
            }
            const directCall = ts.factory.createCallExpression(
              fnExpr as ts.LeftHandSideExpression,
              undefined,
              directArgs,
            );
            ts.setTextRange(directCall, expr);
            (directCall as any).parent = expr.parent;
            return compileCallExpression(ctx, fctx, directCall as ts.CallExpression);
          }
        }
      }

      // Case 1: identifier.call(thisArg, args...) — standalone function
      if (ts.isIdentifier(innerExpr)) {
        const funcName = innerExpr.text;
        let closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        if (!closureInfo && funcIdx === undefined) {
          closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
        }

        // (#2193 PR-B) `m.call(thisArg, …args)` where `m` is a `$NativeProto`
        // member closure (e.g. `Array.prototype.slice`). Its FIRST user param is
        // the receiver (`this`), NOT an ordinary arg — so unlike a plain
        // standalone function (handled below, which DROPS thisArg), the thisArg
        // must be threaded into param 1. Rewrite `m.call(t, a, b)` to the direct
        // closure call `m(t, a, b)` so `compileClosureCall` lands t→this, a→arg1,
        // b→arg2. `.apply(t, [a,b])` with a statically-flattenable array literal
        // reshapes the same way. Anything dynamic falls through to the legacy
        // drop-thisArg path (no worse than before).
        if (
          closureInfo &&
          ctx.nativeProtoReceiverClosureStructTypes?.has(closureInfo.structTypeIdx) &&
          expr.arguments.length > 0
        ) {
          let directArgs: readonly ts.Expression[] | undefined;
          if (isCall) {
            directArgs = expr.arguments; // [thisArg, ...args] → (this, ...args)
          } else if (expr.arguments.length === 1) {
            directArgs = [expr.arguments[0]!]; // .apply(thisArg) → (this)
          } else {
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const flattened = flattenStaticArrayElements(argsExpr);
              if (flattened !== undefined) directArgs = [expr.arguments[0]!, ...flattened];
            }
          }
          if (directArgs !== undefined) {
            const syntheticCall = ts.factory.createCallExpression(
              innerExpr,
              undefined,
              directArgs as unknown as readonly ts.Expression[],
            );
            (syntheticCall as { parent?: ts.Node }).parent = expr.parent;
            return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
          }
        }

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first argument) if present
          if (expr.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (thisType) {
              fctx.body.push({ op: "drop" });
            }
          }

          if (isCall) {
            // .call(thisArg, arg1, arg2, ...) — remaining args are positional
            const remainingArgs = expr.arguments.slice(1);

            if (closureInfo) {
              // Create a synthetic call expression with remaining args
              const syntheticCall = ts.factory.createCallExpression(
                innerExpr,
                undefined,
                remainingArgs as unknown as readonly ts.Expression[],
              );
              // Copy source file info for error reporting
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
            }

            // Check for rest parameters on the callee
            const callRestInfo = ctx.funcRestParams.get(funcName);

            if (callRestInfo) {
              // Calling a rest-param function via .call(): pack trailing args into a GC array
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              // Compile non-rest arguments
              for (let i = 0; i < callRestInfo.restIndex; i++) {
                if (i < remainingArgs.length) {
                  compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
                } else {
                  pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
                }
              }
              // Pack remaining arguments into a vec struct (array + length)
              const restArgCount = Math.max(0, remainingArgs.length - callRestInfo.restIndex);
              fctx.body.push({ op: "i32.const", value: restArgCount });
              for (let i = callRestInfo.restIndex; i < remainingArgs.length; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, callRestInfo.elemType);
              }
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: callRestInfo.arrayTypeIdx,
                length: restArgCount,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: callRestInfo.vecTypeIdx,
              });
            } else {
              // Regular function call
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < remainingArgs.length; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
              }

              // Supply defaults for missing optional params
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                const numProvided = remainingArgs.length;
                for (const opt of optInfo) {
                  if (opt.index >= numProvided) {
                    pushParamSentinel(fctx, opt.type, ctx, opt);
                  }
                }
              }

              // Pad any remaining missing arguments with defaults
              if (paramTypes) {
                const providedCount = Math.min(remainingArgs.length, paramTypes.length);
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.filter((o) => o.index >= remainingArgs.length).length
                  : 0;
                const totalPushed = providedCount + optFilledCount;
                for (let i = totalPushed; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }

            maybeSetArgcForKnownCall(
              ctx,
              fctx,
              funcName,
              remainingArgs.length,
              getFuncParamTypes(ctx, funcIdx!)?.length ?? remainingArgs.length,
            );
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

            // Use actual Wasm return type — TS checker reports `any` for .call()/.apply()
            // which resolves to externref, but the actual function may return f64/i32/ref.
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
          // .apply(thisArg, argsArray) — spread array literal elements as positional args
          if (!isCall && expr.arguments.length >= 2) {
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const elements = argsExpr.elements;
              if (closureInfo) {
                const syntheticCall = ts.factory.createCallExpression(
                  innerExpr,
                  undefined,
                  elements as unknown as readonly ts.Expression[],
                );
                (syntheticCall as any).parent = expr.parent;
                return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
              }
              const applyRestInfo = ctx.funcRestParams.get(funcName);
              if (applyRestInfo) {
                // Rest-param function via .apply(): pack trailing elements into vec
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < applyRestInfo.restIndex; i++) {
                  if (i < elements.length) {
                    compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                  } else {
                    pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
                  }
                }
                const restArgCount = Math.max(0, elements.length - applyRestInfo.restIndex);
                fctx.body.push({ op: "i32.const", value: restArgCount });
                for (let i = applyRestInfo.restIndex; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, applyRestInfo.elemType);
                }
                fctx.body.push({
                  op: "array.new_fixed",
                  typeIdx: applyRestInfo.arrayTypeIdx,
                  length: restArgCount,
                });
                fctx.body.push({
                  op: "struct.new",
                  typeIdx: applyRestInfo.vecTypeIdx,
                });
              } else {
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                }
                const optInfo = ctx.funcOptionalParams.get(funcName);
                if (optInfo) {
                  for (const opt of optInfo) {
                    if (opt.index >= elements.length) pushParamSentinel(fctx, opt.type, ctx, opt);
                  }
                }
                // Pad any remaining missing arguments with defaults
                if (paramTypes) {
                  const providedCount = Math.min(elements.length, paramTypes.length);
                  const optFilledCount = ctx.funcOptionalParams.get(funcName)
                    ? ctx.funcOptionalParams.get(funcName)!.filter((o) => o.index >= elements.length).length
                    : 0;
                  const totalPushed = providedCount + optFilledCount;
                  for (let i = totalPushed; i < paramTypes.length; i++) {
                    pushDefaultValue(fctx, paramTypes[i]!, ctx);
                  }
                }
              }
              const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
              maybeSetArgcForKnownCall(
                ctx,
                fctx,
                funcName,
                elements.length,
                getFuncParamTypes(ctx, finalFuncIdx)?.length ?? elements.length,
              );
              fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
              // Use actual Wasm return type for .apply()
              if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
            }
          }
          // .apply() with no args array — call with no args
          if (!isCall) {
            if (closureInfo) {
              const syntheticCall = ts.factory.createCallExpression(innerExpr, undefined, []);
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
            }
            const applyNoArgsRestInfo = ctx.funcRestParams.get(funcName);
            if (applyNoArgsRestInfo) {
              // Rest-param function with no args: push empty vec
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < applyNoArgsRestInfo.restIndex; i++) {
                pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
              }
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: applyNoArgsRestInfo.arrayTypeIdx,
                length: 0,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: applyNoArgsRestInfo.vecTypeIdx,
              });
            } else {
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                for (const opt of optInfo) pushParamSentinel(fctx, opt.type, ctx, opt);
              }
              // Pad any remaining missing arguments with defaults
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              if (paramTypes) {
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.length
                  : 0;
                for (let i = optFilledCount; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            maybeSetArgcForKnownCall(ctx, fctx, funcName, 0, getFuncParamTypes(ctx, finalFuncIdx)?.length ?? 0);
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
            // Use actual Wasm return type for .apply() with no args
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
        }
      }

      // Case 2: obj.method.call/apply — method call with different receiver
      if (ts.isPropertyAccessExpression(innerExpr)) {
        const methodName = innerExpr.name.text;
        const objExpr = innerExpr.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        // Case 2a: Type.prototype.method.call(receiver, ...args)
        // Use __proto_method_call host import to correctly dispatch through
        // the Type's prototype, even when receiver doesn't inherit from Type.
        // e.g. Array.prototype.every.call(fnObj, cb) where fnObj is a Function.
        if (
          ts.isPropertyAccessExpression(objExpr) &&
          objExpr.name.text === "prototype" &&
          ts.isIdentifier(objExpr.expression) &&
          isCall &&
          expr.arguments.length >= 1
        ) {
          const typeName = objExpr.expression.text;

          // (#2501) Object.prototype.toString.call(v) → native `[object X]` tag
          // (§20.1.3.6 builtin-tag subset). The builtin tag is statically known
          // from the receiver's TS type in nearly every test262 case, so emit the
          // string constant directly — this fixes host mode (Array/Function/Date
          // were mis-tagged `[object Object]` because the Wasm vec/closure receiver
          // is opaque to the host's `Object.prototype.toString`) AND standalone
          // (the whole `.call(...)` form was a hard compile error there). Routes
          // BOTH modes through the same compile-away classifier — no host import.
          // Symbol.toStringTag (§20.1.3.6 step 15) is deferred to phase-2 (it needs
          // dynamic @@toStringTag property lookup → the dynamic-property epic).
          if (typeName === "Object" && methodName === "toString") {
            const tag = resolveObjectToStringTag(ctx, expr.arguments[0]);
            if (tag !== undefined) {
              const tagStr = `[object ${tag}]`;
              addStringConstantGlobal(ctx, tagStr);
              // Dual-mode string-constant push (externref in both host and
              // nativeStrings/standalone — the host `global.get` path only works
              // in non-nativeStrings mode, so use the shared helper).
              for (const instr of stringConstantExternrefInstrs(ctx, tagStr)) fctx.body.push(instr);
              return { kind: "externref" };
            }
          }

          const isBuiltinRegExpPrototype = typeName === "RegExp" && isGlobalRegExpIdentifier(ctx, objExpr.expression);
          if (ctx.standalone && isBuiltinRegExpPrototype) {
            if (methodName === "test" || methodName === "exec") {
              const receiverArg = expr.arguments[0]!;
              const syntheticProp = ts.factory.createPropertyAccessExpression(receiverArg, methodName);
              ts.setTextRange(syntheticProp, innerExpr);
              const syntheticCall = ts.factory.createCallExpression(
                syntheticProp,
                undefined,
                Array.from(expr.arguments).slice(1),
              );
              ts.setTextRange(syntheticCall, expr);
              (syntheticCall as any).parent = expr.parent;
              const standaloneRegExpMethod =
                methodName === "exec"
                  ? tryCompileStandaloneRegExpExec(ctx, fctx, syntheticCall, syntheticProp)
                  : tryCompileStandaloneRegExpTest(ctx, fctx, syntheticCall, syntheticProp);
              if (standaloneRegExpMethod !== undefined) return standaloneRegExpMethod;
            }
            reportError(
              ctx,
              expr,
              `Codegen error: standalone RegExp literal-substring backend does not support ` +
                `RegExp.prototype.${methodName}.call(...) (#682/#1474). Use RegExp.prototype.test/exec ` +
                `with a plain static pattern and no flags, or recompile without --target standalone.`,
            );
            return null;
          }
          // (#1888 Slice 3) Standalone borrowed-method dispatch
          // `Type.prototype.<m>.call(recv, …args)` (ES §7.3.14 Call). The host
          // `__proto_method_call` is refused under --target standalone (no JS
          // runtime). Per the "compile away" principle, typeName + methodName
          // are compile-time constants here, so we dispatch STATICALLY by
          // synthesising `recv.<m>(…args)` and routing it through the native
          // member-call path — no new runtime helper, no funcIdx shift.
          //   - String: route to compileNativeStringMethodCall, which coerces
          //     the borrowed receiver to a native string ($NativeString brand)
          //     and emits the __str_* fast path. The covered method set is the
          //     ones whose native helper round-trips correctly (see below).
          //   - Object.hasOwnProperty/propertyIsEnumerable: synthesise the bare
          //     call, which already has a clean native standalone path
          //     (compilePropertyIntrospection → __hasOwnProperty /
          //     __propertyIsEnumerable) while preserving closed class-struct
          //     field/method semantics.
          //   - Object.isPrototypeOf: route directly to the native open-object
          //     prototype-chain helper. Array/Number/Boolean/Function have no
          //     clean native borrowed path yet → refuse-loud below (Array brand
          //     arm rides on #2177). Never a silent-wrong answer.
          if (ctx.standalone && expr.arguments.length >= 1 && !isBuiltinRegExpPrototype) {
            // Native String methods whose __str_* helper + return marshaling
            // round-trip correctly standalone (verified end-to-end). Methods
            // outside this set refuse-loud rather than risk a wrong result.
            const STANDALONE_STR_PROTO_METHODS = new Set<string>([
              "charAt",
              "charCodeAt",
              "codePointAt",
              "indexOf",
              "lastIndexOf",
              "includes",
              "startsWith",
              "endsWith",
              "toUpperCase",
              "toLowerCase",
              "trim",
              "trimStart",
              "trimEnd",
              "concat",
              "repeat",
              "padStart",
              "padEnd",
              "substring",
              "slice",
              "at",
            ]);
            const synthesizeBorrowedCall = (): { prop: ts.PropertyAccessExpression; call: ts.CallExpression } => {
              const receiverArg = expr.arguments[0]!;
              const restArgs = Array.from(expr.arguments).slice(1);
              const sProp = ts.factory.createPropertyAccessExpression(receiverArg, methodName);
              ts.setTextRange(sProp, innerExpr);
              (sProp as unknown as { parent: ts.Node }).parent = expr;
              const sCall = ts.factory.createCallExpression(sProp, undefined, restArgs);
              ts.setTextRange(sCall, expr);
              (sCall as unknown as { parent: ts.Node }).parent = expr.parent;
              return { prop: sProp, call: sCall };
            };

            if (typeName === "String" && STANDALONE_STR_PROTO_METHODS.has(methodName)) {
              const { prop, call } = synthesizeBorrowedCall();
              // (#3254) The borrowed `this` is the FIRST arg. §22.1.3 requires
              // `RequireObjectCoercible(this)` then `ToString(this)` on it — a
              // null/undefined receiver must throw TypeError, and a
              // boolean/number/object receiver must ToString (the default
              // `emitReceiver` only handled a string/object-struct receiver, so
              // `.call(false)` yielded "[object Object]" and `.call(undefined)`
              // silently coerced). Feed a ROC+ToString receiver override so the
              // fix covers every method in STANDALONE_STR_PROTO_METHODS.
              const borrowedReceiver = expr.arguments[0]!;
              const strResult = compileNativeStringMethodCall(ctx, fctx, call, prop, methodName, () =>
                emitBorrowedStringReceiverToString(ctx, fctx, borrowedReceiver, methodName),
              );
              if (strResult !== null) return strResult;
              // Native string path declined (unexpected shape) — fall through
              // to the refuse-loud below rather than the host import.
            } else if (
              typeName === "Object" &&
              (methodName === "hasOwnProperty" || methodName === "propertyIsEnumerable")
            ) {
              // Object.prototype.{hasOwnProperty,propertyIsEnumerable}.call(o, k)
              // → o.<method>(k), which routes through compilePropertyIntrospection.
              const { prop, call } = synthesizeBorrowedCall();
              const introspectionResult = compilePropertyIntrospection(ctx, fctx, prop, call);
              if (introspectionResult !== null) return introspectionResult;
            } else if (typeName === "Object" && methodName === "isPrototypeOf") {
              const protoIdx = ensureLateImport(
                ctx,
                "__isPrototypeOf",
                [{ kind: "externref" }, { kind: "externref" }],
                [{ kind: "i32" }],
              );
              flushLateImportShifts(ctx, fctx);
              if (protoIdx !== undefined) {
                const receiverType = compileExpression(ctx, fctx, expr.arguments[0]!);
                if (receiverType && receiverType.kind !== "externref") {
                  coerceType(ctx, fctx, receiverType, { kind: "externref" });
                }
                if (expr.arguments[1]) {
                  const candidateType = compileExpression(ctx, fctx, expr.arguments[1]!);
                  if (candidateType && candidateType.kind !== "externref") {
                    coerceType(ctx, fctx, candidateType, { kind: "externref" });
                  }
                } else {
                  fctx.body.push({ op: "ref.null.extern" });
                }
                fctx.body.push({ op: "call", funcIdx: protoIdx });
                return { kind: "i32" };
              }
            }

            // Unsupported (typeName, methodName) under standalone: refuse-loud,
            // never leak the host import or return a silent-wrong value.
            const cite =
              typeName === "Array"
                ? "the Array brand arm rides on #2177 ($Vec element retrieval)"
                : typeName === "Object"
                  ? "only Object.prototype hasOwnProperty/propertyIsEnumerable/isPrototypeOf borrowed calls are wired (valueOf is a follow-on)"
                  : "this prototype's borrowed-method brand arm is not yet native";
            reportError(
              ctx,
              expr,
              `Codegen error: ${typeName}.prototype.${methodName}.call(...) is not yet ` +
                `supported in --target standalone (#1888 Slice 3/4) — ${cite}. ` +
                `Recompile without --target standalone, or call the method directly on a typed receiver.`,
            );
            return null;
          }
          if (
            (typeName === "String" ||
              typeName === "Number" ||
              typeName === "Array" ||
              typeName === "Boolean" ||
              typeName === "Object" ||
              typeName === "Function" ||
              isBuiltinRegExpPrototype) &&
            expr.arguments.length >= 1
          ) {
            const protoCallIdx = ensureLateImport(
              ctx,
              "__proto_method_call",
              [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
            const arrPushIdx = ensureLateImport(
              ctx,
              "__js_array_push",
              [{ kind: "externref" }, { kind: "externref" }],
              [],
            );
            flushLateImportShifts(ctx, fctx);

            if (protoCallIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
              // Push typeName string
              addStringConstantGlobal(ctx, typeName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, typeName));

              // Push methodName string
              addStringConstantGlobal(ctx, methodName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));

              // Compile receiver (first argument to .call).
              // (#1442) When the receiver's static TS type is `boolean`, the
              // i32 → externref auto-coercion uses `__box_number` and arrives
              // host-side as `Number(0)` / `Number(1)`. That makes
              // `String.prototype.trim.call(true)` return `"1"` instead of
              // `"true"`. Box booleans through `__box_boolean` so the host
              // gets a real `Boolean` wrapper, then String() / ToString
              // produces the spec-correct `"true"` / `"false"`.
              const receiverArg = expr.arguments[0]!;
              const receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
              if (isBooleanType(receiverTsType)) {
                const recvWasm = compileExpression(ctx, fctx, receiverArg);
                if (recvWasm && recvWasm.kind === "i32") {
                  addUnionImports(ctx);
                  flushLateImportShifts(ctx, fctx);
                  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
                  if (boxBoolIdx !== undefined) {
                    fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
                  } else {
                    fctx.body.push({ op: "extern.convert_any" });
                  }
                } else if (recvWasm && recvWasm.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (recvWasm === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else {
                const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
                if (recvType && recvType.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                }
                if (recvType === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
              }

              // Build args array from remaining arguments
              const remainingArgs = Array.from(expr.arguments).slice(1);
              const argsLocal = allocLocal(fctx, `__pmc_args_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "call", funcIdx: arrNewIdx });
              fctx.body.push({ op: "local.set", index: argsLocal });
              for (const arg of remainingArgs) {
                fctx.body.push({ op: "local.get", index: argsLocal });
                const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
                if (argType && argType.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                }
                if (argType === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
                fctx.body.push({ op: "call", funcIdx: arrPushIdx });
              }
              fctx.body.push({ op: "local.get", index: argsLocal });

              // Call __proto_method_call(typeName, methodName, receiver, args)
              fctx.body.push({ op: "call", funcIdx: protoCallIdx });
              return { kind: "externref" };
            }
          }
        }

        // Resolve class name from the object's type
        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }

        // Also try struct name
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && expr.arguments.length > 0) {
            // First argument is the thisArg (receiver).
            // For class methods called via .call()/.apply() the receiver might
            // not actually be an instance of the class (e.g. `method.call({})`).
            // Without a brand check, the downstream ref.cast traps with
            // uncatchable "illegal cast". Instead, emit a ref.test guard and
            // throw a catchable TypeError on mismatch — matches the ES
            // private-field brand-check semantics (#826, class/elements
            // illegal_cast bucket).
            const selfParamTypes = getFuncParamTypes(ctx, funcIdx);
            const selfParamType = selfParamTypes?.[0];
            const thisArgType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (
              thisArgType &&
              selfParamType &&
              (selfParamType.kind === "ref" || selfParamType.kind === "ref_null") &&
              (thisArgType.kind === "externref" ||
                thisArgType.kind === "anyref" ||
                thisArgType.kind === "eqref" ||
                ((thisArgType.kind === "ref" || thisArgType.kind === "ref_null") &&
                  (thisArgType as { typeIdx: number }).typeIdx !== (selfParamType as { typeIdx: number }).typeIdx))
            ) {
              const selfTypeIdx = (selfParamType as { typeIdx: number }).typeIdx;
              if (thisArgType.kind === "externref") {
                fctx.body.push({ op: "any.convert_extern" });
              }
              const thisTmpType: ValType = { kind: "anyref" };
              const thisTmp = allocTempLocal(fctx, thisTmpType);
              fctx.body.push({ op: "local.tee", index: thisTmp });
              fctx.body.push({ op: "ref.test", typeIdx: selfTypeIdx });
              fctx.body.push({ op: "i32.eqz" });
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: typeErrorThrowInstrs(ctx, expr),
              });
              fctx.body.push({ op: "local.get", index: thisTmp });
              fctx.body.push({ op: "ref.cast", typeIdx: selfTypeIdx });
              releaseTempLocal(fctx, thisTmp);
            }

            if (isCall) {
              // .call(thisArg, arg1, arg2, ...) — remaining args are positional
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0);
              // .call() args start at index 1 (index 0 is thisArg)
              const callParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length - 1;
              for (let i = 1; i < expr.arguments.length; i++) {
                if (i - 1 < callParamCount) {
                  compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            } else if (expr.arguments.length >= 2 && ts.isArrayLiteralExpression(expr.arguments[1]!)) {
              // .apply(thisArg, [arg1, arg2, ...]) — spread array literal
              const elements = (expr.arguments[1] as ts.ArrayLiteralExpression).elements;
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0)
              const applyParamCount = paramTypes ? paramTypes.length - 1 : elements.length;
              for (let i = 0; i < elements.length; i++) {
                if (i < applyParamCount) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i + 1]); // param 0 = self
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, elements[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = elements.length + 1; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }

            // Re-lookup funcIdx: argument compilation may trigger addUnionImports
            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            // Use actual Wasm return type for .call()/.apply() on class methods
            if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalCallIdx) ?? VOID_RESULT;
          }
        }
      }
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      (propAccess.name.text === "log" ||
        propAccess.name.text === "warn" ||
        propAccess.name.text === "error" ||
        propAccess.name.text === "info" ||
        propAccess.name.text === "debug")
    ) {
      return compileConsoleCall(ctx, fctx, expr, propAccess.name.text);
    }

    // (#1490) Non-WASI Node.js host mode: process.exit(code) and process.cwd().
    // process.exit routes to the __process_exit host import (calls real process.exit
    // when running under Node). process.cwd() returns a string via __get_process_cwd.
    if (!ctx.wasi && ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "process") {
      const isShadowed = fctx.localMap.has("process") || (fctx.boxedCaptures?.has("process") ?? false);
      if (!isShadowed) {
        const procMethod = propAccess.name.text;
        if (procMethod === "exit") {
          const idx = ensureLateImport(ctx, "__process_exit", [{ kind: "f64" }], []);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            if (expr.arguments.length >= 1) {
              compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
            } else {
              fctx.body.push({ op: "f64.const", value: 0 });
            }
            fctx.body.push({ op: "call", funcIdx: idx });
          }
          return VOID_RESULT;
        }
        if (procMethod === "cwd") {
          const idx = ensureLateImport(ctx, "__get_process_cwd", [], [{ kind: "externref" }]);
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

    // (#1503) Web Crypto host imports: crypto.randomUUID() / crypto.getRandomValues(buf).
    // Available wherever the host exposes a `crypto` global (browsers + Node 19+).
    // In WASI mode there is no JS host, so the imports are still added but resolve
    // to a throw at runtime (no silent fallback to Math.random — that would be a
    // security trap, see issue #1503). Shadow-aware.
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "crypto") {
      const isShadowed = fctx.localMap.has("crypto") || (fctx.boxedCaptures?.has("crypto") ?? false);
      if (!isShadowed) {
        const cryptoMethod = propAccess.name.text;
        if (cryptoMethod === "randomUUID") {
          const idx = ensureLateImport(ctx, "__crypto_random_uuid", [], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
        if (cryptoMethod === "getRandomValues") {
          // Compile the typed-array argument. Uint8Array compiles to a vec
          // struct typed `ref_null $vec_f64`. We need to pass the RAW
          // extern-wrapped vec to the host (so the host can call back
          // `__vec_set_byte(vec, i, byte)` and mutate the same struct).
          // The generic coerceType path would wrap the vec with
          // `__make_iterable` (so JS sees a real iterable) — but that
          // wrapping strips the vec identity, leaving the host unable to
          // ref.test against the vec type. Emit `extern.convert_any`
          // directly to bypass `__make_iterable`.
          const idx = ensureLateImport(
            ctx,
            "__crypto_get_random_values",
            [{ kind: "externref" }],
            [{ kind: "externref" }],
          );
          if (expr.arguments.length >= 1) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (argType?.kind === "ref" || argType?.kind === "ref_null") {
              fctx.body.push({ op: "extern.convert_any" });
            } else if (argType && argType.kind !== "externref") {
              // Fall back to the standard coerce for non-ref result types.
              coerceType(ctx, fctx, argType, { kind: "externref" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
          } else {
            // Fallback: pop the arg and push null so the stack stays balanced.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
      }
    }

    // WASI mode: process.exit(code) -> proc_exit(code)
    if (
      ctx.wasi &&
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "process" &&
      propAccess.name.text === "exit" &&
      ctx.wasiProcExitIdx >= 0
    ) {
      // #2735 — when the fd0 stdin reactor is active, drop its subscription
      // before `proc_exit` so the intent (terminate now) is explicit and the
      // run loop cannot out-live the exit. `proc_exit` already tears the whole
      // instance down, so this is belt-and-suspenders; it is gated on the
      // reactor being active so a `process.exit`-only program (no stdin) is
      // NOT forced to wire the reactor.
      if (isStdinReactorActive(ctx)) {
        emitStdinStop(ctx, fctx);
      }
      if (expr.arguments.length >= 1) {
        // #1801: `proc_exit` takes an i32 exit code. Compiling the argument
        // with expected type `{ kind: "i32" }` already delivers an i32 on the
        // stack (a numeric literal lowers directly to `i32.const N`, and
        // f64-valued expressions are truncated by coerceType). The previous
        // code *also* pushed `i32.trunc_sat_f64_s`, which expects an f64
        // operand — so the i32 already on the stack made the module fail
        // `WebAssembly.validate()` ("i32.trunc_sat_f64_s expected type f64,
        // found ... i32"). The expected-type compile and the truncation are
        // mutually exclusive; keep the former, drop the latter.
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
      } else {
        fctx.body.push({ op: "i32.const", value: 0 });
      }
      fctx.body.push({ op: "call", funcIdx: ctx.wasiProcExitIdx });
      return VOID_RESULT;
    }

    // (#742 slice 2) Built-in static-method dispatch — Math / BigInt / Number /
    // Array / String / Object namespace statics. Extracted verbatim to
    // compileBuiltinStaticCall; an `undefined` result means the callee is not a
    // builtin-static case, so dispatch continues below (Symbol / Reflect / …).
    {
      const __bsResult = compileBuiltinStaticCall(ctx, fctx, expr, propAccess);
      if (__bsResult !== undefined) return __bsResult;
    }

    // Handle Symbol.for(key) and Symbol.keyFor(sym) — global symbol registry (#965)
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Symbol") {
      const symMethod = propAccess.name.text;
      if (symMethod === "for" && expr.arguments.length >= 1) {
        // §20.4.2.2 step 1: stringKey = ? ToString(key). A Symbol key makes
        // ToString throw TypeError before the registry lookup runs.
        const keyTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        if (isSymbolType(keyTsType)) {
          emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a string");
          return { kind: "externref" };
        }
        // (#2163) No-JS-host mode: use the Wasm-native registry. The key lowers
        // to a `ref $AnyString`; `__symbol_for_native` does the content-equality
        // lookup / insert and returns the i32 symbol id (also recording the key
        // as the registered symbol's description). Zero host imports.
        if (noJsHost(ctx)) {
          const { forIdx } = ensureSymbolRegistry(ctx);
          const keyType = compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "ref",
            typeIdx: ctx.anyStrTypeIdx,
          });
          if (keyType && (keyType.kind !== "ref" || keyType.typeIdx !== ctx.anyStrTypeIdx)) {
            coerceType(ctx, fctx, keyType, { kind: "ref", typeIdx: ctx.anyStrTypeIdx });
          }
          fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "call", funcIdx: forIdx });
          return { kind: "i32" };
        }
        const keyType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (keyType && keyType.kind !== "externref") coerceType(ctx, fctx, keyType, { kind: "externref" });
        const funcIdx = ensureLateImport(ctx, "__symbol_for", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (symMethod === "keyFor" && expr.arguments.length >= 1) {
        // (#2163) No-JS-host mode: the symbol is an i32 id; the native registry
        // returns its registration key (`ref_null $AnyString`, i.e. a native
        // string or undefined for an unregistered symbol). Zero host imports.
        if (noJsHost(ctx)) {
          const { keyForIdx } = ensureSymbolRegistry(ctx);
          const symType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
          if (symType && symType.kind !== "i32") coerceType(ctx, fctx, symType, { kind: "i32" });
          fctx.body.push({ op: "call", funcIdx: keyForIdx });
          return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
        }
        const symType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (symType && symType.kind !== "externref") coerceType(ctx, fctx, symType, { kind: "externref" });
        const funcIdx = ensureLateImport(ctx, "__symbol_keyFor", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Handle ArrayBuffer.isView(arg) — checks if arg is a TypedArray/DataView (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "ArrayBuffer" &&
      propAccess.name.text === "isView" &&
      expr.arguments.length >= 1
    ) {
      // (#2594) Standalone/no-host: the host `__arraybuffer_isView` import does
      // not exist — emitting it leaks `env.*` and breaks the WHOLE module at
      // instantiate. §25.1.4.1 isView is `true` iff the arg has a
      // [[ViewedArrayBuffer]] slot (any TypedArray or DataView). Decide it
      // host-free.
      if (noJsHost(ctx)) {
        const arg0 = expr.arguments[0]!;
        const argTs = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(arg0));
        const argSym = argTs.getSymbol()?.name;
        const rawTs = ctx.checker.getTypeAtLocation(arg0);
        const isAnyOrUnknown = (rawTs.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
        const isView = argSym !== undefined && (TYPED_ARRAY_NAMES.has(argSym) || argSym === "DataView");
        // A non-view whose static type is resolvable: ArrayBuffer itself, a
        // primitive, null/undefined, a plain array, a class/object — all `false`.
        const isResolvableNonView =
          !isAnyOrUnknown && !isView && argSym !== "BigInt64Array" && argSym !== "BigUint64Array" && !rawTs.isUnion();
        if (isView || argSym === "BigInt64Array" || argSym === "BigUint64Array") {
          // Static `true`. Still evaluate the (possibly side-effecting) arg, drop it.
          const at = compileExpression(ctx, fctx, arg0);
          if (at !== null) fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
        if (isResolvableNonView) {
          const at = compileExpression(ctx, fctx, arg0);
          if (at !== null) fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 0 });
          return { kind: "i32" };
        }
        // Runtime fallback for `any`/union/unresolved receivers: ref.test the
        // registered vec carriers (TypedArrays lower to a `$Vec`) and the
        // DataView window struct. NOTE: standalone shares the `$Vec` carrier
        // between `number[]` and TypedArrays, so a plain array is
        // indistinguishable here and reads as a view — an accepted imprecision
        // for the rare `any` arg; the win is NOT leaking the host import (which
        // breaks the whole module). Most isView call sites are statically typed.
        const at = compileExpression(ctx, fctx, arg0, { kind: "externref" });
        if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
        const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
        const vecTypeIdxs = Array.from(new Set(ctx.vecTypeMap.values()));
        const anyTmp = allocLocal(fctx, `__isview_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "local.set", index: anyTmp });
        let emitted = false;
        for (const vi of vecTypeIdxs) {
          fctx.body.push({ op: "local.get", index: anyTmp });
          fctx.body.push({ op: "ref.test", typeIdx: vi });
          if (emitted) fctx.body.push({ op: "i32.or" });
          emitted = true;
        }
        fctx.body.push({ op: "local.get", index: anyTmp });
        fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
        if (emitted) fctx.body.push({ op: "i32.or" });
        return { kind: "i32" };
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      const funcIdx = ensureLateImport(ctx, "__arraybuffer_isView", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // ── Reflect API — host dispatch via __reflect_* imports (#1466) ──────
    // Replaces the previous compile-time rewrites that bypassed the Proxy MOP.
    // Each method routes through a thin host wrapper around Reflect.X so
    // Proxy targets see their traps fire and boolean returns are preserved.
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Reflect") {
      const reflectMethod = propAccess.name.text;

      // Helper — compile each argument as externref, padding missing positions with ref.null.extern.
      const emitReflectArgs = (count: number): void => {
        const externRef: ValType = { kind: "externref" };
        for (let i = 0; i < count; i++) {
          const arg = expr.arguments[i];
          if (arg !== undefined) {
            const argTy = compileExpression(ctx, fctx, arg, externRef);
            if (argTy && argTy.kind !== "externref") {
              coerceType(ctx, fctx, argTy, externRef);
            } else if (argTy === null) {
              // Expression had no value — push null externref to keep arity.
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
      };

      // Helper — drop N pushed args and return a fallback constant when the import is unavailable.
      // (#2046 cleanup) `i32-false` is the safer default for boolean-returning
      // Reflect methods on a registration failure (the module is already marked
      // failed by reportError; false is the less-wrong observable value).
      const fallbackReturn = (n: number, ret: "i32-true" | "i32-false" | "extern-null"): InnerResult => {
        for (let i = 0; i < n; i++) fctx.body.push({ op: "drop" });
        if (ret === "i32-true" || ret === "i32-false") {
          fctx.body.push({ op: "i32.const", value: ret === "i32-true" ? 1 : 0 });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      };

      const externRef: ValType = { kind: "externref" };
      const i32Ty: ValType = { kind: "i32" };

      // ── #1472 Phase C — Reflect.* under --target standalone ───────────────
      //
      // The host-dispatch path below registers an env::__reflect_* import for
      // every Reflect method. There is no JS host in standalone mode, so any
      // such import would leak into the binary and fail at instantiation with
      // an opaque "unknown import" linker error. Route the one method backed by
      // a native helper through it, and refuse the rest with a clear compile
      // error rather than emitting a half-working module.
      //
      // - Reflect.get/has/deleteProperty(target, key) → native keyed $Object
      //   helpers, which already perform the same own/prototype walk or delete
      //   operation used by dynamic property access.
      // - Reflect.set(target, key, value) → native __reflect_set, a boolean
      //   wrapper around the supported __extern_set data-write subset.
      // - Reflect.ownKeys(target) → native __object_keys (string own keys of
      //   the $Object hash-map, insertion order). The native runtime tracks
      //   only string keys; Symbol/non-enumerable keys are out of scope for the
      //   standalone object runtime (consistent approximation across #1472
      //   Phase B). __object_keys is in OBJECT_RUNTIME_HELPER_NAMES, so
      //   ensureLateImport auto-routes it to the in-module native func.
      // - Reflect.apply/construct require call/constructor machinery with no
      //   native analog in this slice. Descriptor/prototype/integrity methods
      //   stay refused until their native invariants are proven end-to-end.
      if (ctx.standalone) {
        if (reflectMethod === "get" && expr.arguments.length >= 2) {
          // (#2046 PR-A defect 1) The native __extern_get has no separate
          // receiver slot — an explicit receiver was previously evaluated and
          // SILENTLY DROPPED, so accessor getters (live since #1888 S5b) ran
          // with `this = target` instead of `receiver` (§28.1.5 → §10.1.8).
          // Until real receiver plumbing (PR-C, senior/deferred), refuse loudly
          // rather than mis-bind `this` — restores the #1888 fail-loud invariant.
          if (expr.arguments.length > 2) {
            reportError(
              ctx,
              expr,
              "Codegen error: Reflect.get with an explicit receiver argument is not yet supported " +
                "in --target standalone (#2046); the receiver would be silently dropped and accessor " +
                "getters would bind `this` to the target instead of the receiver.",
            );
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
          emitReflectArgs(2);
          const funcIdx = ensureLateImport(ctx, "__extern_get", [externRef, externRef], [externRef]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
          return fallbackReturn(2, "extern-null");
        }

        if (reflectMethod === "set" && expr.arguments.length >= 2) {
          // (#2046 PR-A defect 1) Same as Reflect.get: __reflect_set writes the
          // data-property subset on `target` itself and has no receiver slot, so
          // an explicit receiver was evaluated then dropped — writing to the
          // wrong object for accessor setters (§28.1.12 → §10.1.9). Refuse
          // loudly with an explicit receiver until PR-C lands.
          if (expr.arguments.length > 3) {
            reportError(
              ctx,
              expr,
              "Codegen error: Reflect.set with an explicit receiver argument is not yet supported " +
                "in --target standalone (#2046); the receiver would be silently dropped and accessor " +
                "setters would write to the target instead of the receiver.",
            );
            fctx.body.push({ op: "i32.const", value: 0 });
            return { kind: "i32" };
          }
          emitReflectArgs(3);
          const funcIdx = ensureLateImport(ctx, "__reflect_set", [externRef, externRef, externRef], [i32Ty]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "i32" };
          }
          return fallbackReturn(3, "i32-false");
        }

        if (reflectMethod === "has" && expr.arguments.length >= 2) {
          emitReflectArgs(2);
          const funcIdx = ensureLateImport(ctx, "__extern_has", [externRef, externRef], [i32Ty]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "i32" };
          }
          // (#2046 cleanup) i32-false: a registration failure should not report
          // a phantom `true` for `Reflect.has`.
          return fallbackReturn(2, "i32-false");
        }

        if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
          // (#2046 PR-A defect 3a) Reflect.deleteProperty(primitive, k) must
          // throw a TypeError (§28.1.4 — Reflect requires an Object target),
          // NOT return true. The shared __delete_property helper returns 1 for
          // non-$Object targets because sloppy `delete primitive[k]` is a no-op
          // SUCCESS — correct there, wrong for Reflect. So gate at the CALL SITE
          // (do NOT touch the shared helper): ref.test the target against
          // $Object; if it is not an open object, throw a catchable TypeError.
          const ort = ensureObjectRuntime(ctx);
          const targetLocal = allocTempLocal(fctx, externRef);
          // Evaluate the target once, save it for both the guard and the call.
          {
            const tArg = expr.arguments[0];
            if (tArg !== undefined) {
              const tTy = compileExpression(ctx, fctx, tArg, externRef);
              if (tTy && tTy.kind !== "externref") coerceType(ctx, fctx, tTy, externRef);
              else if (tTy === null) fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          fctx.body.push({ op: "local.set", index: targetLocal });
          // Pre-register the TypeError constructor + any late import the throw
          // needs BEFORE entering the `if`, so capturing the throw instrs by
          // splice below cannot interleave a late-import index shift into the
          // nested block (the registration happens against the flat body here).
          const throwInstrs: Instr[] = (() => {
            const before = fctx.body.length;
            emitThrowTypeError(ctx, fctx, "Reflect.deleteProperty called on non-object");
            return fctx.body.splice(before);
          })();
          // if !ref.test $Object(target) → throw TypeError
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "ref.test", typeIdx: ort.objectTypeIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: throwInstrs,
          });
          // target is an $Object — push [target, key] and delete.
          fctx.body.push({ op: "local.get", index: targetLocal });
          releaseTempLocal(fctx, targetLocal);
          {
            const kArg = expr.arguments[1];
            if (kArg !== undefined) {
              const kTy = compileExpression(ctx, fctx, kArg, externRef);
              if (kTy && kTy.kind !== "externref") coerceType(ctx, fctx, kTy, externRef);
              else if (kTy === null) fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          const funcIdx = ensureLateImport(ctx, "__delete_property", [externRef, externRef], [i32Ty]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "i32" };
          }
          return fallbackReturn(0, "i32-false");
        }

        if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
          emitReflectArgs(1);
          const funcIdx = ensureLateImport(ctx, "__object_keys", [externRef], [externRef]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
          return fallbackReturn(1, "extern-null");
        }

        if (reflectMethod === "getOwnPropertyDescriptor" && expr.arguments.length >= 2) {
          // (#2046 S5) Route to the native __getOwnPropertyDescriptor, the same
          // helper backing standalone Object.getOwnPropertyDescriptor. It reads
          // the $PropEntry back into a descriptor `$Object` (data → { value,
          // writable, enumerable, configurable }, accessor → { get, set,
          // enumerable, configurable }) and returns `undefined` for a missing own
          // property — §26.1.7 step 3 (FromPropertyDescriptor over
          // [[GetOwnProperty]]). The key is coerced with ToPropertyKey inside the
          // native via __to_property_key (#2042 S1), so numeric keys work.
          //
          // §26.1.7 step 1 requires a TypeError when the target is not an Object.
          // The native returns `undefined` for a non-$Object receiver (correct
          // for Object.getOwnPropertyDescriptor, which forwards a coerced
          // primitive wrapper), so — exactly as the deleteProperty PR-A guard —
          // gate at the CALL SITE with a `ref.test $Object` and throw a catchable
          // TypeError instead. The shared native is untouched.
          const ort = ensureObjectRuntime(ctx);
          const targetLocal = allocTempLocal(fctx, externRef);
          {
            const tArg = expr.arguments[0];
            if (tArg !== undefined) {
              const tTy = compileExpression(ctx, fctx, tArg, externRef);
              if (tTy && tTy.kind !== "externref") coerceType(ctx, fctx, tTy, externRef);
              else if (tTy === null) fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          fctx.body.push({ op: "local.set", index: targetLocal });
          // Pre-register the TypeError throw BEFORE the nested `if` so the splice
          // that captures its instrs cannot interleave a late-import index shift
          // into the block (same hazard handled in the deleteProperty guard).
          const throwInstrs: Instr[] = (() => {
            const before = fctx.body.length;
            emitThrowTypeError(ctx, fctx, "Reflect.getOwnPropertyDescriptor called on non-object");
            return fctx.body.splice(before);
          })();
          // if !ref.test $Object(target) → throw TypeError
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "ref.test", typeIdx: ort.objectTypeIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: throwInstrs,
          });
          // target is an $Object — push [target, key] and read the descriptor.
          fctx.body.push({ op: "local.get", index: targetLocal });
          releaseTempLocal(fctx, targetLocal);
          {
            const kArg = expr.arguments[1];
            if (kArg !== undefined) {
              const kTy = compileExpression(ctx, fctx, kArg, externRef);
              if (kTy && kTy.kind !== "externref") coerceType(ctx, fctx, kTy, externRef);
              else if (kTy === null) fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          const funcIdx = ensureLateImport(ctx, "__getOwnPropertyDescriptor", [externRef, externRef], [externRef]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
          return fallbackReturn(0, "extern-null");
        }

        if (reflectMethod === "defineProperty" && expr.arguments.length >= 3) {
          // (#2046) Route Reflect.defineProperty(target, key, desc) through the
          // SAME standalone runtime-descriptor applier that backs
          // Object.defineProperty — `emitDefinePropertyDescRuntime`
          // (object-ops.ts). Reusing it (rather than hand-rolling a
          // `__obj_define_from_desc` call here) is essential because that helper
          // performs the **#2372 descriptor struct reify**: an INLINE descriptor
          // object literal (`{ value: 42, … }`) is typed by the TS checker as a
          // closed WasmGC struct, which the native `__obj_define_from_desc`'s
          // internal `ref.test $Object` rejects as "not an object" → spurious
          // §10.1.6 TypeError. The helper reifies that struct into a fresh
          // `$Object` first, so inline-literal descriptors work. The issue file
          // recorded this arm as blocked on a write-side native (#2043); that
          // blocker is STALE — the native is registered by ensureObjectRuntime
          // and reachable end-to-end (it has backed Object.defineProperty since
          // #1629b).
          //
          // §28.1.3 Reflect.defineProperty(target, propertyKey, attributes):
          //   step 1: target not an Object → throw a TypeError. The native
          //     applier silently no-ops on a non-$Object target (matching the
          //     pre-existing standalone Object.defineProperty gap), so enforce
          //     the §28.1.3 step-1 throw HERE with the shared
          //     `emitNonObjectArgGuard` — it fires for a statically primitive /
          //     null / undefined target (the test262 non-object subtests use
          //     bare primitive literals). A runtime-`any` primitive still slips
          //     through, an accepted imprecision shared with Object.defineProperty.
          //   step 2: key = ? ToPropertyKey(propertyKey) — handled inside the
          //     native via __to_property_key (#2042 S1), so numeric keys coerce.
          //   step 3: desc = ? ToPropertyDescriptor(attributes) — a malformed
          //     descriptor (data+accessor conflict, non-callable get/set) throws
          //     a catchable TypeError, which the native already raises (these
          //     originate in ToPropertyDescriptor, BEFORE [[DefineOwnProperty]],
          //     so they throw for Reflect too).
          //   step 4: return the boolean [[DefineOwnProperty]] result. The native
          //     returns the obj (always truthy) and has no failure channel, so we
          //     drop it and return i32 `true`.
          //
          // KNOWN LIMITATION (shared with standalone Object.defineProperty): a
          // *rejected* redefine of an existing non-configurable property silently
          // no-ops in the native rather than surfacing failure, so we cannot
          // return the spec's `false` for that case — it returns `true`. Faithful
          // handling needs a failure channel in __defineProperty_value and is out
          // of this slice; converting the common refusal→working path is the win.
          const objArg = expr.arguments[0];
          const keyArg = expr.arguments[1];
          const descArg = expr.arguments[2];
          if (objArg !== undefined && keyArg !== undefined && descArg !== undefined) {
            // §28.1.3 step 1: statically-non-object target → throw TypeError.
            if (emitNonObjectArgGuard(ctx, fctx, objArg, "Reflect.defineProperty")) {
              fctx.body.push({ op: "i32.const", value: 0 }); // unreachable after throw
              return { kind: "i32" };
            }
            // `undefinedFields` is the host-only ToPropertyDescriptor presence
            // sidecar — unused on the standalone path, so pass empty.
            const r = emitDefinePropertyDescRuntime(ctx, fctx, objArg, keyArg, descArg, []);
            if (r !== null) {
              // The applier returns an externref; Reflect wants a boolean.
              // (#1355 Slice F) For a PROXY receiver the standalone
              // `__obj_define_from_desc` front-guard returns the defineProperty
              // trap's booleanish externref (NOT the obj) — so we must surface
              // that result, not unconditionally return true. For a non-proxy
              // receiver the applier returns the (always-truthy) obj, so
              // `__is_truthy` still yields the spec `true`. This keeps the
              // non-proxy behaviour identical while making a proxy trap's
              // false/true return observable through Reflect.defineProperty.
              const isTruthyIdx = ctx.funcMap.get("__is_truthy");
              if (isTruthyIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: isTruthyIdx });
              } else {
                fctx.body.push({ op: "drop" });
                fctx.body.push({ op: "i32.const", value: 1 });
              }
              return { kind: "i32" };
            }
          }
          return fallbackReturn(0, "i32-false");
        }

        if (reflectMethod === "getPrototypeOf" && expr.arguments.length >= 1) {
          // (#2046 PR-C) Route Reflect.getPrototypeOf(target) to the native
          // __getPrototypeOf — the SAME helper backing standalone
          // Object.getPrototypeOf (calls.ts ~5943). It returns
          // extern.convert_any($Object.$proto) (may be null) for an $Object
          // target. §28.1.1 Reflect.getPrototypeOf(target):
          //   step 1: target not an Object → throw a TypeError. The native
          //     returns null for a non-$Object receiver (correct for
          //     Object.getPrototypeOf after its ToObject), so — exactly as the
          //     deleteProperty / getOwnPropertyDescriptor PR-A guards — enforce
          //     the §28.1.1 step-1 throw at the CALL SITE with the shared
          //     emitNonObjectArgGuard (fires for a statically-primitive / null /
          //     undefined target). The shared native is untouched.
          //   step 2: return ? target.[[GetPrototypeOf]]() — the native read.
          const arg0 = expr.arguments[0]!;
          if (emitNonObjectArgGuard(ctx, fctx, arg0, "Reflect.getPrototypeOf")) {
            fctx.body.push({ op: "ref.null.extern" }); // unreachable after throw
            return { kind: "externref" };
          }
          const argType = compileExpression(ctx, fctx, arg0, externRef);
          if (!argType) {
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
          if (argType.kind !== "externref") coerceType(ctx, fctx, argType, externRef);
          const gpoIdx = ensureLateImport(ctx, "__getPrototypeOf", [externRef], [externRef]);
          flushLateImportShifts(ctx, fctx);
          if (gpoIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: gpoIdx });
            return { kind: "externref" };
          }
          return fallbackReturn(0, "extern-null");
        }

        if (reflectMethod === "setPrototypeOf" && expr.arguments.length >= 2) {
          // (#2046 PR-C) Route Reflect.setPrototypeOf(target, proto) to the
          // native __object_setPrototypeOf — the SAME helper backing standalone
          // Object.setPrototypeOf (calls.ts ~5829). It performs the §10.1.2.1
          // OrdinarySetPrototypeOf extensibility + cycle checks, writes
          // $Object.$proto (field 0) on success, and returns `obj` (NOT a
          // boolean). §28.1.14 Reflect.setPrototypeOf(target, proto):
          //   step 1: target not an Object → throw a TypeError. The native
          //     silently no-ops (returns obj) on a non-$Object receiver, so
          //     enforce the step-1 throw at the CALL SITE with the shared
          //     emitNonObjectArgGuard (statically-primitive / null / undefined
          //     target).
          //   step 2: proto not Object and not null → throw a TypeError. Reuse
          //     the same static guard on the proto arg, but `null` is a LEGAL
          //     proto here (unlike target), so only reject a statically-
          //     primitive NON-null proto. A `null`/`undefined`/object proto
          //     passes; a number/string/boolean proto literal throws.
          //   step 4: return the boolean [[SetPrototypeOf]] result. The native
          //     has no failure channel (a refused set — non-extensible target or
          //     a cycle — silently no-ops and still returns obj), so we drop obj
          //     and return i32 `true`. KNOWN LIMITATION (identical to the
          //     standalone Reflect.defineProperty arm above): a *refused* set
          //     returns the spec's `true` instead of `false`. Faithful handling
          //     needs a boolean failure channel in __object_setPrototypeOf and is
          //     out of this slice; converting the common refusal→working path is
          //     the win.
          const targetArg = expr.arguments[0]!;
          const protoArg = expr.arguments[1]!;
          // §28.1.14 step 1: statically-non-object target → throw TypeError.
          if (emitNonObjectArgGuard(ctx, fctx, targetArg, "Reflect.setPrototypeOf")) {
            fctx.body.push({ op: "i32.const", value: 0 }); // unreachable after throw
            return { kind: "i32" };
          }
          // §28.1.14 step 2: a statically-primitive proto that is NOT null/
          // undefined is illegal. `null`/`undefined` set the prototype to null
          // (legal), so let them through to the native (which maps a non-$Object
          // proto to a null $proto).
          const protoIsNullish =
            protoArg.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(protoArg) && protoArg.text === "undefined") ||
            protoArg.kind === ts.SyntaxKind.UndefinedKeyword;
          if (!protoIsNullish && emitNonObjectArgGuard(ctx, fctx, protoArg, "Reflect.setPrototypeOf")) {
            fctx.body.push({ op: "i32.const", value: 0 }); // unreachable after throw
            return { kind: "i32" };
          }
          // obj (externref)
          const objType = compileExpression(ctx, fctx, targetArg, externRef);
          if (!objType) {
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          if (objType.kind !== "externref") coerceType(ctx, fctx, objType, externRef);
          // proto (externref) — compileProtoArg reifies an inline-literal proto
          // into a native $Object so __object_setPrototypeOf's `ref.test $Object`
          // succeeds (the same #2580 M3 Stage A handling Object.setPrototypeOf
          // uses); keeps the ordinary externref path for non-literal / null protos.
          compileProtoArg(ctx, fctx, protoArg);
          const spoIdx = ensureLateImport(ctx, "__object_setPrototypeOf", [externRef, externRef], [externRef]);
          flushLateImportShifts(ctx, fctx);
          if (spoIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: spoIdx });
            fctx.body.push({ op: "drop" }); // native returns obj; Reflect wants a boolean
            fctx.body.push({ op: "i32.const", value: 1 }); // success → true (see KNOWN LIMITATION)
            return { kind: "i32" };
          }
          return fallbackReturn(0, "i32-true");
        }
        // Boolean-returning methods need an i32 on the stack; the rest return
        // externref. Pick the fallback shape per method so the surrounding
        // expression still type-checks even though the module is already marked
        // failed by reportError.
        const booleanReflect = new Set([
          "set",
          "has",
          "deleteProperty",
          "defineProperty",
          "setPrototypeOf",
          "isExtensible",
          "preventExtensions",
        ]);
        reportError(
          ctx,
          expr,
          `Codegen error: Reflect.${reflectMethod} not supported in standalone mode (#1472 Phase C).`,
        );
        if (booleanReflect.has(reflectMethod)) {
          fctx.body.push({ op: "i32.const", value: 0 });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      // Reflect.get(target, key, [receiver]) — returns externref.
      if (reflectMethod === "get" && expr.arguments.length >= 2) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_get", [externRef, externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }

      // Reflect.set(target, key, value, [receiver]) — returns i32 (boolean).
      if (reflectMethod === "set" && expr.arguments.length >= 2) {
        emitReflectArgs(4);
        const funcIdx = ensureLateImport(ctx, "__reflect_set", [externRef, externRef, externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(4, "i32-true");
      }

      // Reflect.has(target, key) — returns i32 (boolean).
      if (reflectMethod === "has" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(ctx, "__reflect_has", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(2, "i32-true");
      }

      // Reflect.deleteProperty(target, key) — returns i32 (boolean).
      if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(ctx, "__reflect_deleteProperty", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(2, "i32-true");
      }

      // Reflect.defineProperty(target, key, desc) — returns i32 (boolean).
      if (reflectMethod === "defineProperty" && expr.arguments.length >= 3) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_defineProperty", [externRef, externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(3, "i32-true");
      }

      // Reflect.getOwnPropertyDescriptor(target, key) — returns externref.
      if (reflectMethod === "getOwnPropertyDescriptor" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(
          ctx,
          "__reflect_getOwnPropertyDescriptor",
          [externRef, externRef],
          [externRef],
        );
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(2, "extern-null");
      }

      // Reflect.getPrototypeOf(target) — returns externref.
      if (reflectMethod === "getPrototypeOf" && expr.arguments.length >= 1) {
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_getPrototypeOf", [externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(1, "extern-null");
      }

      // Reflect.setPrototypeOf(target, proto) — returns i32 (boolean).
      // (#2747 d) Record the user [[Prototype]] on BOTH channels:
      //   - __host_set_struct_proto populates `_wasmStructProto` — the SAME link
      //     the Object.setPrototypeOf gc/host arm (calls.ts ~5980) writes and the
      //     for-in walk consults via `_structUserProto`. Without this the
      //     inherited keys never enumerated (verify-first: for-in dropped the
      //     inherited key).
      //   - __reflect_setPrototypeOf preserves the host-wrapper round-trip that
      //     Reflect.getPrototypeOf reads (and is the only channel that handles a
      //     non-weak-key-able empty `{}` target — #1466). Keeping it means the
      //     existing Reflect.get/setPrototypeOf round-trip does not regress.
      // target/proto are saved in temp locals so both calls receive them.
      if (reflectMethod === "setPrototypeOf" && expr.arguments.length >= 2) {
        const objLocal = allocTempLocal(fctx, externRef);
        const protoLocal = allocTempLocal(fctx, externRef);
        // target → objLocal
        {
          const a = expr.arguments[0];
          const ty = a ? compileExpression(ctx, fctx, a, externRef) : null;
          if (ty && ty.kind !== "externref") coerceType(ctx, fctx, ty, externRef);
          else if (ty === null || a === undefined) fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "local.set", index: objLocal });
        // proto → protoLocal
        {
          const a = expr.arguments[1];
          const ty = a ? compileExpression(ctx, fctx, a, externRef) : null;
          if (ty && ty.kind !== "externref") coerceType(ctx, fctx, ty, externRef);
          else if (ty === null || a === undefined) fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "local.set", index: protoLocal });
        // __host_set_struct_proto(obj, proto) → for-in channel; returns obj, drop.
        const hIdx = ensureLateImport(ctx, "__host_set_struct_proto", [externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (hIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "local.get", index: protoLocal });
          fctx.body.push({ op: "call", funcIdx: hIdx });
          fctx.body.push({ op: "drop" });
        }
        // __reflect_setPrototypeOf(obj, proto) → wrapper round-trip; returns i32.
        const rIdx = ensureLateImport(ctx, "__reflect_setPrototypeOf", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (rIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "local.get", index: protoLocal });
          fctx.body.push({ op: "call", funcIdx: rIdx });
          releaseTempLocal(fctx, objLocal);
          releaseTempLocal(fctx, protoLocal);
          return { kind: "i32" };
        }
        releaseTempLocal(fctx, objLocal);
        releaseTempLocal(fctx, protoLocal);
        // Reflect helper unavailable — return the success sentinel (true).
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.ownKeys(target) — returns externref (Array including Symbol keys, per §28.1.13).
      if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_ownKeys", [externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(1, "extern-null");
      }

      // Reflect.isExtensible(target) — returns i32 (boolean).
      // Preserve ctx.nonExtensibleVars marking (used by Object.isFrozen / Object.preventExtensions
      // compile-time tracking at calls.ts:2089/2180) for identifiers so legacy callers still see
      // the same answer; but the runtime answer always comes from the host.
      if (reflectMethod === "isExtensible" && expr.arguments.length >= 1) {
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_isExtensible", [externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(1, "i32-true");
      }

      // Reflect.preventExtensions(target) — returns i32 (boolean).
      // Keep ctx.nonExtensibleVars side-effect for identifiers so the Object.* compile-time
      // fast path stays consistent with the host's runtime answer.
      if (reflectMethod === "preventExtensions" && expr.arguments.length >= 1) {
        const arg0 = expr.arguments[0]!;
        if (ts.isIdentifier(arg0)) {
          ctx.nonExtensibleVars.add(arg0.text);
        }
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_preventExtensions", [externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(1, "i32-true");
      }

      // Reflect.apply(fn, thisArg, argList) — returns externref. Host performs CreateListFromArrayLike.
      if (reflectMethod === "apply" && expr.arguments.length >= 3) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_apply", [externRef, externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }

      // Reflect.construct(C, args, [newTarget]) — returns externref.
      // Passing ref.null.extern for omitted newTarget lets the host wrapper default to `C`.
      if (reflectMethod === "construct" && expr.arguments.length >= 2) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_construct", [externRef, externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }
    }

    // Handle Promise.all / Promise.race / Promise.allSettled / Promise.any / Promise.resolve / Promise.reject — host-delegated static calls
    //
    // (#1368) For the four aggregators, we pass `thisArg` so the spec-compliant
    // helper can construct via `thisArg.call(...)` for subclass support.
    // Resolve/reject keep their original 1-arg signature (no thisArg needed).
    {
      const isAggregatorMethod =
        propAccess.name.text === "all" ||
        propAccess.name.text === "race" ||
        propAccess.name.text === "allSettled" ||
        propAccess.name.text === "any";
      // (#1116b, E1) `Sub.all(iter)` where `Sub` is a `class extends Promise`
      // is a subclass static inherited from Promise. Recognise the subclass
      // receiver here too so it reaches the aggregator lowering (the thisArg
      // resolution below switches it to directCall=0).
      const isPromiseSubclassReceiver =
        ts.isIdentifier(propAccess.expression) &&
        resolvePromiseSubclassName(ctx, propAccess.expression.text) !== undefined;
      const isAggregator =
        ts.isIdentifier(propAccess.expression) &&
        (propAccess.expression.text === "Promise" || isPromiseSubclassReceiver) &&
        isAggregatorMethod;
      const isResolveReject =
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "Promise" &&
        (propAccess.name.text === "resolve" || propAccess.name.text === "reject");
      if (isAggregator) {
        const methodName = propAccess.name.text;
        // (#2867 Gap 4) Native host-free `Promise.all`/`Promise.race` over an
        // array literal under the native-`$Promise` carrier. Gated on
        // `isStandalonePromiseActive` (wasi-only today → widens to standalone at
        // slice 1d), so gc/host + still-host-backed standalone lanes are
        // byte-unchanged. Literal no-spread arguments unroll at compile time
        // below; array-TYPED non-literal arguments take the (#2919 arm 1)
        // runtime loop after that; Set/Map arguments take the (#2922 arm 3a)
        // compile-time collection projection; everything else except strings,
        // `number[]` vecs, and native-generator subjects takes the (#2922 arms
        // 2+3) dynamic `__combinator_to_vec` path (custom iterables drain,
        // non-iterables reject with a native TypeError). (#3137) `allSettled`/
        // `any` take the same native arms (status objects / AggregateError via
        // ensureSettledAnyCombinators); subclass capability-ctor receivers
        // still fall through to the host path (follow-ups).
        const arg0 = expr.arguments[0];
        const nativeCombinatorEligible =
          isStandalonePromiseActive(ctx) &&
          isNativeCombinatorMethod(methodName) &&
          !isPromiseSubclassReceiver &&
          expr.arguments.length === 1;
        if (
          nativeCombinatorEligible &&
          arg0 !== undefined &&
          ts.isArrayLiteralExpression(arg0) &&
          arg0.elements.every((el) => !ts.isSpreadElement(el) && !ts.isOmittedExpression(el))
        ) {
          const elementInstrs: Instr[][] = [];
          // (#2919, same funcIdx-desync class as #2918) Keep the outer body AND
          // every completed element buffer reachable while later elements (and
          // the combinator-runtime registration inside
          // emitStandalonePromiseCombinator) compile: a late import landing
          // mid-compile walks fctx.body + fctx.savedBodies to shift baked
          // `call`/`ref.func` indices — a bare local swap orphans them.
          // NOTE the buffers are popped only AFTER emitStandalonePromiseCombinator
          // returns; its ensure* registration (the only possible import trigger
          // inside it) runs BEFORE it copies the buffers into fctx.body, so no
          // instruction is ever reachable via two walked arrays at shift time
          // (the shared-Instr double-remap hazard).
          const savedBody = fctx.body;
          fctx.savedBodies.push(savedBody);
          let pushedBufs = 0;
          try {
            for (const el of arg0.elements) {
              const buf: Instr[] = [];
              fctx.body = buf;
              try {
                compileExpression(ctx, fctx, el, { kind: "externref" });
              } finally {
                fctx.body = savedBody;
              }
              elementInstrs.push(buf);
              fctx.savedBodies.push(buf);
              pushedBufs++;
            }
            return emitStandalonePromiseCombinator(ctx, fctx, methodName, elementInstrs);
          } finally {
            fctx.savedBodies.length -= pushedBufs + 1;
          }
        }
        // (#2922 arm 3a) Native combinator over a SET/MAP argument —
        // `Promise.all(set)`. `$Map`-backed collections have NO runtime
        // `@@iterator`/`next` dispatch (for-of iterates them via the
        // compile-time #2162 projection), so the dynamic path below can never
        // see them — handle them statically by materializing the same
        // projection (Set → values, Map → [k, v] entries) into a canonical
        // externref $Vec and driving the unchanged arm-1 runtime loop over it.
        // Checker-only guard first (no emission for non-Set/Map args), then a
        // #1919-transactional probe confirms the arg genuinely lowers to the
        // native `$Map` struct (mirrors compileForOfNativeCollection).
        if (nativeCombinatorEligible && arg0 !== undefined && ctx.nativeStrings && ctx.mapTypeIdx >= 0) {
          const argTsType = ctx.checker.getTypeAtLocation(arg0);
          const symName = argTsType.getSymbol()?.getName() ?? argTsType.aliasSymbol?.name;
          if (symName === "Set" || symName === "Map") {
            const isSet = symName === "Set";
            const snap = snapshotSpeculative(ctx, fctx);
            const recvType = compileExpression(ctx, fctx, arg0);
            rollbackSpeculative(ctx, fctx, snap);
            if (
              recvType !== null &&
              (recvType.kind === "ref" || recvType.kind === "ref_null") &&
              recvType.typeIdx === ctx.mapTypeIdx
            ) {
              const vecResult = emitCollectionIteratorVec(ctx, fctx, arg0, isSet ? "values" : "entries", isSet);
              if (
                vecResult !== undefined &&
                vecResult !== null &&
                typeof vecResult === "object" &&
                (vecResult.kind === "ref" || vecResult.kind === "ref_null")
              ) {
                const collArrTypeIdx = getArrTypeIdxFromVec(ctx, vecResult.typeIdx);
                const collVecLocal = allocLocal(fctx, `__comb_argvec_${fctx.locals.length}`, {
                  kind: "ref_null",
                  typeIdx: vecResult.typeIdx,
                });
                fctx.body.push({ op: "local.set", index: collVecLocal });
                return emitStandalonePromiseCombinatorRuntime(
                  ctx,
                  fctx,
                  methodName,
                  collVecLocal,
                  vecResult.typeIdx,
                  collArrTypeIdx,
                );
              }
            }
          }
        }
        // (#2919 arm 1) Native combinator over an ARRAY-TYPED non-literal
        // argument — `Promise.all(arrVar)`, spread/holed literals, etc.
        // Transactionally compile the argument with its natural type; if it
        // lowers to an externref-backed vec (`Promise<T>[]`-shaped arrays do),
        // KEEP the compiled arg and loop over it at runtime feeding
        // `__combinator_subscribe`. Anything else is rolled back — body AND any
        // locals / late imports / errors the probe allocated — via the #1919
        // helper (a raw `body.length =` rollback would leak a phantom late
        // import); the (#2922) dynamic path below then decides whether to take
        // the probed shape at runtime or keep the host fallthrough
        // byte-unchanged (f64-backed `number[]` vecs — the Gap-4
        // output-representation escalation —, strings, native generators).
        if (nativeCombinatorEligible && arg0 !== undefined) {
          const snap = snapshotSpeculative(ctx, fctx);
          const argType = compileExpression(ctx, fctx, arg0);
          const vecShape = resolveExternrefVecArg(ctx, argType);
          if (vecShape) {
            const argVecLocal = allocLocal(fctx, `__comb_argvec_${fctx.locals.length}`, {
              kind: "ref_null",
              typeIdx: vecShape.vecTypeIdx,
            });
            fctx.body.push({ op: "local.set", index: argVecLocal });
            return emitStandalonePromiseCombinatorRuntime(
              ctx,
              fctx,
              methodName,
              argVecLocal,
              vecShape.vecTypeIdx,
              vecShape.arrTypeIdx,
            );
          }
          // Didn't lower as an externref vec — roll back, then either take the
          // (#2922 arms 2+3) dynamic path or fall through to the host path.
          rollbackSpeculative(ctx, fctx, snap);
          if (isDynamicCombinatorArgEligible(ctx, argType, arg0)) {
            return emitDynamicCombinatorArg(ctx, fctx, methodName, arg0);
          }
        }
        const importName = `Promise_${methodName}`;
        // Three-arg signature: (thisArg, iterable, directCall) → result
        // (#1116) directCall=1 means "no explicit `.call` was used; default to
        // globalThis.Promise". directCall=0 means "user wrote `.call(thisArg, …)`;
        // pass thisArg through unchanged so the runtime / V8 can apply the
        // spec-mandated TypeError when thisArg is non-Object."
        let funcIdx =
          ctx.funcMap.get(importName) ??
          ensureLateImport(
            ctx,
            importName,
            [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
            [{ kind: "externref" }],
          );
        flushLateImportShifts(ctx, fctx);
        funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
        if (funcIdx !== undefined) {
          // (#1116b, E1) Subclass static `Sub.all(iter)` — the receiver
          // `Sub` is a `class extends Promise`. Resolve it to the synthesized
          // JS subclass as thisArg and switch to directCall=0 so the runtime
          // uses it instead of substituting globalThis.Promise.
          const subclassThisArg = resolvePromiseSubclassThisArg(ctx, fctx, propAccess.expression);
          if (!subclassThisArg) {
            // Direct `Promise.METHOD(iter)` — no explicit thisArg.
            fctx.body.push({ op: "ref.null.extern" });
          }
          if (expr.arguments.length >= 1) {
            // (#1465) The runtime helper delegates to native
            // `Promise.METHOD.call(C, iter)` which drives `GetIterator(iter)`
            // per spec. For that to work the host engine must see a real JS
            // iterable. Array literals tend to compile to a wasm tuple/vec
            // struct that's opaque to the host, so materialise them into a
            // JS array eagerly here. Other expressions fall back to plain
            // externref coercion (the runtime helper handles strings, JS
            // arrays, generators, custom iterables, and known wasm vec
            // shapes via __vec_len/__vec_get).
            emitIterableArg(ctx, fctx, expr.arguments[0]!);
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          // directCall=1 — runtime substitutes globalThis.Promise. When a
          // subclass receiver was resolved (E1), directCall=0 so the runtime
          // uses the synthesized thisArg ctor instead.
          fctx.body.push({ op: "i32.const", value: subclassThisArg ? 0 : 1 });
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
      if (isResolveReject) {
        const methodName = propAccess.name.text;
        // (#1326 Phase 1B) Standalone-mode `Promise.resolve(v)` /
        // `Promise.reject(r)` — emit Wasm-native `$Promise` struct.new instead
        // of the JS-host `Promise_{resolve,reject}_import` (unsatisfiable in
        // WASI). (#2980 async-gen fallback lives in `isStandalonePromiseActive`.)
        if (isStandalonePromiseActive(ctx)) {
          // (#3125) `Promise.resolve` now routes through the spec Resolve
          // (`__promise_resolve_value` — thenable assimilation / poisoned-then
          // reject / promise passthrough), which needs the settle-function
          // substrate. Ensure it BEFORE compiling the argument into the
          // detached side buffer, so the substrate's minted-func registration
          // can never land while `argInstrs` is off `fctx.body`/liveBodies.
          if (methodName === "resolve") {
            ensurePromiseSettleFunctions(ctx);
          }
          // Compile the value/reason argument FIRST into a side buffer
          // so the helper controls the final Wasm op order
          // (state | value | null | struct.new | extern.convert_any).
          const argInstrs: Instr[] = [];
          ctx.liveBodies.add(argInstrs);
          const savedBody = fctx.body;
          fctx.body = argInstrs;
          try {
            if (expr.arguments.length >= 1) {
              compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } finally {
            fctx.body = savedBody;
          }
          try {
            if (methodName === "resolve") {
              emitStandalonePromiseResolve(ctx, fctx, argInstrs);
            } else {
              emitStandalonePromiseReject(ctx, fctx, argInstrs);
            }
          } finally {
            ctx.liveBodies.delete(argInstrs);
          }
          return { kind: "externref" };
        }
        const importName = `Promise_${methodName}`;
        let funcIdx =
          ctx.funcMap.get(importName) ??
          ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
        if (funcIdx !== undefined) {
          if (expr.arguments.length >= 1) {
            compileExpression(ctx, fctx, expr.arguments[0]!, {
              kind: "externref",
            });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // (#1368) Detect `Promise.METHOD.call(thisArg, iter)` pattern — common in
    // test262 to set a custom constructor (`Promise.all.call(SubClass, iter)`).
    // The current call expression looks like `(Promise.METHOD).call(thisArg, iter)`,
    // i.e. propAccess.name.text === "call" and propAccess.expression is a
    // PropertyAccess `Promise.METHOD`.
    if (
      propAccess.name.text === "call" &&
      ts.isPropertyAccessExpression(propAccess.expression) &&
      ts.isIdentifier(propAccess.expression.expression) &&
      propAccess.expression.expression.text === "Promise" &&
      (propAccess.expression.name.text === "all" ||
        propAccess.expression.name.text === "race" ||
        propAccess.expression.name.text === "allSettled" ||
        propAccess.expression.name.text === "any") &&
      expr.arguments.length >= 1
    ) {
      // (#1326 Phase 1B note) The `.call(...)` aggregator pattern only
      // fires for all/race/allSettled/any (see `condition above`), NOT
      // for Promise.resolve/reject. Phase 1B's standalone path lives at
      // the earlier direct-call site (`Promise.resolve(v)` /
      // `Promise.reject(r)` without `.call`) and does not apply here.
      const methodName = propAccess.expression.name.text;
      const importName = `Promise_${methodName}`;
      // Three-arg signature: (thisArg, iterable, directCall) → result. See (#1116)
      // comment at the direct-call branch above.
      let funcIdx =
        ctx.funcMap.get(importName) ??
        ensureLateImport(
          ctx,
          importName,
          [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
          [{ kind: "externref" }],
        );
      flushLateImportShifts(ctx, fctx);
      funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
      if (funcIdx !== undefined) {
        // arg0 = thisArg (user-provided — may be undefined/null/primitive,
        // in which case the runtime / V8 throws TypeError per spec §27.2.4.X step 2).
        // (#1116b) When thisArg names a `class X extends Promise`, resolve it to
        // a synthesized JS-callable Promise subclass; otherwise compile normally.
        if (!resolvePromiseSubclassThisArg(ctx, fctx, expr.arguments[0]!)) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        }
        // arg1 = iterable (or ref.null if missing). #1465: materialise array
        // literals to JS arrays so native GetIterator can drive them.
        if (expr.arguments.length >= 2) {
          emitIterableArg(ctx, fctx, expr.arguments[1]!);
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        // directCall=0 — user invoked via `.call`, so thisArg is meaningful.
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // Handle JSON.stringify / JSON.parse as host import calls
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "JSON") {
      const method = propAccess.name.text;
      // (#3176) ES2025 `JSON.rawJSON` / `JSON.isRawJSON` — standalone / WASI
      // pure-Wasm. `rawJSON` builds a branded carrier object; `isRawJSON` reads
      // the `[[IsRawJSON]]` brand bit. Both reuse the native JSON codec +
      // object runtime (no host import, no second parser).
      if ((method === "rawJSON" || method === "isRawJSON") && (ctx.standalone || ctx.wasi)) {
        if (method === "rawJSON" && expr.arguments.length >= 1) {
          // Build the carrier: `__json_rawjson` ToStrings the raw value inside
          // then validates + brands it.
          emitJsonRawJson(ctx);
          const rawArg = expr.arguments[0]!;
          // `undefined` / `void …` ToString to "undefined", which the parser
          // rejects. But both compile to a bare `ref.null extern` —
          // indistinguishable at runtime from `null` (whose ToString "null" IS a
          // valid rawJSON primitive). So pass the literal string "undefined" for
          // the syntactic undefined/void case; the codec then parses+rejects it.
          // Peel `as`/`satisfies`/parens/`!` wrappers so `undefined as any` is
          // still recognised.
          let peeled: ts.Expression = rawArg;
          while (
            ts.isAsExpression(peeled) ||
            ts.isSatisfiesExpression(peeled) ||
            ts.isParenthesizedExpression(peeled) ||
            ts.isNonNullExpression(peeled) ||
            ts.isTypeAssertionExpression(peeled)
          ) {
            peeled = peeled.expression;
          }
          const isUndefinedLit =
            (ts.isIdentifier(peeled) && peeled.text === "undefined") || ts.isVoidExpression(peeled);
          if (isUndefinedLit) {
            for (const ins of stringConstantExternrefInstrs(ctx, "undefined")) fctx.body.push(ins);
          } else {
            // Compile the arg to externref (the primitive-boxing target — a bare
            // `anyref` hint drops a number literal and pushes null).
            const argResult = compileExpression(ctx, fctx, rawArg, { kind: "externref" });
            if (argResult === null) return null;
            if (argResult.kind !== "externref") {
              coerceType(ctx, fctx, argResult, { kind: "externref" });
            }
          }
          flushLateImportShifts(ctx, fctx);
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_rawjson")! });
          return { kind: "externref" };
        }
        if (method === "isRawJSON") {
          if (expr.arguments.length >= 1) {
            const argResult = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            if (argResult === null) return null;
            if (argResult.kind !== "externref") {
              coerceType(ctx, fctx, argResult, { kind: "externref" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          emitJsonIsRawJson(ctx);
          flushLateImportShifts(ctx, fctx);
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_is_rawjson")! });
          return { kind: "i32" };
        }
      }
      if ((method === "stringify" || method === "parse") && expr.arguments.length >= 1) {
        // (#1324 primitives slice) For JSON.stringify of statically-typed
        // primitive values (null / undefined / boolean, plus number when the
        // target has a number_toString helper), emit the result without the
        // JSON_stringify host import. Standalone/WASI number stringify falls
        // through to the #1599 refusal until Phase 2 has pure-Wasm formatting.
        // Object/array/string/bigint cases fall through to the existing
        // JSON_stringify host import — full pure-Wasm shape walking is
        // tracked under #1353 (architect-spec follow-up).
        if (method === "stringify") {
          const primitiveStringType = tryEmitJsonStringifyPrimitive(ctx, fctx, expr.arguments[0]!);
          if (primitiveStringType !== undefined) {
            // Compile remaining args (replacer, space) for their side
            // effects only — primitive stringify ignores them per spec
            // §25.5.4 (replacer doesn't observe primitives, space only
            // affects nested output).
            for (let i = 1; i < expr.arguments.length; i++) {
              const t = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (t) fctx.body.push({ op: "drop" });
            }
            return primitiveStringType;
          }
          if ((ctx.standalone || ctx.wasi) && expr.arguments.length >= 1) {
            // #2166: thread the optional replacer (must be null/undefined) and
            // space args so `JSON.stringify(value, null, 2)` produces the
            // indented form statically instead of refusing.
            const staticStringType = tryEmitJsonStringifyStatic(
              ctx,
              fctx,
              expr.arguments[0]!,
              expr.arguments[1],
              expr.arguments[2],
            );
            if (staticStringType !== undefined) {
              return staticStringType;
            }
            // (#2166 PR-A/PR-B) Dynamic object-graph stringify. The static fold
            // declined (runtime-built graph), so serialise with the pure-Wasm
            // recursive codec over the standalone value rep ($Object/$ObjVec/
            // boxed primitives) instead of refusing or silently wrong-folding.
            // PR-B threads a *static* `space` argument (number/string literal)
            // into the codec's indent path; a function/array replacer or a
            // *dynamic* space still keeps the refusal below.
            const replacerArg = expr.arguments[1];
            const spaceArg = expr.arguments[2];
            const replacerNullish =
              replacerArg === undefined ||
              replacerArg.kind === ts.SyntaxKind.NullKeyword ||
              (ts.isIdentifier(replacerArg) && replacerArg.text === "undefined");
            // PR-A serialises `$Object` graphs only. Arrays (closed typed-vec
            // structs `number[]` etc.) and tuples are a separate sub-slice
            // (PR-A2) — they are NOT `$ObjVec`, so routing them to the codec
            // would emit wrong output. Detect an array/tuple static type via the
            // checker and keep it on the refusal path below.
            const arg0Type = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
            const checkerArr = ctx.checker as unknown as {
              isArrayType?: (t: unknown) => boolean;
              isTupleType?: (t: unknown) => boolean;
            };
            const isArrayLike =
              (checkerArr.isArrayType?.(arg0Type) ?? false) ||
              (checkerArr.isTupleType?.(arg0Type) ?? false) ||
              // Fallback when the internal predicates are unavailable: a numeric
              // index type with only integer / `length` own keys looks array-like.
              (arg0Type.getNumberIndexType() !== undefined &&
                arg0Type.getProperties().every((p) => /^\d+$/.test(p.name) || p.name === "length"));
            // (#2166 PR-B) Resolve a static `space` argument to the §25.5.2
            // indent unit ("gap"). `undefined` space → compact (gap ""). A
            // *dynamic* space arg stays unresolved → keep the refusal below
            // (rare shape). An empty gap (space ≤0 / "") routes through the
            // compact path.
            let gap: string | undefined = "";
            if (spaceArg !== undefined) {
              const staticSpace = staticSpaceValue(ctx, spaceArg);
              gap = staticSpace === undefined ? undefined : jsonGapFromStaticSpace(staticSpace);
            }
            if (replacerNullish && gap !== undefined && !isArrayLike) {
              const argResult = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "anyref" });
              if (argResult === null) return null;
              // Bring the value to anyref so the codec can ref.test-discriminate
              // it. Externref-typed object/array values widen via any.convert_extern.
              if (argResult.kind === "externref" || argResult.kind === "ref_extern") {
                fctx.body.push({ op: "any.convert_extern" });
              } else if (argResult.kind !== "anyref") {
                coerceType(ctx, fctx, argResult, { kind: "anyref" });
              }
              emitJsonStringifyValue(ctx);
              flushLateImportShifts(ctx, fctx);
              if (gap === "") {
                // No indentation — the compact root (cheapest path).
                fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_stringify_root")! });
              } else {
                // Pretty-print: push the gap string and call the indent root.
                for (const instr of nativeStringLiteralInstrs(ctx, gap)) fctx.body.push(instr);
                fctx.body.push({
                  op: "call",
                  funcIdx: ctx.funcMap.get("__json_stringify_root_indent")!,
                });
              }
              return nativeStringType(ctx);
            }
            // (#2166 PR-D3) replacer — a function replacer transforms every
            // property/element (`replacer.call(holder, key, value)`); an array
            // replacer is a key allowlist. Both route to the dynamic codec via
            // __json_stringify_root_replacer. The value must be a plain object
            // graph (PR-A scope — not array-like); a dynamic space still refuses.
            if (!replacerNullish && gap !== undefined && !isArrayLike && replacerArg !== undefined) {
              const replacerCallable =
                ts.isArrowFunction(replacerArg) ||
                ts.isFunctionExpression(replacerArg) ||
                ctx.checker.getTypeAtLocation(replacerArg).getCallSignatures().length > 0;
              const isArrayLiteral = ts.isArrayLiteralExpression(replacerArg);
              if (replacerCallable || isArrayLiteral) {
                // value → anyref
                const argResult = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "anyref" });
                if (argResult === null) return null;
                if (argResult.kind === "externref" || argResult.kind === "ref_extern") {
                  fctx.body.push({ op: "any.convert_extern" });
                } else if (argResult.kind !== "anyref") {
                  coerceType(ctx, fctx, argResult, { kind: "anyref" });
                }
                // gap (or null for compact)
                if (gap === "") {
                  fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
                } else {
                  for (const instr of nativeStringLiteralInstrs(ctx, gap)) fctx.body.push(instr);
                }
                // replacer (externref) + allowList (externref); exactly one is set.
                if (isArrayLiteral) {
                  fctx.body.push({ op: "ref.null.extern" }); // no fn replacer
                  emitJsonReplacerAllowList(ctx, fctx, replacerArg); // builds $Object → externref
                } else {
                  // A function replacer goes through the GC-closure path
                  // (compileArrowAsClosure), NOT __make_callback — the host
                  // bridge leaks an env:: import and its JS wrapper fails the
                  // __call_fn_method_2 ref.cast (same rationale as the PR-D1
                  // reviver path).
                  if (ts.isArrowFunction(replacerArg) || ts.isFunctionExpression(replacerArg)) {
                    compileArrowAsClosure(ctx, fctx, replacerArg);
                  } else {
                    const r = compileExpression(ctx, fctx, replacerArg, { kind: "externref" });
                    if (r === null) return null;
                  }
                  fctx.body.push({ op: "ref.null.extern" }); // no allowList
                }
                emitJsonStringifyValue(ctx);
                flushLateImportShifts(ctx, fctx);
                fctx.body.push({
                  op: "call",
                  funcIdx: ctx.funcMap.get("__json_stringify_root_replacer")!,
                });
                return nativeStringType(ctx);
              }
            }
          }
        }
        if (method === "parse" && (ctx.standalone || ctx.wasi)) {
          // (#2166 PR-D1) The static-literal fold ignores a reviver — skip it
          // when a 2nd arg is present so `JSON.parse('5', reviver)` runs the
          // reviver walk instead of folding to the bare parsed value.
          if (expr.arguments.length < 2) {
            const parsedType = tryEmitJsonParseLiteral(ctx, fctx, expr);
            if (parsedType !== undefined) {
              return parsedType;
            }
          }
          // (#2166 PR-C) Dynamic-graph JSON.parse: a runtime JSON *text* →
          // object / array / string / primitive value, parsed entirely in Wasm
          // (no `env::JSON_parse` host import). The full recursive-descent
          // grammar in json-codec-native.ts (`__json_parse_text`) builds the
          // SAME value rep the object runtime + stringify codec consume, so a
          // round-trip `JSON.parse(JSON.stringify(o))` and downstream property
          // reads work. It is a strict superset of the older primitive-only
          // `__json_parse_primitive` slice — which could only parse a lone
          // number / true / false / null and *traps* on `{`/`[`/`"` — so it
          // takes over the whole runtime-string case (the primitive helper
          // stays for any caller that still routes to it directly). A `reviver`
          // (#2166 PR-D1) A `reviver` (2nd arg) routes to the reviver codec when
          // it is a function; a non-function 2nd arg keeps the refusal below.
          if (expr.arguments.length === 1 || expr.arguments.length === 2) {
            let parseArgType: ts.Type | undefined;
            try {
              parseArgType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
            } catch {
              parseArgType = undefined;
            }
            // Route string-typed and `any`/`unknown`-typed (the common
            // `JSON.parse(text)` where `text: string`) arguments. A non-string
            // statically-typed arg (e.g. a number) is a type error in user code;
            // let it fall through to the refusal below.
            const isStringOrAny =
              parseArgType === undefined ||
              (parseArgType.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
            // A reviver is honoured only when it is callable (has call
            // signatures). A null / undefined / any other non-callable 2nd arg
            // is simply IGNORED per §25.5.1 (the reviver step is IsCallable-
            // gated) — route through the plain parse path, never refuse. This
            // matches the host JSON.parse behaviour for a non-function reviver.
            const reviverArg = expr.arguments[1];
            let reviverCallable = false;
            if (reviverArg !== undefined) {
              try {
                reviverCallable = ctx.checker.getTypeAtLocation(reviverArg).getCallSignatures().length > 0;
              } catch {
                reviverCallable = false;
              }
            }
            if (isStringOrAny) {
              const argResult = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
              if (argResult === null) return null;
              if (argResult.kind !== "externref") {
                coerceType(ctx, fctx, argResult, { kind: "externref" });
              }
              if (reviverCallable) {
                // text already on the stack as externref; push the reviver as a
                // GC closure widened to externref. CRITICAL: compile the closure
                // via the GC-struct path (`compileArrowAsClosure`), NOT
                // `compileExpression(..., externref)` — the latter routes an
                // inline arrow at this non-user call site through the host
                // `__make_callback` bridge (an `env::` import that breaks
                // standalone and whose JS wrapper fails the `__call_fn_method_2`
                // ref.cast). The driver consumes the GC closure as externref via
                // extern.convert_any.
                const revResult =
                  ts.isArrowFunction(reviverArg!) || ts.isFunctionExpression(reviverArg!)
                    ? compileArrowAsClosure(ctx, fctx, reviverArg!)
                    : compileExpression(ctx, fctx, reviverArg!, { kind: "anyref" });
                if (revResult === null) return null;
                if (revResult.kind === "ref" || revResult.kind === "ref_null" || revResult.kind === "anyref") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (revResult.kind !== "externref") {
                  coerceType(ctx, fctx, revResult, { kind: "externref" });
                }
                emitJsonParseTextReviver(ctx);
                flushLateImportShifts(ctx, fctx);
                fctx.body.push({
                  op: "call",
                  funcIdx: ctx.funcMap.get("__json_parse_text_reviver")!,
                });
                return { kind: "anyref" };
              }
              emitJsonParseText(ctx);
              flushLateImportShifts(ctx, fctx);
              fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_parse_text")! });
              // The codec returns the value graph as anyref ($Object/$ObjVec/
              // $NativeString widened, or a ref $AnyValue for primitives). The
              // downstream coercion paths (object property read, AnyValue→
              // primitive) dispatch on the concrete ref via ref.test.
              return { kind: "anyref" };
            }
          }
        }
        void tryEmitJsonParsePrimitive;
        // (#1599 Phase 1) Refuse-and-document: in standalone (no-JS-host) /
        // WASI mode there is no `env::JSON_*` host import to fall back to.
        // The primitive `JSON.stringify` slice above (#1324) already handles
        // null / undefined / boolean as pure Wasm; everything else
        // (objects, arrays, strings, and all `JSON.parse`) needs the pure-Wasm
        // codec from Phase 2, which is not yet implemented. Emit a clear
        // compile error rather than a module that traps at instantiation.
        if (ctx.standalone || ctx.wasi) {
          reportError(
            ctx,
            expr,
            `Codegen error: JSON.${method} of this value is not yet supported in --target standalone/wasi (#1599). ` +
              `Pure-Wasm JSON.stringify of null/undefined/boolean works standalone; ` +
              `numbers, objects, arrays, strings, and JSON.parse require the Phase 2 pure-Wasm codec (#1599 Phase 2). ` +
              `Avoid JSON for these shapes in standalone/WASI targets for now.`,
          );
          return null;
        }
        const importName = `JSON_${method}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          // Compile first argument and coerce to externref
          const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
          if (argType && argType.kind !== "externref") {
            coerceType(ctx, fctx, argType, { kind: "externref" });
          }
          if (method === "stringify") {
            // Pass replacer (arg 2) and space (arg 3), or null sentinels
            if (expr.arguments.length >= 2) {
              const repType = compileExpression(ctx, fctx, expr.arguments[1]!);
              if (repType && repType.kind !== "externref") {
                coerceType(ctx, fctx, repType, { kind: "externref" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            if (expr.arguments.length >= 3) {
              const spType = compileExpression(ctx, fctx, expr.arguments[2]!);
              if (spType && spType.kind !== "externref") {
                coerceType(ctx, fctx, spType, { kind: "externref" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            // #2013 — `JSON.parse(text, reviver)` §25.5.1: forward the reviver
            // (arg 2) so the host applies InternalizeJSONProperty. A WasmGC
            // closure reviver coerces to externref like any other ref and the
            // host bridges it via `__call_fn_2`; absent → null sentinel (no-op).
            if (expr.arguments.length >= 2) {
              const revType = compileExpression(ctx, fctx, expr.arguments[1]!);
              if (revType && revType.kind !== "externref") {
                coerceType(ctx, fctx, revType, { kind: "externref" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // (#1483) performance.now() under --target wasi → clock_time_get
    // (CLOCK_MONOTONIC). In JS-host mode we leave existing behaviour (declared
    // global) alone so this branch only fires when a WASI helper exists.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "performance" &&
      propAccess.name.text === "now" &&
      ctx.wasi &&
      ctx.funcMap.has("__wasi_performance_now")
    ) {
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__wasi_performance_now")! });
      return { kind: "f64" };
    }

    {
      const temporalStaticResult = tryCompileTemporalStaticCall(ctx, fctx, propAccess, expr);
      if (temporalStaticResult !== undefined) return temporalStaticResult;
    }

    // Handle Date.now() and Date.UTC() — pure Wasm static methods
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Date") {
      const method = propAccess.name.text;
      if (method === "now") {
        // (#1483) Under --target wasi, route to clock_time_get instead of the
        // env::__date_now host import (which wasmtime does not provide).
        if (ctx.wasi && ctx.funcMap.has("__wasi_date_now")) {
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__wasi_date_now")! });
          return { kind: "f64" };
        }
        // (#2164) Pure standalone (--target standalone, no JS host AND no WASI
        // clock) has no wall-clock source, so the env::__date_now host import is
        // unsatisfiable — every module that calls Date.now() (or new Date() with
        // no args) failed to instantiate standalone, breaking unrelated Date
        // tests that only touch Date.now() in setup. Emit the Unix epoch (0)
        // directly: deterministic, no import leak, module instantiates. Tests
        // that construct explicit timestamps (the bulk of the gap) then work;
        // only tests asserting a *real* current time (which standalone WasmGC
        // cannot provide) stay failing — and those need a clock source, not a
        // host import.
        if (ctx.standalone === true) {
          fctx.body.push({ op: "f64.const", value: 0 });
          return { kind: "f64" };
        }
        const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
        if (dateNowIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          fctx.body.push({ op: "call", funcIdx: dateNowIdx });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        return { kind: "f64" };
      }
      if (method === "UTC") {
        // Date.UTC(year, month?, date?, hours?, minutes?, seconds?, ms?) — §21.4.3.4.
        //   1. y = ToNumber(year); each present component is ToNumber'd, else its
        //      default (+0, or 1 for date).
        //   8. If y is NaN, yr = NaN; else yr = MakeFullYear(y): if 0..99, 1900+y.
        //   9. Return TimeClip(MakeDate(MakeDay(yr, m, dt), MakeTime(h,min,s,milli))).
        // A non-finite component, or a |timestamp| > 8.64e15 (TimeClip §21.4.1.14),
        // yields NaN. MakeDay (§21.4.1.12) rolls month overflow into the year:
        // ym = yr + floor(m/12), mn = m modulo 12. This mirrors the proven
        // new Date(y,m,…) constructor path in new-super.ts (#1343); the prior
        // implementation skipped MakeFullYear, the non-finite/TimeClip clamp, the
        // month normalization, and treated a missing year as 1970 instead of NaN.
        const args = expr.arguments;

        // §21.4.3.4 step 1: with no year argument, y = ToNumber(undefined) = NaN,
        // so the whole result is NaN (Date.UTC() ⇒ NaN).
        if (args.length === 0) {
          fctx.body.push({ op: "f64.const", value: NaN });
          return { kind: "f64" };
        }

        const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

        // Non-finite accumulator: OR-in (v !== v) and (|v| > 8.64e15) for every
        // *present* component (a missing arg uses a finite default and never
        // contributes). i64.trunc_sat would otherwise silently clamp NaN/±Inf.
        const nonFiniteLocal = allocTempLocal(fctx, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: nonFiniteLocal });
        const checkNonFinite = (f64Local: number) => {
          fctx.body.push({ op: "local.get", index: nonFiniteLocal });
          fctx.body.push({ op: "local.get", index: f64Local });
          fctx.body.push({ op: "local.get", index: f64Local });
          fctx.body.push({ op: "f64.ne" }); // NaN: v !== v
          fctx.body.push({ op: "i32.or" });
          fctx.body.push({ op: "local.get", index: f64Local });
          fctx.body.push({ op: "f64.abs" });
          fctx.body.push({ op: "f64.const", value: 8.64e15 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          fctx.body.push({ op: "local.set", index: nonFiniteLocal });
        };

        // year → i64 (ToNumber via f64 coercion; non-finite tracked)
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        const yearF64 = allocTempLocal(fctx, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: yearF64 });
        checkNonFinite(yearF64);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        const yearL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: yearL });
        releaseTempLocal(fctx, yearF64);

        // MakeFullYear §21.4.1.27: if 0 ≤ yr ≤ 99, yr += 1900.
        fctx.body.push(
          { op: "local.get", index: yearL },
          { op: "i64.const", value: 0n },
          { op: "i64.ge_s" },
          { op: "local.get", index: yearL },
          { op: "i64.const", value: 99n },
          { op: "i64.le_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: yearL },
              { op: "i64.const", value: 1900n },
              { op: "i64.add" },
              { op: "local.set", index: yearL },
            ],
          },
        );

        // Optional component → i64. A present arg is ToNumber'd + non-finite
        // tracked; an absent arg uses its (finite) default.
        const compilePart = (idx: number, def: bigint): number => {
          if (args.length > idx) {
            compileExpression(ctx, fctx, args[idx]!, { kind: "f64" });
            const f = allocTempLocal(fctx, { kind: "f64" });
            fctx.body.push({ op: "local.tee", index: f });
            checkNonFinite(f);
            releaseTempLocal(fctx, f);
            fctx.body.push({ op: "i64.trunc_sat_f64_s" });
          } else {
            fctx.body.push({ op: "i64.const", value: def });
          }
          const l = allocTempLocal(fctx, { kind: "i64" });
          fctx.body.push({ op: "local.set", index: l });
          return l;
        };

        // month is 0-indexed (default +0). date defaults to 1; the rest to +0.
        const monthL = compilePart(1, 0n);
        const dayL = compilePart(2, 1n);
        const hoursL = compilePart(3, 0n);
        const minutesL = compilePart(4, 0n);
        const secondsL = compilePart(5, 0n);
        const msL = compilePart(6, 0n);

        // MakeDay §21.4.1.12: ym = yr + floor(m/12); mn = m modulo 12. i64.div_s/
        // rem_s truncate toward zero, so adjust for a negative remainder to get the
        // Euclidean floor-div / non-negative modulo. days_from_civil expects a
        // 1..12 civil month, so feed it (mn + 1) and the rolled year.
        const qL = allocTempLocal(fctx, { kind: "i64" });
        const rL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push(
          { op: "local.get", index: monthL },
          { op: "i64.const", value: 12n },
          { op: "i64.div_s" },
          { op: "local.set", index: qL },
          { op: "local.get", index: monthL },
          { op: "i64.const", value: 12n },
          { op: "i64.rem_s" },
          { op: "local.set", index: rL },
          // if (r < 0) { q -= 1; r += 12 }
          { op: "local.get", index: rL },
          { op: "i64.const", value: 0n },
          { op: "i64.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: qL },
              { op: "i64.const", value: 1n },
              { op: "i64.sub" },
              { op: "local.set", index: qL },
              { op: "local.get", index: rL },
              { op: "i64.const", value: 12n },
              { op: "i64.add" },
              { op: "local.set", index: rL },
            ],
          },
          // year += q
          { op: "local.get", index: yearL },
          { op: "local.get", index: qL },
          { op: "i64.add" },
          { op: "local.set", index: yearL },
          // civil month = r + 1  (reuse monthL)
          { op: "local.get", index: rL },
          { op: "i64.const", value: 1n },
          { op: "i64.add" },
          { op: "local.set", index: monthL },
        );
        releaseTempLocal(fctx, rL);
        releaseTempLocal(fctx, qL);

        // ts = days_from_civil(year, civilMonth, day) * 86400000
        //      + h*3600000 + min*60000 + s*1000 + ms
        fctx.body.push(
          { op: "local.get", index: yearL },
          { op: "local.get", index: monthL },
          { op: "local.get", index: dayL },
          { op: "call", funcIdx: daysFromCivilIdx },
          { op: "i64.const", value: 86400000n },
          { op: "i64.mul" },
          { op: "local.get", index: hoursL },
          { op: "i64.const", value: 3600000n },
          { op: "i64.mul" },
          { op: "i64.add" },
          { op: "local.get", index: minutesL },
          { op: "i64.const", value: 60000n },
          { op: "i64.mul" },
          { op: "i64.add" },
          { op: "local.get", index: secondsL },
          { op: "i64.const", value: 1000n },
          { op: "i64.mul" },
          { op: "i64.add" },
          { op: "local.get", index: msL },
          { op: "i64.add" },
        );
        const tsL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: tsL });

        // TimeClip §21.4.1.14: any non-finite component, or |ts| > 8.64e15 ⇒ NaN.
        fctx.body.push(
          { op: "local.get", index: nonFiniteLocal },
          { op: "local.get", index: tsL },
          { op: "f64.convert_i64_s" },
          { op: "f64.abs" },
          { op: "f64.const", value: 8.64e15 },
          { op: "f64.gt" },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [{ op: "f64.const", value: NaN }],
            else: [{ op: "local.get", index: tsL }, { op: "f64.convert_i64_s" }],
          },
        );

        releaseTempLocal(fctx, tsL);
        releaseTempLocal(fctx, msL);
        releaseTempLocal(fctx, secondsL);
        releaseTempLocal(fctx, minutesL);
        releaseTempLocal(fctx, hoursL);
        releaseTempLocal(fctx, dayL);
        releaseTempLocal(fctx, monthL);
        releaseTempLocal(fctx, yearL);
        releaseTempLocal(fctx, nonFiniteLocal);

        return { kind: "f64" };
      }
      // Date.parse(str) — pure-Wasm ISO 8601 parser (#2164). Returns the time
      // value in ms (NaN on parse failure).
      //
      // Gated to standalone / WASI: those targets carry the WasmGC-native string
      // backend (`nativeStrings`), so the flatten + char-scan helper links
      // cleanly. In JS-host mode strings are `wasm:js-string` externrefs and
      // wiring the helper lazily mid-body trips the late-import index-shift class
      // (#2043: "heap type index out of range"); host mode keeps the prior NaN
      // stub (no regression — host Date.parse was always a NaN stub). A follow-up
      // can register __date_parse up-front (like parseInt in index.ts) to extend
      // native parsing to host mode.
      if (method === "parse") {
        // Date.parse() with no args → NaN (§21.4.3.2 — ToString(undefined)).
        if (expr.arguments.length === 0) {
          fctx.body.push({ op: "f64.const", value: NaN });
          return { kind: "f64" };
        }
        // (#2678) HOST mode: delegate to the JS `Date.parse` host import
        // (`__date_parse_host`, registered up-front by collectDateParseHostImports
        // so no mid-body late-import shift / #2043). Host strings are real
        // wasm:js-string externrefs and JS Date.parse is more format-complete than
        // the native ISO parser. Falls back to the prior NaN stub only if the
        // up-front scan somehow missed registering the import.
        if (!ctx.standalone && !ctx.wasi) {
          const hostIdx = ctx.funcMap.get("__date_parse_host");
          if (hostIdx !== undefined) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
            for (let i = 1; i < expr.arguments.length; i++) {
              const t = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (t) fctx.body.push({ op: "drop" });
            }
            fctx.body.push({ op: "call", funcIdx: hostIdx });
            return { kind: "f64" };
          }
          for (const arg of expr.arguments) {
            const t = compileExpression(ctx, fctx, arg);
            if (t) fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "f64.const", value: NaN });
          return { kind: "f64" };
        }
        // Standalone / WASI: pure-Wasm native parser (#2164).
        emitNativeDateParse(ctx);
        const dateParseIdx = ctx.funcMap.get("__date_parse")!;
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        // Evaluate any extra args for side effects, then drop.
        for (let i = 1; i < expr.arguments.length; i++) {
          const t = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (t) fctx.body.push({ op: "drop" });
        }
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__date_parse") ?? dateParseIdx });
        return { kind: "f64" };
      }
    }

    // Check if this is a static method call: ClassName.staticMethod(args)
    if (ts.isIdentifier(propAccess.expression) && ctx.classSet.has(propAccess.expression.text)) {
      const clsName = propAccess.expression.text;
      const methodName = propAccess.name.text;
      const fullName = `${clsName}_${methodName}`;
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)); // (#1983)
        if (funcIdx !== undefined) {
          // No self parameter for static methods
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const staticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
          const calleeReadsArgsEarly = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, staticParamCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          }
          if (expr.arguments.length > staticParamCount) {
            if (calleeReadsArgsEarly) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], staticParamCount);
            } else {
              for (let i = staticParamCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          // Pad missing arguments with defaults
          if (paramTypes) {
            for (let i = expr.arguments.length; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, staticParamCount);
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStaticIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
          fctx.body.push({ op: "call", funcIdx: finalStaticIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStaticIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, finalStaticIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return VOID_RESULT;
        }
      }
    }

    // Check if receiver is an externref object
    let receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
    // (#2767) When the static type resolves NO nominal symbol and the receiver
    // is a bare identifier (the evolving-`any` `var d; d = new Date(0)` case),
    // recover the effective nominal type from the binding's assignments so the
    // nominal-symbol dispatch gates below (Date, DataView, ArrayBuffer, RegExp,
    // wrappers, …) engage instead of falling to the failing generic path.
    if (!receiverType.getSymbol()?.name && ts.isIdentifier(propAccess.expression)) {
      const recovered = resolveAssignedNominalType(ctx, propAccess.expression);
      if (recovered) receiverType = recovered;
    }

    // TextEncoder/TextDecoder under no-JS-host targets. These are standard
    // Web/Node APIs, but WASI/standalone cannot rely on env.TextEncoder_* host
    // imports. Lower the narrow UTF-8 surface natively.
    if ((noJsHost(ctx) || ctx.strictNoHostImports) && ctx.nativeStrings) {
      const recvSym =
        receiverType.getSymbol()?.name ??
        (ts.isNewExpression(propAccess.expression) && ts.isIdentifier(propAccess.expression.expression)
          ? propAccess.expression.expression.text
          : undefined);
      const method = propAccess.name.text;
      if (recvSym === "TextEncoder" && method === "encode") {
        const { encodeIdx, vecTypeIdx } = ensureTextEncodingHelpers(ctx);
        const recvResult = compileExpression(ctx, fctx, propAccess.expression);
        if (recvResult !== null) fctx.body.push({ op: "drop" });
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, nativeStringType(ctx));
        } else {
          compileStringLiteral(ctx, fctx, "");
        }
        for (let i = 1; i < expr.arguments.length; i++) {
          const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extra !== null) fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "call", funcIdx: encodeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      if (recvSym === "TextDecoder" && method === "decode") {
        const { decodeU8Idx, vecTypeIdx } = ensureTextEncodingHelpers(ctx);
        const recvResult = compileExpression(ctx, fctx, propAccess.expression);
        if (recvResult !== null) fctx.body.push({ op: "drop" });
        if (expr.arguments.length === 0) {
          compileStringLiteral(ctx, fctx, "");
          return nativeStringType(ctx);
        }
        const expected: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, expected);
        if (argType && !valTypesMatch(argType, expected)) {
          coerceType(ctx, fctx, argType, expected);
        }
        for (let i = 1; i < expr.arguments.length; i++) {
          const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extra !== null) fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "call", funcIdx: decodeU8Idx });
        return nativeStringType(ctx);
      }
    }

    // Handle Date instance method calls BEFORE extern class dispatch,
    // because Date is declared in lib.d.ts (so isExternalDeclaredClass returns true)
    // but we implement it natively as a WasmGC struct.
    {
      const temporalResult = tryCompileTemporalMethodCall(ctx, fctx, propAccess, expr);
      if (temporalResult !== undefined) return temporalResult;
    }

    {
      const dateResult = compileDateMethodCall(ctx, fctx, propAccess, expr, receiverType);
      if (dateResult !== undefined) return dateResult;
    }

    // Property introspection: hasOwnProperty / propertyIsEnumerable
    // Must be checked BEFORE extern class dispatch so that calls like
    // regexp.hasOwnProperty("x") use the generic handler instead of
    // looking for a non-existent RegExp_hasOwnProperty import.
    if (propAccess.name.text === "hasOwnProperty" || propAccess.name.text === "propertyIsEnumerable") {
      return compilePropertyIntrospection(ctx, fctx, propAccess, expr);
    }

    // #1654 — native DataView accessors in no-JS-host mode. In JS-host mode the
    // runtime materializes a real DataView over the byte array; standalone/WASI
    // has no JS runtime, so emit Wasm-native byte read/write into the i32_byte
    // backing array directly. Must run BEFORE the extern-class dispatch, which
    // would otherwise route DataView_setUint32 to an unsatisfiable host import
    // (or silently drop the call).
    if (noJsHost(ctx) && isDataViewAccessor(propAccess.name.text)) {
      const recvSym = receiverType.getSymbol()?.name;
      if (recvSym === "DataView") {
        const dvResult = emitDataViewAccessor(
          ctx,
          fctx,
          propAccess.name.text,
          propAccess.expression,
          expr.arguments,
          (e, hint) => compileExpression(ctx, fctx, e, hint),
        );
        if (dvResult) {
          if (dvResult.kind === "get") return dvResult.result;
          // (#3173) Setter used as an EXPRESSION (`assert.sameValue(
          // dv.setUint8(0, 1), undefined)` — set-values-return-undefined.js):
          // §24.3.4.* setters return undefined. VOID_RESULT in a value
          // position desyncs the caller's argument stack; hand back the
          // canonical `undefined` singleton instead (null ≠ undefined under
          // strict equality). Statement position keeps the zero-cost
          // VOID_RESULT.
          if (!ts.isExpressionStatement(expr.parent)) {
            // Standalone lowers `undefined` to the null externref (undefined ≡
            // null-extern; `x === undefined` is `ref.is_null` — see
            // `__extern_is_undefined`, object-runtime.ts), so this IS the
            // canonical undefined here.
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
          return VOID_RESULT;
        }
      }
    }

    // #1698 / #1717 — native ArrayBuffer.prototype.slice. The ArrayBuffer
    // backing store is the same `i32_byte` vec struct in BOTH JS-host and
    // standalone modes, so the byte-by-byte copy is mode-agnostic. In JS-host
    // mode `slice` was previously dropped by the extern-class dispatch
    // (`slice is not a function`, #1717); in standalone there is no runtime
    // (#1698). Route both through the same native emitter — emit a byte copy
    // into a fresh i32_byte vec. (SharedArrayBuffer is filtered out: it has no
    // i32_byte struct, so the cast would trap.)
    if (propAccess.name.text === "slice") {
      const recvSym = receiverType.getSymbol()?.name;
      if (recvSym === "ArrayBuffer") {
        const sliceResult = emitArrayBufferSlice(ctx, fctx, propAccess.expression, expr.arguments, (e, hint) =>
          compileExpression(ctx, fctx, e, hint),
        );
        if (sliceResult) return sliceResult;
      }
    }

    // (#3054 C) Native `rab.resize(newByteLength)` in no-JS-host mode. Only a
    // `$__resizable_ab` receiver actually resizes (checked at runtime inside the
    // emitter — a fixed buffer throws TypeError); reallocs the backing array,
    // swaps `data` + `length` in place so shared views observe the new length.
    if (propAccess.name.text === "resize" && noJsHost(ctx)) {
      const recvSym = receiverType.getSymbol()?.name;
      if (recvSym === "ArrayBuffer") {
        emitArrayBufferResize(ctx, fctx, propAccess.expression, expr.arguments, (e, hint) =>
          compileExpression(ctx, fctx, e, hint),
        );
        return VOID_RESULT;
      }
    }

    if (isExternalDeclaredClass(receiverType, ctx.checker)) {
      const externResult = compileExternMethodCall(ctx, fctx, propAccess, expr);
      // undefined means method not found in extern class hierarchy — fall through to generic handlers
      if (externResult !== undefined) return externResult;
    }

    // (#2865) `.next()` on a DRIVEN async-generator object (typed receiver).
    // `next(v)` sent-value delivery + `.throw()`/`.return()` are 3d-iii.
    {
      const recvSymName = receiverType.getSymbol()?.name;
      if (
        propAccess.name.text === "next" &&
        expr.arguments.length === 0 &&
        (recvSymName === "AsyncGenerator" || recvSymName === "AsyncIterableIterator" || recvSymName === "AsyncIterator")
      ) {
        const dispatched = tryEmitAsyncGenNextDispatch(ctx, fctx, propAccess.expression);
        if (dispatched !== null) return dispatched;
      }
    }

    // Generator method calls: gen.next(), gen.return(value), gen.throw(error)
    if (isGeneratorType(receiverType)) {
      const methodName = propAccess.name.text;
      const nativeResult = tryCompileNativeGeneratorMethodCall(
        ctx,
        fctx,
        propAccess.expression,
        methodName,
        expr.arguments,
      );
      if (nativeResult !== undefined) return nativeResult;
      if (methodName === "next") {
        compileExpression(ctx, fctx, propAccess.expression);
        const funcIdx = ctx.funcMap.get("__gen_next");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "return") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (value to return), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_return");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "throw") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (error to throw), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_throw");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      }
    }

    // Handle Promise instance methods: .then(cb1, cb2?), .catch(cb), .finally(cb)
    // Promise values are externref; delegate to host imports registered as LATE
    // imports (during codegen, not collection) to avoid type index corruption (#961).
    // GUARD: Only match when receiver TS type is Promise (prevents routing
    // compiled async function returns through host Promise path — v1 regression)
    {
      const method = propAccess.name.text;
      // (#2903) `.finally` takes the NATIVE §27.2.5.3 lowering only when the
      // module provably cannot mint a HOST promise (or under wasi, whose
      // zero-import contract has no host route at all). Producer modules keep
      // the EXACT legacy host `Promise_finally` lowering — including the
      // async-call fulfilled-wrap in expressions.ts — because their receivers
      // can be host promises the native machinery cannot chain (measured:
      // subclass-`finally` tests pass through the host route only WITH the
      // wrap). Zero-arg `.finally()` is admitted ONLY when the native lowering
      // will consume it; every other lane keeps the historical ≥1-argument
      // gate so its generic paths (and bytes) are untouched.
      const nativeFinallyActive =
        method === "finally" &&
        isStandaloneThenChainNativeActive(ctx) &&
        (ctx.wasi === true || standaloneThenMissArmCanBeNative(ctx));
      if (
        (method === "then" || method === "catch" || method === "finally") &&
        (expr.arguments.length >= 1 || nativeFinallyActive)
      ) {
        const receiverTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
        const recvSym = receiverTsType.getSymbol()?.name;
        const apparentSym = ctx.checker.getApparentType(receiverTsType).getSymbol()?.name;
        const isPromiseReceiver = recvSym === "Promise" || apparentSym === "Promise";

        // (#2865) ANY-typed receiver under ACTIVE native chaining: the value
        // may be a native `$Promise` minted by the driven async-gen machinery
        // (`var f; f = async function*(){…}; f().next().then(cb, $DONE)` — the
        // dominant test262 driving shape holds everything as `any`). Route
        // through the runtime `ref.test` receiver bridge: a native `$Promise`
        // chains natively; a miss keeps the host path under standalone
        // (behavior-preserving — the generic any-path used the same host
        // imports) and yields null under wasi (zero-import contract; a host
        // arm could never succeed there). Only fires when the module has
        // native machinery (`isStandaloneThenChainNativeActive` — wasi, or
        // standalone with the scheduler registered), so every other module is
        // byte-identical.
        if (
          !isPromiseReceiver &&
          (method === "then" || method === "catch" || (method === "finally" && nativeFinallyActive)) &&
          (receiverTsType.flags & ts.TypeFlags.Any) !== 0 &&
          isStandaloneThenChainNativeActive(ctx)
        ) {
          // (#2903) `.finally` on an any-typed receiver takes the same runtime
          // `ref.test $Promise` bridge as `.then`/`.catch` — a native receiver
          // chains through the native §27.2.5.3 lowering; a miss is the native
          // TypeError (null under wasi). Producer modules never reach this arm
          // (`nativeFinallyActive` false) and keep their pre-native generic
          // path.
          if (method === "finally") {
            (ctx.standaloneNativeFinallyNodes ??= new Set()).add(expr);
            emitStandaloneFinallyWithNativeFallback(ctx, fctx, propAccess.expression, expr.arguments[0], {
              nullMiss: ctx.wasi === true,
            });
            return { kind: "externref" };
          }
          emitStandaloneThenWithNativeFallback(
            ctx,
            fctx,
            propAccess.expression,
            method,
            method === "then" ? expr.arguments[0] : undefined,
            method === "then" ? expr.arguments[1] : expr.arguments[0],
            { nullMiss: ctx.wasi === true },
          );
          return { kind: "externref" };
        }

        if (isPromiseReceiver) {
          // (#2980 class 1) `.then` on native chaining. WASI's ZERO-host-
          // import contract for `.then`/`.catch` is load-bearing (#1326/
          // #2895 — `tests/issue-1326.test.ts` asserts the WAT never
          // contains "Promise_then" for `--target wasi`, and instantiates
          // with an EMPTY imports object). So the `ref.test` + host-fallback
          // hardening below is scoped to the NON-wasi case (`ctx.standalone`
          // under the carrier-widen measurement) — the only configuration
          // the #2980 decision measure actually exercises, and one where a
          // host `Promise_then`/`Promise_then2`/`Promise_catch` import is
          // ALREADY the pre-widen fallback for every standalone `.then`
          // receiver (see `isStandaloneThenChainNativeActive`), so making it
          // conditional here introduces no NEW import dependency. WASI keeps
          // the exact original unconditional-cast lowering: no test262
          // corpus item currently reaches a non-native receiver under wasi
          // (the deferred-combinator paths that would produce one already
          // fail to instantiate for their own unrelated missing import), so
          // this preserves WASI's behaviour byte-for-byte.
          if (isStandaloneThenChainNativeActive(ctx) && method === "then") {
            if (ctx.wasi === true) {
              const liveBuffers: Instr[][] = [];
              try {
                const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
                const onFulfilled = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers);
                const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[1], liveBuffers);
                emitStandalonePromiseThen(ctx, fctx, promiseInstrs, onFulfilled, onRejected);
              } finally {
                for (const b of liveBuffers) ctx.liveBodies.delete(b);
              }
            } else {
              emitStandaloneThenWithNativeFallback(
                ctx,
                fctx,
                propAccess.expression,
                "then",
                expr.arguments[0],
                expr.arguments[1],
              );
            }
            return { kind: "externref" };
          }

          // (#2165) Standalone `.catch(onRejected)` ≡ `.then(undefined, onRejected)`
          // per §27.2.5.1. Reuse the native `$Promise` then-machinery so WASI
          // mode doesn't leak the `Promise_catch` / `__make_callback` host
          // imports. The chained promise still propagates a fulfilled receiver
          // unchanged (onFulfilled = null) and routes a rejection through the
          // user's onRejected continuation. (#2980 class 1: same wasi/standalone
          // split as `.then` above.)
          if (isStandaloneThenChainNativeActive(ctx) && method === "catch") {
            if (ctx.wasi === true) {
              const liveBuffers: Instr[][] = [];
              try {
                const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
                const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers);
                emitStandalonePromiseThen(ctx, fctx, promiseInstrs, null, onRejected);
              } finally {
                for (const b of liveBuffers) ctx.liveBodies.delete(b);
              }
            } else {
              emitStandaloneThenWithNativeFallback(
                ctx,
                fctx,
                propAccess.expression,
                "catch",
                undefined,
                expr.arguments[0],
              );
            }
            return { kind: "externref" };
          }

          // (#2903) Native `.finally(onFinally)` — §27.2.5.3 over the native
          // then machinery. Replaces the host `Promise_finally` route (which
          // under the native carrier received a `$Promise` GC struct the host
          // cannot chain: callback silently dropped, reason identity lost —
          // measured broken on main 2026-07-11). WASI takes the direct
          // unconditional-cast lowering (zero-import contract, same shape as
          // `.then`/`.catch` above); standalone takes the receiver bridge.
          // Producer modules (`nativeFinallyActive` false) fall through to the
          // exact legacy host route below.
          if (nativeFinallyActive) {
            (ctx.standaloneNativeFinallyNodes ??= new Set()).add(expr);
            if (ctx.wasi === true) {
              const liveBuffers: Instr[][] = [];
              try {
                const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
                const onFinally = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers);
                emitStandalonePromiseFinally(ctx, fctx, promiseInstrs, onFinally);
              } finally {
                for (const b of liveBuffers) ctx.liveBodies.delete(b);
              }
            } else {
              emitStandaloneFinallyWithNativeFallback(ctx, fctx, propAccess.expression, expr.arguments[0]);
            }
            return { kind: "externref" };
          }

          // Determine import name: use Promise_then2 for .then(cb1, cb2)
          const useThen2 = method === "then" && expr.arguments.length >= 2;
          const importName = useThen2 ? "Promise_then2" : `Promise_${method}`;

          // Register as late import (NOT during collection — #960 fix)
          const paramTypes: ValType[] = useThen2
            ? [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }]
            : [{ kind: "externref" }, { kind: "externref" }];
          let funcIdx =
            ctx.funcMap.get(importName) ?? ensureLateImport(ctx, importName, paramTypes, [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          funcIdx = ctx.funcMap.get(importName) ?? funcIdx;

          if (funcIdx !== undefined) {
            // Compile the Promise value (receiver)
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            // Compile the first callback argument, coercing to externref
            const cbType = compileExpression(ctx, fctx, expr.arguments[0]!, {
              kind: "externref",
            });
            if (cbType && cbType.kind !== "externref") {
              coerceType(ctx, fctx, cbType, { kind: "externref" });
            }
            // For .then(cb1, cb2): compile second callback
            if (useThen2) {
              const cb2Type = compileExpression(ctx, fctx, expr.arguments[1]!, {
                kind: "externref",
              });
              if (cb2Type && cb2Type.kind !== "externref") {
                coerceType(ctx, fctx, cb2Type, { kind: "externref" });
              }
            }
            // Re-lookup funcIdx after compiling args (late imports may shift)
            const finalIdx = ctx.funcMap.get(importName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalIdx });
            return { kind: "externref" };
          }
        }
      }
    }

    // (#1397) Wrapper-object dynamic dispatch on reassigned methods.
    //
    // For wrapper-object receivers (`new String/Number/Boolean(...)`) where
    // `.toString` or `.valueOf` has been reassigned somewhere in the source,
    // skip every static fast-path and route through `__extern_method_call`
    // so the runtime property lookup picks up the override. Required for
    // spec compliance with transferred prototype methods (S15.7.4.2_A4_*,
    // S15.7.4.4_A2_*, S15.6.4.2_A2_*, S15.6.4.3_A2_*):
    //
    //   var s1 = new String();
    //   s1.toString = Number.prototype.toString;
    //   s1.toString();   // spec: TypeError; we used to return s1 itself.
    //
    // Primitives keep the static fast-path — primitives can't have own
    // properties, so `"abc".toString = …` is a no-op and the short-circuit
    // is correct. Wrappers without any matching reassignment in the source
    // also keep the static fast-path (no perf regression for the common
    // case). The reassignment scan is conservative — any
    // `<expr>.<method> = …` anywhere in the source disables the static
    // path for wrappers; that's a narrower hit than Option B (always
    // dynamic) and matches the architect's Option D feasibility study.
    {
      const wrapperMethodName = propAccess.name.text;
      const isWrapperReceiver =
        isStringWrapperType(receiverType) || isNumberWrapperType(receiverType) || isBooleanWrapperType(receiverType);
      if (
        isWrapperReceiver &&
        (wrapperMethodName === "valueOf" || wrapperMethodName === "toString") &&
        expr.arguments.length === 0 &&
        sourceHasMethodReassignment(ctx, propAccess.expression, wrapperMethodName)
      ) {
        const dynResult = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, wrapperMethodName);
        if (dynResult) return dynResult;
      }
    }

    // Handle wrapper type method calls: new Number(x).valueOf(), etc.
    // Since wrapper constructors now return primitives, valueOf() is a no-op identity.
    {
      const wrapperMethodName = propAccess.name.text;
      const recvSymName = receiverType.getSymbol()?.name;
      // Covered cases (the rest stay on their existing paths to avoid regressions):
      //   - String wrapper .valueOf()/.toString() → the internal slot IS a native
      //     string, so __to_primitive returns it directly (no post-processing).
      //   - Number wrapper .valueOf() → internal slot is a boxed number; unbox to f64.
      // Excluded:
      //   - Number wrapper .toString() — the slot is a boxed number, not a string;
      //     it needs the radix-aware numeric ToString lowering, so it falls through.
      //   - Boolean wrappers — the internal slot is a `$__box_boolean_struct`, whose
      //     extraction differs from the boxed-number unbox used here.
      const isWrapperValueAccessor =
        expr.arguments.length === 0 &&
        ((recvSymName === "String" && (wrapperMethodName === "valueOf" || wrapperMethodName === "toString")) ||
          (recvSymName === "Number" && wrapperMethodName === "valueOf") ||
          // #1910 R3 — Boolean wrapper .valueOf() in standalone: the internal
          // slot holds a boxed boolean (`__box_boolean_struct`), recovered by
          // `__to_primitive`; unbox it to the i32 primitive below (§20.3.3.3
          // Boolean.prototype.valueOf returns the [[BooleanData]] slot).
          (recvSymName === "Boolean" && wrapperMethodName === "valueOf"));

      // #2160 — standalone recovery of the wrapper's internal [[PrimitiveValue]]
      // slot. In --target standalone there is no JS host, so `new String(x)` /
      // `new Number(x)` build a native `$Object` carrying the primitive under the
      // reserved FLAG_INTERNAL slot (#1910 S2). The legacy host paths below leak
      // `__unbox_string` (no native impl) and recompile the wrapper as a primitive
      // ValType (which traps / yields the wrong value for a `$Object` receiver).
      // Route through the native `__to_primitive` helper, which reads that slot
      // first (§7.1.1.1), then apply the method's result type. `Number.prototype.
      // toString` with a radix is NOT this path (arguments.length === 0 above), so
      // it falls through to the radix-aware toString lowering. Gated on
      // `ctx.standalone` specifically — WASI keeps the host-import object
      // machinery (the native object-runtime is standalone-only), so it stays on
      // the legacy paths below.
      // (#3175) `Number.prototype.valueOf()` — [[NumberData]] is +0 (§21.1.3).
      // The prototype object has no [[PrimitiveValue]] slot, so the wrapper
      // `__to_primitive`/`__unbox_number` recovery below would yield NaN.
      if (
        recvSymName === "Number" &&
        wrapperMethodName === "valueOf" &&
        expr.arguments.length === 0 &&
        isNumberDotPrototype(fctx, propAccess.expression)
      ) {
        fctx.body.push({ op: "f64.const", value: 0 });
        return { kind: "f64" };
      }

      if (ctx.standalone && isWrapperValueAccessor) {
        ensureObjectRuntime(ctx);
        const toPrimIdx = ctx.funcMap.get("__to_primitive");
        if (toPrimIdx !== undefined) {
          // hint: "string" for toString / String wrapper, "number" for Number
          // valueOf — matches OrdinaryToPrimitive's hint ordering.
          const hint = wrapperMethodName === "toString" || recvSymName === "String" ? "string" : "number";
          compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          addStringConstantGlobal(ctx, hint);
          fctx.body.push(...stringConstantExternrefInstrs(ctx, hint));
          fctx.body.push({ op: "call", funcIdx: toPrimIdx });
          // __to_primitive returns the boxed primitive as externref. String
          // wrappers (and any toString) yield the native string ref directly.
          // Number valueOf yields a boxed number — unbox to the f64 primitive.
          if (wrapperMethodName === "valueOf" && recvSymName === "Number") {
            const unboxNumIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
            flushLateImportShifts(ctx, fctx);
            if (unboxNumIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxNumIdx });
            return { kind: "f64" };
          }
          // #1910 R3 — Boolean wrapper valueOf → boxed boolean in the slot; unbox
          // to the i32 primitive (true→1, false→0).
          if (wrapperMethodName === "valueOf" && recvSymName === "Boolean") {
            const unboxBoolIdx = ensureLateImport(ctx, "__unbox_boolean", [{ kind: "externref" }], [{ kind: "i32" }]);
            flushLateImportShifts(ctx, fctx);
            if (unboxBoolIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxBoolIdx });
            return { kind: "i32" };
          }
          // String wrapper valueOf/toString, or Number wrapper toString → string ref.
          return { kind: "externref" };
        }
      }

      if (recvSymName === "Number" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "f64" });
        return { kind: "f64" };
      }
      if (recvSymName === "String" && wrapperMethodName === "valueOf") {
        // new String("x") now returns a real String wrapper object (externref).
        // valueOf() must extract the primitive string via __unbox_string (#929).
        compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        const unboxIdx = ensureLateImport(ctx, "__unbox_string", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: unboxIdx });
        }
        return { kind: "externref" };
      }
      if (recvSymName === "Boolean" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
        return { kind: "i32" };
      }
    }

    // Check if receiver is a local class instance
    let receiverClassName = receiverType.getSymbol()?.name;
    // Map class expression symbol names to their synthetic names
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    // Fallback for union types, interfaces, abstract classes:
    // When the direct symbol name is not a known class, try to resolve via
    // union members, apparent type, or base types.
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name)
        ? "__priv_" + propAccess.name.text.slice(1)
        : propAccess.name.text;
      // Try union type members: for `A | B`, check each member for a known class
      if (receiverType.isUnion()) {
        for (const memberType of (receiverType as ts.UnionType).types) {
          let memberName = memberType.getSymbol()?.name;
          if (memberName && !ctx.classSet.has(memberName)) {
            memberName = ctx.classExprNameMap.get(memberName) ?? memberName;
          }
          if (memberName && ctx.classSet.has(memberName)) {
            const fullName = `${memberName}_${methodName}`;
            if (ctx.funcMap.has(fullName)) {
              receiverClassName = memberName;
              break;
            }
            // Walk inheritance chain
            let ancestor = ctx.classParentMap.get(memberName);
            while (ancestor) {
              if (ctx.funcMap.has(`${ancestor}_${methodName}`)) {
                receiverClassName = memberName;
                break;
              }
              ancestor = ctx.classParentMap.get(ancestor);
            }
            if (receiverClassName && ctx.classSet.has(receiverClassName)) break;
          }
        }
      }
      // Try apparent type (handles interfaces, abstract classes)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const apparentType = ctx.checker.getApparentType(receiverType);
        if (apparentType !== receiverType) {
          let apparentName = apparentType.getSymbol()?.name;
          if (apparentName && !ctx.classSet.has(apparentName)) {
            apparentName = ctx.classExprNameMap.get(apparentName) ?? apparentName;
          }
          if (apparentName && ctx.classSet.has(apparentName) && ctx.funcMap.has(`${apparentName}_${methodName}`)) {
            receiverClassName = apparentName;
          }
        }
      }
      // Try base types: if the receiver type has base types (e.g. abstract class → concrete class)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const baseTypes = receiverType.getBaseTypes?.();
        if (baseTypes) {
          for (const baseType of baseTypes) {
            let baseName = baseType.getSymbol()?.name;
            if (baseName && !ctx.classSet.has(baseName)) {
              baseName = ctx.classExprNameMap.get(baseName) ?? baseName;
            }
            if (baseName && ctx.classSet.has(baseName) && ctx.funcMap.has(`${baseName}_${methodName}`)) {
              receiverClassName = baseName;
              break;
            }
          }
        }
      }
      // Try struct name from the receiver's wasm type
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const structName = resolveStructName(ctx, receiverType);
        if (structName && ctx.classSet.has(structName) && ctx.funcMap.has(`${structName}_${methodName}`)) {
          receiverClassName = structName;
        }
      }
      // Final fallback: scan all known classes for one that has the method.
      // This handles interface types and abstract classes where we can't determine
      // the implementing class from the type alone. We pick the first class that
      // has the method and whose struct fields are a superset of the receiver type's properties.
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const recvProps = receiverType.getProperties?.() ?? [];
        const recvPropNames = new Set(recvProps.map((p) => p.name));
        for (const className of ctx.classSet) {
          if (!ctx.funcMap.has(`${className}_${methodName}`)) continue;
          // (#3123) Never INFER a fnctor-subclass (`class C extends F`, F a
          // top-level plain function) for an any/unknown-typed receiver: the
          // runtime value may be a HOST object (e.g. an Iterator-helper
          // wrapper minted by F.prototype's live methods), and the static
          // tag-dispatch would run the class method with a null self instead
          // of forwarding to the host object. The any-receiver ladder below
          // (__gen_next/__gen_return/__extern_method_call) dispatches on the
          // runtime value for BOTH host objects and struct instances (the
          // struct arm resolves via _safeGet → __member_kind_* exports).
          if (fnctorAncestorOfClass(ctx, className) !== undefined) continue;
          // Quick heuristic: check that the class has at least the same property names
          // as the interface (structural compatibility check)
          const classFields = ctx.structFields.get(className);
          if (classFields && recvPropNames.size > 0) {
            const classFieldNames = new Set(classFields.map((f) => f.name));
            let compatible = true;
            for (const prop of recvPropNames) {
              // Methods won't be in struct fields, so skip function-typed properties
              const propSymbol = recvProps.find((p) => p.name === prop);
              const propType = propSymbol ? ctx.checker.getTypeOfSymbol(propSymbol) : undefined;
              const isMethod = propType && (propType.getCallSignatures?.()?.length ?? 0) > 0;
              if (!isMethod && !classFieldNames.has(prop)) {
                compatible = false;
                break;
              }
            }
            if (!compatible) continue;
          }
          receiverClassName = className;
          break;
        }
      }
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name)
        ? "__priv_" + propAccess.name.text.slice(1)
        : propAccess.name.text;
      // (#3123) A WIDENED fnctor-subclass binding (`let iterator = new C();
      // iterator = iterator.drop(0)`) may hold a HOST object at runtime — the
      // static tag-dispatch below would guarded-cast it to null and run the
      // class method/getter with a null self. Dispatch member calls on such
      // bindings dynamically: the runtime value (struct instance or host
      // wrapper) decides, via __extern_method_call + the host-side
      // member-kind resolution.
      {
        let recvInner: ts.Expression = propAccess.expression;
        while (
          ts.isParenthesizedExpression(recvInner) ||
          ts.isAsExpression(recvInner) ||
          ts.isNonNullExpression(recvInner)
        ) {
          recvInner = recvInner.expression;
        }
        if (
          ts.isIdentifier(recvInner) &&
          fctx.fnctorWidenedLocals?.has(recvInner.text) &&
          fnctorAncestorOfClass(ctx, receiverClassName) !== undefined
        ) {
          const dynResult = emitFnctorSubclassDynamicMethodCall(ctx, fctx, expr, propAccess, methodName);
          if (dynResult !== undefined) return dynResult;
        }
      }
      let fullName = `${receiverClassName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)); // (#1983)
      // Walk inheritance chain to find the method in a parent class
      if (funcIdx === undefined) {
        let ancestor = ctx.classParentMap.get(receiverClassName);
        while (ancestor && funcIdx === undefined) {
          fullName = `${ancestor}_${methodName}`;
          funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)); // (#1983)
          ancestor = ctx.classParentMap.get(ancestor);
        }
      }
      // Walk child classes (handles abstract class → concrete subclass).
      // (#1299) Collect ALL subclass implementations so we can emit a
      // runtime tag-based dispatch (virtual dispatch) when more than one
      // exists. Without this, a base-typed receiver would unconditionally
      // call the first subclass's method regardless of runtime type.
      let virtualCandidates: { className: string; funcIdx: number; classTag: number }[] | undefined;
      if (funcIdx === undefined) {
        const candidates: { className: string; funcIdx: number; classTag: number }[] = [];
        const baseClass = fullName.split("_")[0];
        for (const [childClass, parentClass] of ctx.classParentMap) {
          if (parentClass === receiverClassName || parentClass === baseClass) {
            const childFullName = `${childClass}_${methodName}`;
            const childFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, childFullName)); // (#1983)
            const childTag = ctx.classTagMap.get(childClass);
            if (childFuncIdx !== undefined && childTag !== undefined) {
              candidates.push({ className: childClass, funcIdx: childFuncIdx, classTag: childTag });
            }
          }
        }
        if (candidates.length === 1) {
          fullName = `${candidates[0]!.className}_${methodName}`;
          funcIdx = candidates[0]!.funcIdx;
        } else if (candidates.length > 1) {
          virtualCandidates = candidates;
          fullName = `${candidates[0]!.className}_${methodName}`;
          funcIdx = candidates[0]!.funcIdx;
        }
      } else {
        // Method exists on receiver class — also check for subclass overrides.
        const candidates: { className: string; funcIdx: number; classTag: number }[] = [];
        const recvTag = ctx.classTagMap.get(receiverClassName);
        if (recvTag !== undefined) {
          candidates.push({ className: receiverClassName, funcIdx, classTag: recvTag });
        }
        for (const [childClass, parentClass] of ctx.classParentMap) {
          // Walk full ancestry to capture transitive subclasses.
          let cur: string | undefined = parentClass;
          while (cur) {
            if (cur === receiverClassName) break;
            cur = ctx.classParentMap.get(cur);
          }
          if (cur === receiverClassName && childClass !== receiverClassName) {
            const childFullName = `${childClass}_${methodName}`;
            const childFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, childFullName)); // (#1983)
            const childTag = ctx.classTagMap.get(childClass);
            if (
              childFuncIdx !== undefined &&
              childTag !== undefined &&
              !candidates.some((c) => c.className === childClass)
            ) {
              candidates.push({ className: childClass, funcIdx: childFuncIdx, classTag: childTag });
            }
          }
        }
        if (candidates.length > 1) {
          virtualCandidates = candidates;
        }
      }
      // Early intercept: emit virtual dispatch (tag-comparison cascade,
      // same pattern as `instanceof`) if multiple candidates exist.
      if (virtualCandidates && virtualCandidates.length > 1) {
        const vresult = emitVirtualMethodDispatchByTag(
          ctx,
          fctx,
          expr,
          propAccess,
          virtualCandidates,
          receiverClassName,
        );
        if (vresult !== undefined) return vresult;
      }
      // If no method found, check if the property is a callable struct field
      // (e.g. this.callback() where callback is a function-typed property)
      if (funcIdx === undefined) {
        const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, receiverClassName);
        if (callablePropResult !== undefined) return callablePropResult;
      }
      // If still no method, check if this is a getter that returns a callable.
      // Pattern: c.method(args) where `method` is a getter returning a function ref.
      // We call the getter first, then invoke the returned callable.
      if (funcIdx === undefined) {
        const getterName = `${receiverClassName}_get_${methodName}`;
        const getterIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName)); // (#1983)
        if (getterIdx !== undefined) {
          const getterCallResult = compileGetterCallable(ctx, fctx, expr, propAccess, receiverClassName, getterIdx);
          if (getterCallResult !== undefined) return getterCallResult;
        }
      }
      // Object.prototype fallback for known class instances (#799 WI1):
      // When no method found on the class or its ancestors, check if the method
      // is an Object.prototype method and delegate to the host via externref.
      if (funcIdx === undefined) {
        const objProtoResult = compileObjectPrototypeFallback(
          ctx,
          fctx,
          expr,
          propAccess,
          receiverClassName,
          methodName,
        );
        if (objProtoResult !== undefined) return objProtoResult;
      }
      // (#3123) Method MISS on a fnctor-subclass (`class C extends F`, F a
      // top-level plain function): the method may live on F's LIVE
      // `.prototype` — assigned at RUNTIME (module init; the test262 harness
      // `Iterator` shim installs the ES2025 Iterator-helper prototype there),
      // which no static dispatch can see. Route through the generic
      // `__extern_method_call` host ladder (the ctor registered the instance
      // in `_fnctorInstanceCtor`, so the host resolves the member through the
      // live prototype chain) instead of falling to the graceful-null tail.
      if (funcIdx === undefined && fnctorAncestorOfClass(ctx, receiverClassName) !== undefined) {
        const dynResult = emitFnctorSubclassDynamicMethodCall(ctx, fctx, expr, propAccess, methodName);
        if (dynResult !== undefined) return dynResult;
      }
      if (funcIdx !== undefined) {
        const isStaticMethod = ctx.staticMethodSet.has(fullName);
        // Static methods: evaluate receiver for side effects, drop, call directly
        if (isStaticMethod) {
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType !== null) {
            fctx.body.push({ op: "drop" });
          }
          // Re-resolve funcIdx after receiver compilation — emitUndefined (for `this` in static
          // context) triggers addUnionImports which shifts all function indices (#998)
          const resolvedStaticIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
          const paramTypes = getFuncParamTypes(ctx, resolvedStaticIdx);
          const paramCount = paramTypes ? paramTypes.length : expr.arguments.length;
          const calleeReadsArgsStatic = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          }
          if (expr.arguments.length > paramCount) {
            if (calleeReadsArgsStatic) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], paramCount);
            } else {
              for (let i = paramCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          if (paramTypes) {
            for (let i = expr.arguments.length; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, paramCount);
          const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? resolvedStaticIdx; // (#1983)
          fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return VOID_RESULT;
        }
        // Push self (the receiver) as first argument, with type hint from method's first param
        const methodParamTypes0 = getFuncParamTypes(ctx, funcIdx);
        // (#2132) A method call on a statically-nullable receiver (`C | null`,
        // incl. when laundered through `as any`) must throw a CATCHABLE
        // TypeError on null, not a bare `ref.as_non_null` trap (Wasm null-deref
        // traps bypass the module's exception tags and abort uncatchably).
        // Detect nullability from the static type here, because the param-0 type
        // hint passed to compileExpression below can coerce the value to a
        // non-null `ref` and hide it from the `recvType.kind === "ref_null"`
        // guard further down.
        const NULL_OR_UNDEF = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
        const typeIsMaybeNull = (t: ts.Type): boolean =>
          (t.flags & NULL_OR_UNDEF) !== 0 ||
          (t.isUnion?.() === true && t.types.some((u) => (u.flags & NULL_OR_UNDEF) !== 0));
        // Peel `as`/`!`/parens so `(c as any)` / `c!` reveal the underlying
        // declared nullability — `as any` launders Null out of the static type,
        // so checking only the cast expression's own type would miss it (#2132).
        let receiverInner: ts.Expression = propAccess.expression;
        while (
          ts.isAsExpression(receiverInner) ||
          ts.isNonNullExpression(receiverInner) ||
          ts.isParenthesizedExpression(receiverInner) ||
          ts.isTypeAssertionExpression(receiverInner)
        ) {
          receiverInner = (
            receiverInner as ts.AsExpression | ts.NonNullExpression | ts.ParenthesizedExpression | ts.TypeAssertion
          ).expression;
        }
        const receiverMaybeNull =
          typeIsMaybeNull(ctx.checker.getTypeAtLocation(propAccess.expression)) ||
          typeIsMaybeNull(ctx.checker.getTypeAtLocation(receiverInner));
        // (#2132) When the receiver may be null, pass a NULLABLE param-0 hint (or
        // none) so compileExpression keeps the value nullable on the stack — a
        // non-null `ref` hint makes coerceType emit `ref.as_non_null`, which
        // would trap on null BEFORE the guard below can throw a catchable
        // TypeError. The `ref_null` guard further down re-asserts non-null only
        // on the non-null branch.
        const recvHint0: ValType | undefined =
          receiverMaybeNull && methodParamTypes0?.[0]?.kind === "ref"
            ? { kind: "ref_null", typeIdx: (methodParamTypes0[0] as { typeIdx: number }).typeIdx }
            : methodParamTypes0?.[0];
        let recvType = compileExpression(ctx, fctx, propAccess.expression, recvHint0);
        // Track whether receiver went through emitGuardedRefCast — if so, null
        // means "wrong struct type" (not genuinely null), so we should NOT throw
        // TypeError on null after cast.
        let receiverWasCast = false;
        // (#2132) If the receiver is statically nullable but compiled to a
        // non-null `ref` (e.g. via `as any`), force `ref_null` so the null-guard
        // below fires and throws a catchable TypeError instead of trapping.
        if (
          receiverMaybeNull &&
          recvType &&
          recvType.kind === "ref" &&
          (recvType as { typeIdx?: number }).typeIdx !== undefined
        ) {
          recvType = { kind: "ref_null", typeIdx: (recvType as { typeIdx: number }).typeIdx };
        }
        // If receiver is externref but the method expects a struct ref, coerce
        if (recvType && recvType.kind === "externref") {
          const structTypeIdx = ctx.structMap.get(receiverClassName);
          if (structTypeIdx !== undefined) {
            // Check for null BEFORE the guarded cast — only genuine null should throw TypeError
            emitNullCheckThrow(ctx, fctx, { kind: "externref" });
            fctx.body.push({ op: "any.convert_extern" });
            emitGuardedRefCast(fctx, structTypeIdx);
            recvType = { kind: "ref_null", typeIdx: structTypeIdx };
            receiverWasCast = true;
          }
        }
        // Null-guard: if receiver is ref_null, check for null before calling method
        if (recvType && recvType.kind === "ref_null") {
          // Determine return type early so we can build null-guard
          const sig = ctx.checker.getResolvedSignature(expr);
          let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (!isEffectivelyVoidReturn(ctx, retType, fullName))
              callReturnType = brandExternMethodResult(
                ctx,
                retType,
                getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
              );
          }
          const tmp = allocLocal(fctx, `__ng_recv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.tee", index: tmp });
          fctx.body.push({ op: "ref.is_null" });

          // Build the else branch (non-null path) with the full call
          const savedBody = pushBody(fctx);
          fctx.body.push({ op: "local.get", index: tmp });
          fctx.body.push({ op: "ref.as_non_null" });
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          // Coerce receiver (self param) if ref type doesn't match function's first param
          if (paramTypes?.[0]) {
            const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
            if (!valTypesMatch(recvRefType, paramTypes[0])) {
              coerceType(ctx, fctx, recvRefType, paramTypes[0]);
            }
          }
          // User-visible param count excludes self (param 0)
          const ngParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          const calleeReadsArgsNg = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, ngParamCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
          }
          if (expr.arguments.length > ngParamCount) {
            if (calleeReadsArgsNg) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], ngParamCount);
            } else {
              for (let i = ngParamCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          if (paramTypes) {
            for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, ngParamCount);
          const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
          fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
          const elseInstrs = fctx.body;
          fctx.body = savedBody;

          if (callReturnType === VOID_RESULT) {
            // Void method: if null after cast, skip (wrong type); if genuinely null, throw TypeError
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: receiverWasCast ? [] : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return VOID_RESULT;
          } else {
            const resultType: ValType =
              callReturnType.kind === "ref"
                ? { kind: "ref_null", typeIdx: (callReturnType as any).typeIdx }
                : callReturnType;
            // throw is divergent, so the then branch is valid without producing a value
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: resultType },
              then: receiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return resultType;
          }
        }
        // Non-nullable receiver: emit call directly.
        // User-visible param count excludes self (param 0). Clamp to ≥ 0 —
        // when funcMap indirectly points at a stale index (e.g. a zero-arg
        // constructor entry that wasn't shifted after a late import), the
        // raw `length - 1` would go negative and the `for` loop would read
        // `expr.arguments[-1]` → undefined → "unexpected undefined AST node".
        // Seen in tests that mix static + instance private methods under
        // the #1162 yield* async-generator cluster.
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const methodParamCount = paramTypes ? Math.max(0, paramTypes.length - 1) : expr.arguments.length;
        const calleeReadsArgsNn = ctx.funcUsesArguments.has(fullName);
        for (let i = 0; i < Math.min(expr.arguments.length, methodParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
        }
        if (expr.arguments.length > methodParamCount) {
          if (calleeReadsArgsNn) {
            emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], methodParamCount);
          } else {
            for (let i = methodParamCount; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
        }
        // Pad missing arguments with defaults (skip self param at index 0)
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        // Set __argc before the call so the callee knows the actual arg count
        maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, methodParamCount);
        // Re-lookup funcIdx: argument compilation may trigger addUnionImports
        const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
        fctx.body.push({ op: "call", funcIdx: finalMethodIdx });

        // Determine return type
        const sig = ctx.checker.getResolvedSignature(expr);
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
          return brandExternMethodResult(
            ctx,
            retType,
            getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType),
          );
        }
        return VOID_RESULT;
      }
    }

    // Check if receiver is a struct type (e.g. object literal with methods)
    {
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const methodName = propAccess.name.text;
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        // If no method found, check callable property on struct
        if (funcIdx === undefined) {
          const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, structTypeName);
          if (callablePropResult !== undefined) return callablePropResult;
        }
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument, with type hint from method's first param
          const structMethodPTypes = getFuncParamTypes(ctx, funcIdx);
          const recvType = compileExpression(ctx, fctx, propAccess.expression, structMethodPTypes?.[0]);
          // Check if receiver went through emitGuardedRefCast — null may mean
          // "wrong struct type" rather than genuinely null (#789)
          const smReceiverWasCast = (fctx as any).__lastGuardedCastBackup !== undefined;
          // Module globals produce ref_null but method params expect ref — null-guard
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName))
                callReturnType = brandExternMethodResult(
                  ctx,
                  retType,
                  getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
                );
            }
            const tmp = allocLocal(fctx, `__ng_srecv_${fctx.locals.length}`, recvType);
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" });
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            // Coerce receiver (self param) if ref type doesn't match function's first param
            if (paramTypes?.[0]) {
              const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
              if (!valTypesMatch(recvRefType, paramTypes[0])) {
                coerceType(ctx, fctx, recvRefType, paramTypes[0]);
              }
            }
            const smMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
            const calleeReadsArgsSm = ctx.funcUsesArguments.has(fullName);
            for (let i = 0; i < Math.min(expr.arguments.length, smMethodParamCount); i++) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            }
            if (expr.arguments.length > smMethodParamCount) {
              if (calleeReadsArgsSm) {
                emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], smMethodParamCount);
              } else {
                for (let i = smMethodParamCount; i < expr.arguments.length; i++) {
                  const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
            }
            if (paramTypes) {
              for (let i = Math.min(expr.arguments.length, smMethodParamCount) + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            // Set __argc before the call so the callee knows the actual arg count
            maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, smMethodParamCount);
            const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              // Void method: if null after cast, skip (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: smReceiverWasCast ? [] : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType =
                callReturnType.kind === "ref"
                  ? {
                      kind: "ref_null",
                      typeIdx: (callReturnType as any).typeIdx,
                    }
                  : callReturnType;
              // throw is divergent, valid without producing a value (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: smReceiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const nnMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          const calleeReadsArgsNns = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, nnMethodParamCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
          }
          if (expr.arguments.length > nnMethodParamCount) {
            if (calleeReadsArgsNns) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], nnMethodParamCount);
            } else {
              for (let i = nnMethodParamCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, nnMethodParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, nnMethodParamCount);
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStructMethodIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, finalStructMethodIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return VOID_RESULT;
        }
      }
    }

    // (#2903 R4b) Standalone DIRECT-carrier packed-integer typed-array
    // `map`/`filter` → the native `__ta_map_*`/`__ta_filter_*` typed-RESULT
    // helper, BEFORE the array-methods.ts path (whose standalone packed-carrier
    // arm is the same `__make_callback` no-op stub the R4 scalar HOFs hit). The
    // helper allocates a fresh same-kind packed `$__vec_<kind>` carrier and
    // drives the callback host-free via `__apply_closure`. Returns the vec ref
    // directly so the statically-typed result binding (`const b: Uint8Array =
    // a.map(...)`) matches and reads element-correctly. `Uint8ClampedArray`
    // (#2903 R4c) routes here too but through the `clamp` helper variant
    // (round-half-to-even store). Float views + `any`-held receivers are still
    // excluded (see the view set / the R4b/R4c notes).
    if (
      ctx.standalone &&
      (propAccess.name.text === "map" || propAccess.name.text === "filter") &&
      expr.arguments.length >= 1 &&
      !expr.arguments.some((a) => ts.isSpreadElement(a))
    ) {
      const viewName = receiverType.getSymbol?.()?.getName?.();
      // (#2903 R4c) `Uint8ClampedArray` shares the `i8_byte` carrier but stores
      // via ToUint8Clamp (round-half-to-even), not the width-truncation the other
      // integer views use → a DISTINCT clamp helper (`clamp` flag below).
      const isClamped = viewName === "Uint8ClampedArray";
      if (viewName !== undefined && (STANDALONE_TA_MAPFILTER_PACKED_VIEWS.has(viewName) || isClamped)) {
        const methodName = propAccess.name.text as "map" | "filter";
        const storage = typedArrayVecStorage(ctx, viewName);
        const vecTypeIdx = getOrRegisterVecType(ctx, storage.key, storage.type);
        const helperIdx = ensureTaMapFilterHelper(ctx, methodName, vecTypeIdx, isClamped);
        if (helperIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          // Receiver → externref.
          const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
          else if (recvT === null) fctx.body.push({ op: "ref.null.extern" });
          // Callback (arg0) → WasmGC closure struct (not __make_callback).
          const cbArg = expr.arguments[0]!;
          if (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)) {
            const at = compileArrowAsClosure(ctx, fctx, cbArg);
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
          } else {
            const at = compileExpression(ctx, fctx, cbArg, { kind: "externref" });
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
          }
          // thisArg (arg1) → externref, or undefined-sentinel null.
          if (expr.arguments.length >= 2) {
            const tt = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
            if (tt && tt.kind !== "externref") coerceType(ctx, fctx, tt, { kind: "externref" });
            else if (tt === null) fctx.body.push({ op: "ref.null.extern" });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: helperIdx });
          return { kind: "ref", typeIdx: vecTypeIdx };
        }
      }
    }

    // (#2903 R4) Standalone DIRECT-carrier typed-array SCALAR callback HOFs
    // (find/findIndex/…/forEach/some/every/reduce) → the native
    // `__call_m_<name>_<arity>` / `__hof_<name>` substrate, BEFORE the
    // array-methods.ts path. On main the standalone typed-array externref arm in
    // `compileArrayMethodCall` is a `__make_callback` no-op STUB (banked at
    // array-methods.ts ~"BANKED … the callback methods … → env.__make_callback"
    // as "a separate follow-up") — it leaks `env.__make_callback` (breaking
    // host-free instantiation) and never runs the predicate. The closed-method
    // dispatcher's `$__vec_base` HOF arm drives the callback via `__apply_closure`
    // on a WasmGC closure struct (host-free), reading elements through the
    // byte-carrier-aware `__extern_get_idx` (this PR). Only DIRECT carriers reach
    // here; the dynamic-view (`$__ta_dyn_view`) shape keeps its own #3058/#3162
    // path in array-methods.ts (disjoint receiver). map/filter (typed-RESULT)
    // deferred to R4b. Standalone-gated → gc/wasi byte-identical.
    if (ctx.standalone && STANDALONE_TA_SCALAR_HOFS.has(propAccess.name.text)) {
      // A concrete typed-array receiver carries its view name directly on the
      // type symbol (the known-element-kind shape this interception targets).
      const taName = receiverType.getSymbol?.()?.getName?.();
      const hasSpread = expr.arguments.some((a) => ts.isSpreadElement(a));
      const dispatchArgs = hasSpread ? flattenCallArgs(expr.arguments) : [...expr.arguments];
      if (
        taName !== undefined &&
        isWiredTypedArrayViewName(taName) &&
        dispatchArgs !== null &&
        dispatchArgs.length >= 1
      ) {
        const methodName = propAccess.name.text;
        const arity = dispatchArgs.length;
        const dispatchIdx = reserveClosedMethodDispatch(ctx, methodName, arity);
        flushLateImportShifts(ctx, fctx);
        // Receiver → externref.
        const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
        else if (recvT === null) fctx.body.push({ op: "ref.null.extern" });
        // Args → externref; an INLINE arrow/function callback compiles as a raw
        // WasmGC closure struct (crossing as externref) — NOT the host
        // `__make_callback` bridge — so the dispatcher's HOF arm can drive it via
        // `__apply_closure` (same rep an identifier-held callback crosses with).
        for (const arg of dispatchArgs) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            const at = compileArrowAsClosure(ctx, fctx, arg);
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
          } else {
            const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
          }
        }
        fctx.body.push({ op: "call", funcIdx: dispatchIdx });
        return { kind: "externref" };
      }
    }

    // Array method calls
    {
      const arrMethodResult = compileArrayMethodCall(
        ctx,
        fctx,
        propAccess,
        expr,
        receiverType,
        undefined,
        expectedType,
      );
      if (arrMethodResult !== undefined) return arrMethodResult;
    }

    // Primitive method calls: number.toString(), number.toFixed()
    if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toString") {
      // RangeError: if radix argument is provided, must be integer 2-36
      // Also captures the validated, floored radix in `radixLocalIdx` so it can
      // be passed to the 2-arg `number_toString_radix` host import below (#1321).
      let radixLocalIdx: number | undefined;
      // (#3175) §21.1.3.6 step 2: an `undefined` radix means base 10 — the
      // ToIntegerOrInfinity/range-check (steps 3-4) is skipped entirely, so
      // `(5).toString(undefined)` is `"5"`, NOT a RangeError. A literal
      // `undefined` / `void 0` argument would otherwise floor to NaN and hit
      // the NaN→RangeError guard (or trap on the externref→f64 coercion). Treat
      // it as the 0-arg (default base-10) case.
      const radixArg = expr.arguments.length > 0 ? expr.arguments[0]! : undefined;
      const radixArgIsUndefined =
        radixArg !== undefined &&
        ((ts.isIdentifier(radixArg) && radixArg.text === "undefined") ||
          (ts.isVoidExpression(radixArg) && ts.isNumericLiteral(radixArg.expression)));
      if (radixArg !== undefined && !radixArgIsUndefined) {
        compileExpression(ctx, fctx, radixArg, { kind: "f64" });
        // Floor the radix (ToInteger semantics: NaN→0, 2.5→2, etc.)
        fctx.body.push({ op: "f64.floor" });
        radixLocalIdx = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: radixLocalIdx });
        // Check radix < 2 (also catches NaN since NaN < 2 after floor(NaN)=NaN is still false)
        fctx.body.push({ op: "f64.const", value: 2 });
        fctx.body.push({ op: "f64.lt" });
        // Check radix > 36
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.const", value: 36 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        // Check radix is NaN (NaN != NaN)
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          // (#3175) Throw a real RangeError INSTANCE so the raw-`try`/`catch` +
          // `assert(e instanceof RangeError)` corpus passes (not a bare string).
          const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
          const throwInstrs = buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: throwInstrs,
            else: [],
          });
        }
        // radix was consumed by the validation comparisons above (via local.tee);
        // the original (floored) value is preserved in radixLocalIdx for the call.
      }
      // (#2160 number-wrapper) Recover the f64 receiver — primitive directly, or
      // a standalone `new Number(x)` wrapper via __to_primitive/__unbox_number.
      emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
      // #1321: when a radix was provided, route to the 2-arg host import that
      // actually uses it. The legacy 1-arg `number_toString` only handled base 10
      // and silently dropped the radix — `(255).toString(16)` returned "255".
      // #1335: in standalone / WASI (nativeStrings) mode the native
      // number_toString[_radix] helpers return an externref that wraps a
      // `$NativeString`. Downstream string consumers (`.charAt`, `+`, return)
      // coerce externref→native via `any.convert_extern` + `ref.cast`; if we
      // report the value type as `externref` here, a consumer that ALSO
      // unwraps applies a SECOND `any.convert_extern` to the already-native
      // ref ("any.convert_extern expected externref, found native ref"). Unwrap
      // once at the call site and report the native string type so consumers
      // see a native receiver directly. JS-host mode keeps the externref.
      const unwrapToNative = ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && (ctx.standalone || ctx.wasi);
      if (radixLocalIdx !== undefined) {
        const radixFuncIdx = ctx.funcMap.get("number_toString_radix");
        if (radixFuncIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: radixLocalIdx });
          fctx.body.push({ op: "call", funcIdx: radixFuncIdx });
          if (unwrapToNative) {
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
            return nativeStringType(ctx);
          }
          return { kind: "externref" };
        }
      }
      const funcIdx = ctx.funcMap.get("number_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        if (unwrapToNative) {
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
          return nativeStringType(ctx);
        }
        return { kind: "externref" };
      }
    }
    // (#2160) Number.prototype.toLocaleString() with no arguments, STANDALONE/
    // WASI only. Without ECMA-402 the result equals ToString(value) base 10
    // (§21.1.3.4), so route it to the same `number_toString` lowering as the
    // 0-arg `.toString()` arm above. This removes the standalone/WASI
    // `__extern_toLocaleString` dynamic-shape refusal (a host-only import with
    // no native fallback). Host (gc) mode is intentionally excluded: it keeps
    // the `__extern_toLocaleString` path below for real Intl grouping. A call
    // WITH a locale argument also falls through to that host path.
    if (
      (ctx.standalone || ctx.wasi) &&
      isNumberMethodReceiver(ctx, receiverType) &&
      propAccess.name.text === "toLocaleString" &&
      expr.arguments.length === 0
    ) {
      // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
      emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
      const funcIdx = ctx.funcMap.get("number_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        const unwrapToNative = ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && (ctx.standalone || ctx.wasi);
        if (unwrapToNative) {
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
          return nativeStringType(ctx);
        }
        return { kind: "externref" };
      }
    }
    // (#1644 Slice D) BigInt.prototype.toString — bigint receivers cross the
    // boundary as i64. Mirror the number branch: validate radix range (2-36),
    // throw RangeError otherwise, then call bigint_toString_radix (or the
    // 1-arg bigint_toString for the default radix-10 case).
    if (isBigIntType(receiverType) && propAccess.name.text === "toString") {
      let radixLocalIdx: number | undefined;
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        fctx.body.push({ op: "f64.floor" });
        radixLocalIdx = allocLocal(fctx, `__bi_radix_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: radixLocalIdx });
        fctx.body.push({ op: "f64.const", value: 2 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.const", value: 36 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
            else: [],
          });
        }
      }
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "i64.extend_i32_s" });
      }
      if (radixLocalIdx !== undefined) {
        const radixFuncIdx = ctx.funcMap.get("bigint_toString_radix");
        if (radixFuncIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: radixLocalIdx });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          fctx.body.push({ op: "call", funcIdx: radixFuncIdx });
          return { kind: "externref" };
        }
      }
      const funcIdx = ctx.funcMap.get("bigint_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // (#2163) Symbol.prototype.toString / valueOf on a symbol-typed receiver.
    // The symbol value is a bare i32 counter id; without a dedicated handler the
    // generic .toString() fallback drops the id and emits "[object Object]" via a
    // string-constant global that, in native-strings/standalone mode, resolves to
    // the -1 sentinel (the late-import index-shift CE, #2043). In native-strings
    // mode build the spec descriptive string natively (§20.4.3.3.1
    // SymbolDescriptiveString → "Symbol(" + (desc ?? "") + ")") with zero host
    // imports; valueOf returns the symbol primitive (the i32 id) itself.
    if (isSymbolType(receiverType)) {
      const method = propAccess.name.text;
      if (method === "valueOf" && expr.arguments.length === 0) {
        // Symbol.prototype.valueOf() → the symbol primitive itself (i32 id).
        return compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
      }
      if (method === "toString" && expr.arguments.length === 0 && ctx.nativeStrings) {
        const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
        if (recvType && recvType.kind !== "i32") {
          coerceType(ctx, fctx, recvType, { kind: "i32" });
        }
        emitSymbolToString(ctx, fctx);
        return nativeStringType(ctx);
      }
      // (#3085) Host mode: box the symbol id to a JS Symbol and route through the
      // host SymbolDescriptiveString (§20.4.3.3). Without this the generic
      // `.toString()` fallback drops the id and emits "[object Object]". Mirrors
      // the `.description` host path (property-access.ts); the native-strings path
      // above is the standalone fallback.
      if (method === "toString" && expr.arguments.length === 0 && !ctx.nativeStrings) {
        const symToStrIdx = ensureLateImport(
          ctx,
          "__symbol_to_string",
          [{ kind: "externref" }],
          [{ kind: "externref" }],
        );
        if (symToStrIdx !== undefined) {
          const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvType && recvType.kind !== "externref") {
            coerceType(ctx, fctx, recvType, { kind: "externref" });
          }
          flushLateImportShifts(ctx, fctx);
          fctx.body.push({ op: "call", funcIdx: symToStrIdx });
          return { kind: "externref" };
        }
      }
    }

    if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toFixed") {
      // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
      emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
      // Compile the digits argument (default 0)
      if (expr.arguments.length > 0) {
        // ToInteger(fractionDigits) begins with ToNumber (§21.1.3.3 step 4).
        // A non-f64 argument (externref/ref, e.g. a Symbol) must funnel through
        // ToNumber, which throws TypeError on Symbol; coerce to f64 here so the
        // subsequent f64 local.tee is type-correct and Symbols throw (#1564).
        coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
        // RangeError: fractionDigits must be 0-100
        const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: digitsLocal });
        // (#3175) §21.1.3.3 step 1: f = ToIntegerOrInfinity(fractionDigits),
        // which TRUNCATES toward zero (then maps NaN → 0). This must run BEFORE
        // the [0,100] RangeError gate: `(5).toFixed(-0.1)` truncates to -0 (in
        // range → "5"), NOT RangeError; `(5).toFixed(1.9)` truncates to 1. And a
        // NaN/non-numeric-string count (`(5).toFixed(NaN)` / `.toFixed("x")`)
        // maps to 0 — without normalisation NaN reaches the native
        // `number_toFixed`, whose `i32.trunc_f64_s(NaN)` traps ("float
        // unrepresentable in integer range"). Mirrors the toPrecision arm's
        // ToIntegerOrInfinity handling.
        fctx.body.push({ op: "local.get", index: digitsLocal });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: digitsLocal });
        normalizeNaNToZero(fctx, digitsLocal);
        // Check digits < 0
        fctx.body.push({ op: "local.get", index: digitsLocal });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check digits > 100
        fctx.body.push({ op: "local.get", index: digitsLocal });
        fctx.body.push({ op: "f64.const", value: 100 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          // (#3175) Real RangeError INSTANCE (see the toString radix gate).
          const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
          const throwInstrs = buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: throwInstrs,
            else: [],
          });
        }
        fctx.body.push({ op: "local.get", index: digitsLocal });
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      const funcIdx = ctx.funcMap.get("number_toFixed");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    // number.toPrecision(precision)
    if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toPrecision") {
      // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
      emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
      // (#3078) §21.1.3.5 step 2: an explicit `undefined` precision is
      // spec-equivalent to no argument → `return ! ToString(x)`. It is NOT
      // ToIntegerOrInfinity(undefined)=0 (which would trip the [1,100] RangeError
      // gate). undefined and NaN both compile to f64 NaN, so they are
      // indistinguishable at the value site — route the STATIC undefined literal
      // to the no-arg branch (NaN sentinel) at the AST level.
      // test262 toPrecision/undefined-precision-arg.js.
      if (expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
        // (#49) Spec §21.1.3.5 step 4 says: if x is non-finite, return
        // Number::toString(x) BEFORE the precision range check. Save the
        // receiver into a local, check finiteness, and only run the
        // range check when x is finite. Non-finite v with bad precision
        // (e.g. `(NaN).toPrecision(Infinity)`) must return "NaN" not
        // throw RangeError.
        const recvLocalP = allocLocal(fctx, `__toPrecision_recv_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: recvLocalP });
        // ToNumber(precision) funnel — Symbol args must throw TypeError (#1564).
        coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
        const precLocal = allocLocal(fctx, `__toPrecision_prec_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: precLocal });

        // (#1735) §21.1.3.5 step 5: p = ToIntegerOrInfinity(precision), NaN → 0.
        // The `number_toPrecision` runtime helper uses NaN as its "no precision
        // supplied" sentinel, so an explicit NaN precision (`(1).toPrecision(NaN)`)
        // must be normalised to 0 here so it isn't mistaken for no-arg. (A 0
        // precision then trips the RangeError gate below — 0 is out of [1,100] —
        // which matches V8: explicit NaN precision throws RangeError.)
        normalizeNaNToZero(fctx, precLocal);

        // Re-push receiver for the runtime call.
        fctx.body.push({ op: "local.get", index: recvLocalP });

        // Range-check fires only when receiver is finite.
        // isFinite(v) ⇔ v - v == 0 ⇔ v != NaN AND |v| != Infinity. We
        // detect non-finite via `v + (-v) != 0`: NaN gives NaN (≠ 0),
        // ±Infinity gives NaN (≠ 0). Equivalent to `!Number.isFinite(v)`.
        // Use the simpler `v == v` (false for NaN) followed by
        // `abs(v) != Infinity` — but Wasm has no abs/Infinity literal in
        // f64 const. Use the spec-equivalent `!isNaN(v) && v != ±Inf`:
        //   isFinite(v)  ≡  (v - v) == 0
        // The `i32.eqz` of that is "is non-finite".
        const isFiniteLocal = allocLocal(fctx, `__toPrecision_finite_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.get", index: recvLocalP });
        fctx.body.push({ op: "local.get", index: recvLocalP });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "local.set", index: isFiniteLocal });

        // RangeError gate: only when v is finite.
        fctx.body.push({ op: "local.get", index: isFiniteLocal });
        const rangeErrMsg = "RangeError: toPrecision() argument must be between 1 and 100";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        const rangeCheckBody: Instr[] = [];
        // Build: if (p < 1 || p > 100 || p != p) throw RangeError
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "f64.const", value: 1 });
        rangeCheckBody.push({ op: "f64.lt" });
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "f64.const", value: 100 });
        rangeCheckBody.push({ op: "f64.gt" });
        rangeCheckBody.push({ op: "i32.or" });
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "f64.ne" });
        rangeCheckBody.push({ op: "i32.or" });
        rangeCheckBody.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
          else: [],
        });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: rangeCheckBody,
          else: [],
        });

        fctx.body.push({ op: "local.get", index: precLocal });
      } else {
        // No argument → push NaN sentinel; the `number_toPrecision` host runtime
        // recognises NaN as "no precision provided" and returns String(v).
        fctx.body.push({ op: "f64.const", value: NaN });
      }
      const funcIdx = ctx.funcMap.get("number_toPrecision");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    // number.toExponential(fractionDigits)
    if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toExponential") {
      // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
      emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
      // (#3078) §21.1.3.3 step 2: an explicit `undefined` fractionDigits is
      // spec-equivalent to no argument → variable-precision exponential (as many
      // digits as needed), NOT ToIntegerOrInfinity(undefined)=0 (which gives
      // fixed 0 digits). undefined and NaN both compile to f64 NaN and are
      // indistinguishable at the value site — route the STATIC undefined literal
      // to the no-arg branch (NaN sentinel) at the AST level.
      // test262 toExponential/undefined-fractiondigits.js.
      if (expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
        // (#49) Spec §21.1.3.3 step 3: if x is non-finite, return
        // Number::toString(x) BEFORE the fractionDigits range check.
        // Save receiver, run range check only when x is finite. The
        // runtime helper `number_toExponential` short-circuits for
        // non-finite x; pre-check would fire for
        // `(NaN).toExponential(101)` which spec requires to return "NaN".
        const recvLocalE = allocLocal(fctx, `__toExponential_recv_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: recvLocalE });
        // ToNumber(fractionDigits) funnel — Symbol args must throw TypeError (#1564).
        coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
        const digitsLocal = allocLocal(fctx, `__toExponential_digits_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: digitsLocal });

        // (#1735) §21.1.3.3 step 5: f = ToIntegerOrInfinity(fractionDigits),
        // which maps NaN → 0. The `number_toExponential` runtime helper reads
        // NaN as its "no argument supplied" sentinel (see else-branch below),
        // so an *explicit* NaN argument — e.g. `(1).toExponential(NaN)` or
        // `(1).toExponential(0/0)` — must be normalised to 0 here, otherwise it
        // collides with the sentinel and is wrongly treated as no-arg (variable
        // digits) instead of 0 digits. Spec: explicit NaN → 0 → "Ne+E"; genuine
        // no-arg → variable digits. test262
        // Number/prototype/toExponential/tointeger-fractiondigits.js.
        normalizeNaNToZero(fctx, digitsLocal);

        // Re-push receiver for the runtime call.
        fctx.body.push({ op: "local.get", index: recvLocalE });

        // isFinite(v): (v - v) == 0 (NaN/Infinity give NaN ≠ 0).
        const isFiniteLocal = allocLocal(fctx, `__toExponential_finite_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.get", index: recvLocalE });
        fctx.body.push({ op: "local.get", index: recvLocalE });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "local.set", index: isFiniteLocal });

        // Range check gate: only when v is finite.
        const rangeErrMsg = "RangeError: toExponential() argument must be between 0 and 100";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        const rangeCheckBody: Instr[] = [];
        rangeCheckBody.push({ op: "local.get", index: digitsLocal });
        rangeCheckBody.push({ op: "f64.const", value: 0 });
        rangeCheckBody.push({ op: "f64.lt" });
        rangeCheckBody.push({ op: "local.get", index: digitsLocal });
        rangeCheckBody.push({ op: "f64.const", value: 100 });
        rangeCheckBody.push({ op: "f64.gt" });
        rangeCheckBody.push({ op: "i32.or" });
        rangeCheckBody.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: isFiniteLocal });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: rangeCheckBody,
          else: [],
        });

        fctx.body.push({ op: "local.get", index: digitsLocal });
      } else {
        // No argument → pass NaN as sentinel for "no argument provided"
        fctx.body.push({ op: "f64.const", value: NaN });
      }
      const funcIdx = ctx.funcMap.get("number_toExponential");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // (#2576, extends #2187) Runtime-guarded native string method on an
    // `any`/unknown receiver whose value MAY be a native `$AnyString` at runtime
    // but whose receiver is an opaque externref (object property value, generator
    // yield read, indexed element read, …) — i.e. the value-rep cases that
    // #2187's static `receiverIsNativeStringValType` (bare-identifier-with-
    // string-ref-local) cannot recognise. A runtime `ref.test $AnyString` keeps a
    // non-string `any` (array, number, null) on its benign default. Scoped to a
    // known STRING_METHODS name (+`charCodeAt`, which has a dedicated arm but is
    // not in the table), native-string mode, and an `any`/unknown receiver NOT
    // already handled by the static string arms below.
    if (
      ctx.nativeStrings &&
      ctx.nativeStrTypeIdx >= 0 &&
      (Object.prototype.hasOwnProperty.call(STRING_METHODS, propAccess.name.text) ||
        propAccess.name.text === "charCodeAt") &&
      !isStringType(receiverType) &&
      !receiverIsCaughtErrorStringRead(ctx, propAccess.expression) &&
      !receiverIsNativeStringValType(ctx, fctx, propAccess.expression) &&
      receiverMayBeNativeStringAtRuntime(ctx, propAccess.expression)
    ) {
      const guarded = compileGuardedNativeStringMethodCall(ctx, fctx, expr, propAccess, propAccess.name.text);
      if (guarded !== null) return guarded;
      // Fall through to the generic dispatch on a build failure.
    }

    // String method calls
    // (#2192 follow-up) Also fire for a caught-Error string-field read receiver
    // (`e.message.charCodeAt(0)`, `e.name.slice(...)`) whose static type is `any`
    // but which lowers to a native-string ref in standalone mode — the
    // isStringType gate alone misses it, so the call fell through to the host
    // `__extern_get`/dynamic path (null standalone). compileNativeStringMethodCall
    // compiles + flattens the receiver, which already yields a $AnyString ref.
    if (
      isStringType(receiverType) ||
      receiverIsCaughtErrorStringRead(ctx, propAccess.expression) ||
      receiverIsNativeStringValType(ctx, fctx, propAccess.expression)
    ) {
      const method = propAccess.name.text;

      // string.toString() and string.valueOf() — identity, just return the string itself.
      // (#1397) Skip the identity short-circuit when the receiver is a String
      // wrapper object (`new String(...)`) AND the source has a reassignment
      // of the form `<id>.toString = ...` / `.valueOf = ...`. For wrappers
      // the .toString / .valueOf property is reassignable, and the identity
      // short-circuit silently ignores the override; the runtime spec
      // requires dispatch through the actual property. Primitive strings
      // can't have own properties, so the short-circuit stays correct.
      if (method === "toString" || method === "valueOf") {
        const skipForReassignment =
          isStringWrapperType(receiverType) && sourceHasMethodReassignment(ctx, propAccess.expression, method);
        if (!skipForReassignment) {
          return compileExpression(ctx, fctx, propAccess.expression);
        }
        // Fall through — let the generic externref method-call path at the
        // bottom of compileMethodCall handle dynamic dispatch.
      }

      // Fast mode: native string method dispatch
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        // (#2160 wrapper-strmethod) A String WRAPPER receiver (`new String(x)`)
        // reaches here because `isStringType` deliberately also matches the
        // wrapper Object type (for primitive-string method dispatch — see the
        // cs-2160 `resolveWasmType` note). But the wrapper lowers to a `$Object`
        // externref, NOT a native string ref, so the default receiver emitter
        // (`compileExpression(propAccess.expression)` → `__str_flatten`'s
        // `ref.cast $NativeString`) traps at runtime with "illegal cast" /
        // "null pointer" for every String.prototype method (`charAt`, `slice`,
        // `indexOf`, `toUpperCase`, …). The wrapper `.valueOf()`/`.toString()`
        // slice (cs-2160) already recovers the internal `[[PrimitiveValue]]` slot
        // via the native `__to_primitive` engine helper; reuse the SAME helper
        // here as the receiver so the method dispatches against the wrapped
        // primitive string. Gated on `ctx.standalone` (the native object-runtime
        // / `__to_primitive` machinery is standalone-only — WASI keeps the host
        // object path). No new coercion site: `__to_primitive` is the existing
        // §7.1.1.1 engine helper.
        if (ctx.standalone && isStringWrapperType(receiverType) && method !== "toString" && method !== "valueOf") {
          ensureObjectRuntime(ctx);
          const toPrimIdx = ctx.funcMap.get("__to_primitive");
          if (toPrimIdx !== undefined && ctx.anyStrTypeIdx >= 0) {
            const wrapperReceiverOverride = (): ValType => {
              // wrapper externref → __to_primitive(hint "string") → externref
              // (the internal slot IS a native string) → back to `ref $AnyString`.
              compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
              addStringConstantGlobal(ctx, "string");
              fctx.body.push(...stringConstantExternrefInstrs(ctx, "string"));
              fctx.body.push({ op: "call", funcIdx: toPrimIdx });
              fctx.body.push({ op: "any.convert_extern" });
              fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
              return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
            };
            return compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method, wrapperReceiverOverride);
          }
        }
        return compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method);
      }

      // charCodeAt: uses wasm:js-string charCodeAt import (not string_charCodeAt)
      // Use jsStringImports to avoid shadowing by user-defined functions (#1072).
      if (method === "charCodeAt") {
        // #2003 — the wasm:js-string `charCodeAt` builtin TRAPS on an
        // out-of-range index, but §22.1.3.3 requires `NaN` for any index
        // `< 0` or `>= length`. Emit a bounds guard around the builtin and
        // return f64 so the NaN case is representable:
        //   idx = ToInteger(arg); len = s.length
        //   (idx >= 0 && idx < len) ? f64(charCodeAt(s, idx)) : NaN
        const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
        const lengthIdx = ctx.jsStringImports.get("length");
        if (charCodeAtIdx !== undefined && lengthIdx !== undefined) {
          // Save receiver to a temp so we can read both its length and its char.
          compileExpression(ctx, fctx, propAccess.expression);
          const recvLocal = allocLocal(fctx, `__cca_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.tee", index: recvLocal });
          // Compute the (truncated) index into an i32 temp.
          if (expr.arguments.length > 0) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
            if (!argType) {
              fctx.body.push({ op: "i32.const", value: 0 });
            } else if (argType.kind === "f64") {
              fctx.body.push({ op: "i32.trunc_sat_f64_s" });
            }
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          // (the receiver pushed by local.tee is still on the stack below idx;
          //  drop it — we re-load from the temp inside each branch.)
          const idxLocal = allocLocal(fctx, `__cca_idx_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.set", index: idxLocal });
          fctx.body.push({ op: "drop" }); // drop the receiver left by local.tee
          // Bounds test: (idx >= 0) & (idx < len)
          fctx.body.push({ op: "local.get", index: idxLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.ge_s" });
          fctx.body.push({ op: "local.get", index: idxLocal });
          fctx.body.push({ op: "local.get", index: recvLocal });
          fctx.body.push({ op: "call", funcIdx: lengthIdx });
          fctx.body.push({ op: "i32.lt_s" });
          fctx.body.push({ op: "i32.and" });
          // then: f64(charCodeAt(recv, idx)) ; else: NaN
          const thenInstrs: Instr[] = [
            { op: "local.get", index: recvLocal },
            { op: "local.get", index: idxLocal },
            { op: "call", funcIdx: charCodeAtIdx },
            { op: "f64.convert_i32_u" },
          ];
          const elseInstrs: Instr[] = [{ op: "f64.const", value: Number.NaN }];
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: thenInstrs,
            else: elseInstrs,
          });
          return { kind: "f64" };
        }
      }

      const importName = `string_${method}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        // #1445 — ECMA-262 §7.1.4 ToNumber throws TypeError on BigInt /
        // Symbol arguments. String.prototype methods feed certain args
        // through ToInteger / ToLength (which call ToNumber). For those
        // arg positions, emit a static TypeError throw when the arg's
        // static TS type is `bigint` or `symbol`.
        //
        // Map: method → set of arg indices that are ToInteger-coerced.
        const TO_INTEGER_ARG_INDICES: Record<string, ReadonlyArray<number>> = {
          charAt: [0],
          charCodeAt: [0],
          codePointAt: [0],
          at: [0],
          substring: [0, 1],
          slice: [0, 1],
          substr: [0, 1],
          indexOf: [1],
          lastIndexOf: [1],
          includes: [1],
          startsWith: [1],
          endsWith: [1],
          padStart: [0],
          padEnd: [0],
          repeat: [0],
        };
        const integerArgs = TO_INTEGER_ARG_INDICES[method];
        if (integerArgs) {
          for (const idx of integerArgs) {
            const arg = expr.arguments[idx];
            if (!arg) continue;
            let argTsType: ts.Type | undefined;
            try {
              argTsType = ctx.checker.getTypeAtLocation(arg);
            } catch {
              continue;
            }
            if (!argTsType) continue;
            const isBig = isBigIntType(argTsType);
            const isSym = isSymbolType(argTsType);
            if (!isBig && !isSym) continue;
            const msg = isBig
              ? "TypeError: Cannot convert a BigInt value to a number"
              : "TypeError: Cannot convert a Symbol value to a number";
            addStringConstantGlobal(ctx, msg);
            const strIdx = ctx.stringGlobalMap.get(msg)!;
            // #1473 — no JS host: throw a TypeError INSTANCE via the in-module
            // constructor (no `__throw_type_error` host import).
            if (noJsHost(ctx)) {
              emitThrowTypeError(ctx, fctx, msg);
              fctx.body.push({ op: "unreachable" });
            } else {
              const throwIdx = ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
              if (throwIdx !== undefined) {
                flushLateImportShifts(ctx, fctx);
                const throwFuncIdx = ctx.funcMap.get("__throw_type_error")!;
                fctx.body.push({ op: "global.get", index: strIdx });
                fctx.body.push({ op: "call", funcIdx: throwFuncIdx });
                fctx.body.push({ op: "unreachable" });
              } else {
                const tagIdx = ensureExnTag(ctx);
                fctx.body.push({ op: "global.get", index: strIdx });
                fctx.body.push({ op: "throw", tagIdx });
              }
            }
            // After unreachable / throw, the wasm stack is polymorphic.
            // Push a sentinel matching the method's return type so any
            // downstream consumer (the implicit drop / coercion in the
            // statement context) still validates cleanly.
            const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
            const returnsNum =
              method === "indexOf" || method === "lastIndexOf" || method === "codePointAt" || method === "search";
            if (returnsBool) {
              fctx.body.push({ op: "i32.const", value: 0 });
              return { kind: "i32" };
            }
            if (returnsNum) {
              fctx.body.push({ op: "f64.const", value: 0 });
              return { kind: "f64" };
            }
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
        }
        // #1248: substring/slice with a single argument default the missing
        // `end` to `s.length`, NOT 0. Without this, the generic padding loop
        // below pushes f64.const 0, and the host import calls
        // `s.substring(start, 0)` — which JS spec swaps to `substring(0, start)`,
        // returning the wrong prefix instead of the suffix from `start`.
        // Save the receiver into a temp local so we can re-compute its length
        // when padding the missing `end` arg.
        const args = expr.arguments;
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        // #1248 + no-arg: substring/slice with a missing `end` (0 OR 1 args)
        // default `end` to `s.length` per §22.1.3.24 (substring: end ?? len) /
        // §22.1.3.21 (slice: ToIntegerOrInfinity(end ?? len)). With only the
        // single-arg case handled, `s.substring()` / `s.slice()` padded BOTH
        // start and end to 0 → host called `s.substring(0, 0)` → "" instead of
        // the whole string. The pad loop's `pi === 2` branch supplies s.length
        // for the missing end; the missing start (pi === 1) correctly pads to 0.
        // (#2124) An explicit `undefined` end arg is spec-equivalent to absent:
        // substring/slice default `end` to `s.length`. Without this, the f64
        // slot coerces `undefined` → NaN and the host runs `substring(1, NaN)`
        // → wrong length. Detect a statically-undefined end so the same
        // length-default path that handles a missing end fires.
        const isStaticUndefinedExpr = (a: ts.Expression | undefined): boolean => {
          if (a === undefined) return false;
          let cur: ts.Expression = a;
          while (
            ts.isParenthesizedExpression(cur) ||
            ts.isAsExpression(cur) ||
            ts.isNonNullExpression(cur) ||
            ts.isTypeAssertionExpression(cur)
          ) {
            cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion)
              .expression;
          }
          return (
            (ts.isIdentifier(cur) && cur.text === "undefined") ||
            (ts.isVoidExpression(cur) && ts.isNumericLiteral(cur.expression))
          );
        };
        const substringEndUndefined =
          (method === "substring" || method === "slice") && args.length === 2 && isStaticUndefinedExpr(args[1]);
        const needsLengthDefault =
          (method === "substring" || method === "slice") &&
          (args.length <= 1 || substringEndUndefined) &&
          paramTypes !== undefined &&
          paramTypes.length === 3;
        let savedReceiverLocal: number | undefined;
        if (needsLengthDefault) {
          // Ensure wasm:js-string.length is registered so we can compute s.length below.
          addStringImports(ctx);
          // Compile receiver, save to temp, leave on stack for the call.
          compileExpression(ctx, fctx, propAccess.expression);
          savedReceiverLocal = allocLocal(fctx, `__substr_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.tee", index: savedReceiverLocal });
        } else {
          compileExpression(ctx, fctx, propAccess.expression);
        }
        // Cap at declared param count (excluding self) to avoid pushing extra values
        const userParamCount = paramTypes ? paramTypes.length - 1 : args.length;
        for (let ai = 0; ai < args.length; ai++) {
          if (substringEndUndefined && ai === 1 && savedReceiverLocal !== undefined) {
            // Explicit `undefined` end → s.length (#2124). Skip compiling the
            // undefined arg; emit the receiver's length for the f64 end slot.
            const lenIdx = ctx.jsStringImports.get("length");
            if (lenIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: savedReceiverLocal });
              fctx.body.push({ op: "call", funcIdx: lenIdx });
              fctx.body.push({ op: "f64.convert_i32_u" });
            } else {
              fctx.body.push({ op: "f64.const", value: 0x7fffffff });
            }
            continue;
          }
          if (ai < userParamCount) {
            const expectedArgType = paramTypes?.[ai + 1]; // +1 for self param
            const argResult = compileExpression(ctx, fctx, args[ai]!, expectedArgType);
            if (!argResult) {
              // void/null result — push a default value for the expected type
              pushDefaultValue(fctx, expectedArgType ?? { kind: "f64" }, ctx);
            } else if (expectedArgType && argResult.kind !== expectedArgType.kind) {
              coerceType(ctx, fctx, argResult, expectedArgType);
            }
          } else {
            // Extra argument beyond function's parameter count — evaluate for
            // side effects and drop the result
            const extraType = compileExpression(ctx, fctx, args[ai]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing optional args with defaults (e.g. indexOf 2nd arg)
        if (paramTypes && args.length + 1 < paramTypes.length) {
          // #1381 — `endsWith`/`startsWith`/`includes`/`lastIndexOf` distinguish
          // null vs undefined for the position arg (endsWith(s) ⇒ pos defaults
          // to length, but endsWith(s, null) ⇒ ToInteger(null)=0 ⇒ "" check).
          // Pad missing externref position args with JS undefined (via
          // `__get_undefined`) so the host sees the spec-correct "not passed"
          // value instead of `null`.
          // #1740 — padStart/padEnd: an OMITTED fillString must default to a
          // single space " " (§22.1.3.17 StringPad: if fillString is
          // undefined, set it to " "). Padding the missing externref arg with
          // `ref.null.extern` makes the host see JS `null`, which ToString-
          // coerces to "null" → e.g. `"abc".padStart(6)` returned "nulabc"
          // instead of "   abc". Pass JS `undefined` so the host applies the
          // spec default. (Same null-vs-undefined distinction as endsWith.)
          const padsUndefined =
            method === "endsWith" || method === "lastIndexOf" || method === "padStart" || method === "padEnd";
          let undefIdx: number | undefined;
          if (padsUndefined) {
            undefIdx = ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
            flushLateImportShifts(ctx, fctx);
          }
          for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
            const pt = paramTypes[pi]!;
            if (needsLengthDefault && pi === 2 && savedReceiverLocal !== undefined && pt.kind === "f64") {
              // #1248: For substring/slice missing-end, push s.length instead of 0.
              const lenIdx = ctx.jsStringImports.get("length");
              if (lenIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: savedReceiverLocal });
                fctx.body.push({ op: "call", funcIdx: lenIdx });
                fctx.body.push({ op: "f64.convert_i32_u" });
              } else {
                // Fallback if length import is unavailable for some reason
                fctx.body.push({ op: "f64.const", value: 0x7fffffff });
              }
            } else if (pt.kind === "externref") {
              if (padsUndefined && undefIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: undefIdx });
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else if (pt.kind === "f64") {
              // #1441 — `split` uses NaN as the "limit was not provided"
              // sentinel. ToUint32(NaN) === 0 would produce `[]` if the runtime
              // passed it through verbatim, so the `string_method` host shim
              // strips a trailing NaN limit before invoking the JS method.
              // #2002 — includes/startsWith/endsWith likewise use NaN for an
              // omitted position so the host shim drops it and the JS method
              // applies its spec default (0 for includes/startsWith, length
              // for endsWith) instead of ToInteger(NaN)=0.
              if (method === "split" || method === "includes" || method === "startsWith" || method === "endsWith") {
                fctx.body.push({ op: "f64.const", value: Number.NaN });
              } else {
                fctx.body.push({ op: "f64.const", value: 0 });
              }
            } else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
        const returnsNum =
          method === "indexOf" || method === "lastIndexOf" || method === "codePointAt" || method === "search";
        return returnsBool ? { kind: "i32" } : returnsNum ? { kind: "f64" } : { kind: "externref" };
      }
    }

    // Boolean method calls: bool.toString(), bool.valueOf()
    if (isBooleanType(receiverType)) {
      const method = propAccess.name.text;
      if (method === "toString") {
        compileExpression(ctx, fctx, propAccess.expression);
        return emitBoolToString(ctx, fctx);
      }
      if (method === "valueOf") {
        // Boolean.valueOf() returns the boolean primitive — just compile the expression
        return compileExpression(ctx, fctx, propAccess.expression);
      }
    }

    // number.valueOf() — return the number itself
    if (isNumberType(receiverType) && propAccess.name.text === "valueOf") {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback .toLocaleString() — delegates to the JS host so that
    // Array/TypedArray/wrapped-object instances return the real
    // locale-formatted string and — critically for test262 — any abrupt
    // completion from the element's patched toLocaleString/valueOf
    // propagates as a real JS exception instead of being silently dropped.
    // Without this path, sample.toLocaleString() on a TypedArray hits the
    // graceful null-extern fallback and the test fails with "null/undefined
    // access" instead of reaching the expected throw.
    if (propAccess.name.text === "toLocaleString" && expr.arguments.length === 0) {
      // (#2863 Phase 2) Standalone/WASI have no host `__extern_toLocaleString`
      // (it's a dynamic-shape refusal — a host-only import with no native
      // carrier). Without ECMA-402 the spec default
      // `Object.prototype.toLocaleString` (§20.1.3.5) just calls the receiver's
      // `toString`, and `Array.prototype.toLocaleString` (§23.1.3.32) joins the
      // per-element `toLocaleString` results — both collapse to the same comma-
      // join as `toString` in a locale-independent runtime. Route to the NATIVE
      // `__extern_toString` (registered host-free under standalone via #1866),
      // which removes the CE while matching the locale-independent value. Host
      // (gc) mode keeps `__extern_toLocaleString` for real Intl grouping.
      const toLSName = ctx.standalone || ctx.wasi ? "__extern_toString" : "__extern_toLocaleString";
      const toLSIdx = ensureLateImport(ctx, toLSName, [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (toLSIdx !== undefined) {
        const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (recvType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        fctx.body.push({ op: "call", funcIdx: toLSIdx });
        return { kind: "externref" };
      }
    }

    // Fallback .toString() for any type not already handled above
    // Handles: function.toString(), object.toString(), array.toString(), class instance.toString()
    if (propAccess.name.text === "toString" && expr.arguments.length === 0) {
      // #1463 — `someFn.toString()` where `someFn` is a top-level function
      // declaration → return the captured source text directly. Must happen
      // BEFORE the externref-routes-to-JS fallback below: top-level functions
      // resolve to externref at the type system level, so the default path
      // would call `__extern_toString` on a Wasm closure (which JS doesn't
      // know how to stringify) and the spec text would be lost.
      if (ts.isIdentifier(propAccess.expression)) {
        const captured = ctx.funcSourceText.get(propAccess.expression.text);
        if (captured) {
          // (#2515 S0) sentinel-safe materialization (standalone bakes `-1`).
          addStringConstantGlobal(ctx, captured);
          fctx.body.push(...stringConstantExternrefInstrs(ctx, captured));
          return { kind: "externref" };
        }
      }
      const tsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const wasm = resolveWasmType(ctx, tsType);

      // For externref values (e.g. RegExp.exec result, host objects), delegate to JS toString
      if (wasm.kind === "externref") {
        const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (toStrIdx !== undefined) {
          // (#2934 2b) The STATIC type says externref, but the receiver can
          // COMPILE to a concrete ref — e.g. `regObj.exec(str).toString()`
          // standalone lowers exec natively to a capture-array vec `(ref null
          // $Vec)`. Feeding that raw ref to `__extern_toString(externref)` is
          // invalid Wasm (`call[0] expected externref, found (ref null …)`).
          // Coerce the COMPILED type, mirroring the #2934 2a receiver fix in
          // compilePropertyIntrospection (object-ops.ts).
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType && recvType.kind !== "externref" && recvType.kind !== "ref_extern") {
            coerceType(ctx, fctx, recvType, { kind: "externref" });
          }
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType) {
        // If the compiled expression produced an externref, try JS toString
        if (exprType.kind === "externref") {
          const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (toStrIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: toStrIdx });
            return { kind: "externref" };
          }
        }
        fctx.body.push({ op: "drop" });
      }
      // Check if it's an array type (ref to vec struct)
      let isArray = false;
      if (wasm.kind === "ref" || wasm.kind === "ref_null") {
        const arrInfo = resolveArrayInfo(ctx, tsType);
        if (arrInfo) isArray = true;
      }
      // Check if this is a function type (has call signatures, is not a class/interface)
      const callSigs = tsType.getCallSignatures?.();
      const isFunc = callSigs && callSigs.length > 0 && !tsType.getProperties?.()?.length;

      if (isFunc) {
        // #1463 — return captured source text when the receiver is an
        // identifier resolving to a known top-level function declaration.
        // Falls back to the legacy placeholder for arrow functions, method
        // references, or any receiver we can't resolve statically.
        let toStrStr = "function () { [native code] }";
        if (ts.isIdentifier(propAccess.expression)) {
          const captured = ctx.funcSourceText.get(propAccess.expression.text);
          if (captured) toStrStr = captured;
        }
        // (#2515 S0) sentinel-safe — standalone stores `-1` for the string
        // constant, so materialize inline rather than baking `global.get -1`.
        addStringConstantGlobal(ctx, toStrStr);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, toStrStr));
      } else {
        const str = isArray ? "[object Array]" : "[object Object]";
        addStringConstantGlobal(ctx, str);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, str));
      }
      return { kind: "externref" };
    }

    // Fallback .valueOf() for any type not already handled above
    // valueOf() on non-primitive types typically returns the object itself
    if (propAccess.name.text === "valueOf" && expr.arguments.length === 0) {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback for method calls on any-typed / externref / unresolvable receivers.
    // This handles patterns like: ref(args).next(), anyObj.someMethod(), etc.
    // Common in test262 where variables are typed as `any` or inferred as `any`.
    {
      const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvWasm = resolveWasmType(ctx, recvTsType);
      const isAnyOrExternref = (recvTsType.flags & ts.TypeFlags.Any) !== 0 || recvWasm.kind === "externref";

      if (isAnyOrExternref) {
        const methodName = propAccess.name.text;
        const nativeResult = tryCompileNativeGeneratorMethodCall(
          ctx,
          fctx,
          propAccess.expression,
          methodName,
          expr.arguments,
        );
        if (nativeResult !== undefined) return nativeResult;

        // Generator protocol: .next(), .return(value), .throw(error) on any/externref
        // These are very common in test262 generator tests where variables are typed as `any`.
        if (methodName === "next") {
          // (#2865) An any-typed receiver may hold a DRIVEN async-gen frame
          // (`var f; f = async function*(){…}; f().next()` — the dominant
          // test262 shape). Runtime ref.test-dispatch to the per-gen driver;
          // the miss arm preserves this site's original `__gen_next` behavior
          // (see tryEmitAsyncGenNextDispatch). Zero-arg only.
          if (expr.arguments.length === 0) {
            const dispatched = tryEmitAsyncGenNextDispatch(ctx, fctx, propAccess.expression);
            if (dispatched !== null) return dispatched;
          }
          const genNextIdx = ctx.funcMap.get("__gen_next");
          if (genNextIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            // Drop any arguments (generator .next() with args not yet supported)
            for (const arg of expr.arguments) {
              const argType = compileExpression(ctx, fctx, arg);
              if (argType) {
                fctx.body.push({ op: "drop" });
              }
            }
            fctx.body.push({ op: "call", funcIdx: genNextIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "return") {
          const genReturnIdx = ctx.funcMap.get("__gen_return");
          if (genReturnIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, {
                kind: "externref",
              });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genReturnIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "throw") {
          const genThrowIdx = ctx.funcMap.get("__gen_throw");
          if (genThrowIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, {
                kind: "externref",
              });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genThrowIdx });
            return { kind: "externref" };
          }
        }

        // Try to resolve via registered extern classes (e.g. Set.union, Map.get)
        // when the receiver type is `any` but the method matches a built-in.
        {
          const builtinNamespace = ctx.standalone
            ? resolveBuiltinNamespaceValueName(ctx, propAccess.expression)
            : undefined;
          const preferOpenBuiltinNamespace =
            builtinNamespace !== undefined && isSupportedBuiltinStaticProperty(builtinNamespace, methodName);
          if (!preferOpenBuiltinNamespace) {
            const externResult = tryExternClassMethodOnAny(ctx, fctx, expr, propAccess, methodName);
            if (externResult !== null) return externResult;
          }
        }

        // (#2151) Standalone/WASI closed-struct method dispatch. An object
        // literal `{ m(){…} }` is a CLOSED nominal WasmGC struct; the generic
        // __extern_method_call below only handles the OPEN $Object receiver
        // (ref.test $Object), so `o.m()` on a closed struct returns null/0 and
        // never invokes the method (standalone analog of the JS-host #2015 bug).
        // Route 0-arg any-receiver calls through a reserved per-name dispatcher
        // `__call_m_<name>` that type-switches over every closed struct having
        // `<Struct>_<name>` (threading the struct as `this`) and falls through to
        // __extern_method_call for the open-$Object case. Reserve-then-fill
        // (#1719): the body is built at finalize once all structs are known.
        // Slice 1: zero-arg only (covers next()/getx()/iterator protocol); calls
        // with arguments keep the existing generic path below.
        const recvIsBuiltinClass =
          ts.isIdentifier(propAccess.expression) && BUILTIN_CLASS_NAMES.has(propAccess.expression.text);
        // (#2151 Slice 2) N-ary: the dispatcher is arity-specialized
        // `__call_m_<name>_<arity>(recv, arg0..arg{arity-1})` (all externref).
        // (#2151 Slice 3) Spread of an ARRAY LITERAL (`o.m(...[2,3])`) flattens
        // to a fixed argument list at compile time, so it can use the same
        // arity-specialized dispatcher. A spread of a DYNAMIC source
        // (`o.m(...xs)`) has no statically-known arity → flattenCallArgs returns
        // null and it falls through to the generic path.
        const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));
        const dispatchArgs: ts.Expression[] | null = hasSpreadArg
          ? flattenCallArgs(expr.arguments)
          : [...expr.arguments];
        if ((ctx.standalone || ctx.wasi) && dispatchArgs !== null && !recvIsBuiltinClass) {
          const arity = dispatchArgs.length;
          const dispatchIdx = reserveClosedMethodDispatch(ctx, methodName, arity);
          // (#2927) For the in-place array mutation forms (`push` arity 1 / `pop`
          // arity 0) the closed-method dispatcher grows a native `$__vec_base`
          // brand arm (fillClosedMethodDispatch) that routes an `any`/externref
          // vec receiver to these carrier-generic helpers. Reserve them here — the
          // dispatcher's fill only READS funcMap, and reserving from this module
          // (which already imports `reserveVecMethodHelper`) avoids the eval-time
          // import cycle that reserving from `closed-method-dispatch.ts` would form.
          if ((methodName === "push" && arity === 1) || (methodName === "pop" && arity === 0)) {
            reserveVecMethodHelper(ctx, methodName === "push" ? "push" : "pop");
          }
          // (#3173) DataView get*/set* on an `any` receiver — mint the shared
          // native accessor helper NOW so the dispatcher fill (which only READS
          // funcMap, #1719) can add its `$__dv_window` brand arm. Reserved from
          // this module (which already imports dataview-native) to avoid the
          // eval-time import cycle a closed-method-dispatch.ts import would form
          // (same reasoning as the #2927 reserveVecMethodHelper placement above).
          if (noJsHost(ctx) && isDataViewAccessor(methodName)) {
            ensureDvAccessorHelper(ctx, methodName);
          }
          flushLateImportShifts(ctx, fctx);
          // (#2872) A mutating `%TypedArray%.prototype` method on a receiver
          // that is a `$__ta_dyn_view` at RUNTIME (a dynamically-constructed TA
          // — `new TA([…]).fill(8, 1)` / `.copyWithin(0,2)` / `.reverse()` in
          // the testWithTypedArrayConstructors harness) must operate on the
          // view's shared buffer and return `this`; the dispatcher's open-object
          // arm silently returned undefined and mutated nothing. Emit a
          // runtime-gated two-arm: `ref.test $__ta_dyn_view` → the native
          // `__ta_dyn_<m>` helper, else → the ordinary dispatcher (closed
          // structs / vec arms / open objects keep their EXACT behavior). All
          // three helpers share the `(recv, v1, v2, v3, argc)` signature (unused
          // slots padded with `ref.null.extern`), so ONE emit block serves them
          // (slice-1 fill path is byte-identical — same helper funcIdx/arity).
          // Helpers mint defined functions only (no imports — post-flush safe).
          let taFillIdx: number | undefined;
          if (ctx.moduleUsesDynTaView && arity <= 3) {
            if (methodName === "fill") taFillIdx = ensureTaDynFillHelper(ctx);
            else if (methodName === "copyWithin") taFillIdx = ensureTaDynCopyWithinHelper(ctx);
            else if (methodName === "reverse") taFillIdx = ensureTaDynReverseHelper(ctx);
          }
          if (taFillIdx !== undefined && ctx.taDynViewTypeIdx >= 0) {
            const dynIdx = ctx.taDynViewTypeIdx;
            const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            if (recvT && recvT.kind !== "externref") {
              coerceType(ctx, fctx, recvT, { kind: "externref" });
            } else if (recvT === null) {
              fctx.body.push({ op: "ref.null.extern" });
            }
            const recvLocal = allocLocal(fctx, `__tafill_recv_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: recvLocal });
            const argLocals: number[] = [];
            for (const arg of dispatchArgs) {
              const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
              if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
              else if (at === null) fctx.body.push({ op: "ref.null.extern" });
              const aLocal = allocLocal(fctx, `__tafill_arg_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "local.set", index: aLocal });
              argLocals.push(aLocal);
            }
            const thenArm: Instr[] = [{ op: "local.get", index: recvLocal }];
            for (let a = 0; a < 3; a++) {
              thenArm.push(
                a < argLocals.length ? { op: "local.get", index: argLocals[a]! } : { op: "ref.null.extern" },
              );
            }
            thenArm.push({ op: "i32.const", value: arity });
            thenArm.push({ op: "call", funcIdx: taFillIdx });
            const elseArm: Instr[] = [{ op: "local.get", index: recvLocal }];
            for (const aLocal of argLocals) elseArm.push({ op: "local.get", index: aLocal });
            elseArm.push({ op: "call", funcIdx: dispatchIdx });
            fctx.body.push({ op: "local.get", index: recvLocal });
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "ref.test", typeIdx: dynIdx });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: thenArm,
              else: elseArm,
            });
            return { kind: "externref" };
          }
          // (#3140) `.bind` on an `any`-typed receiver that is a CLOSURE at
          // RUNTIME — the test262 TypedArray harness shape
          // (`argFactory.bind(undefined, constructor)` where `argFactory` is an
          // array element). The typed `compileFunctionBind` route requires TS
          // call signatures, so an `any` receiver fell to the open-object
          // dispatcher arm and returned undefined (a non-callable — every
          // makeCtorArg-style test then failed at the harness level). Emit the
          // closure-classifier runtime arms: a callable receiver mints the
          // native `$__bound_fn` carrier; anything else keeps the EXACT
          // dispatcher path (closed-struct `bind` methods, open objects).
          if (methodName === "bind" && (ctx.standalone || ctx.wasi)) {
            // Reserve-then-fill (#1719 discipline): the callable test needs the
            // COMPLETE closure-classifier root list, which is only settled at
            // finalize — baking `buildClosureRefTestArms` here would miss every
            // closure registered after this call site compiles (#1896's exact
            // hazard). `__bind_dyn(recv, argsVec)` is filled by
            // `fillBindDynHelper`: callable → mint `$__bound_fn`; anything else
            // → the open-object `__extern_method_call(recv, "bind", args)`
            // legacy route (undefined), preserving prior behavior.
            const bindDynIdx = reserveBindDynHelper(ctx);
            flushLateImportShifts(ctx, fctx);
            const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            if (recvT && recvT.kind !== "externref") {
              coerceType(ctx, fctx, recvT, { kind: "externref" });
            } else if (recvT === null) {
              fctx.body.push({ op: "ref.null.extern" });
            }
            const recvLocal = allocLocal(fctx, `__bindany_recv_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: recvLocal });
            const { newIdx: bvNewIdx, pushIdx: bvPushIdx } = ensureObjVecBuilders(ctx);
            const vecLocal = allocLocal(fctx, `__bindany_vec_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "call", funcIdx: bvNewIdx });
            fctx.body.push({ op: "local.set", index: vecLocal });
            for (const arg of dispatchArgs) {
              fctx.body.push({ op: "local.get", index: vecLocal });
              const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
              if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
              else if (at === null) fctx.body.push({ op: "ref.null.extern" });
              fctx.body.push({ op: "call", funcIdx: bvPushIdx });
            }
            fctx.body.push({ op: "local.get", index: recvLocal });
            fctx.body.push({ op: "local.get", index: vecLocal });
            fctx.body.push({ op: "call", funcIdx: bindDynIdx });
            return { kind: "externref" };
          }
          // Receiver as externref.
          const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvType && recvType.kind !== "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (recvType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          // Each argument compiled and boxed to externref (the dispatcher unboxes
          // to the method's declared param type per candidate struct).
          for (const arg of dispatchArgs) {
            // (#3098) An inline arrow/function-expression callback to a native-
            // HOF-served method compiles as a raw GC CLOSURE struct (crossing as
            // externref), NOT via the `__make_callback` host bridge that
            // `isHostCallbackArgument` would pick for the HOST_CALLBACK_METHODS
            // names: standalone has no host, so that env import leaked and the
            // whole module failed to instantiate (the #2 leaked import of the
            // 2026-06-26 standalone JSONL). The dispatcher's `$__vec_base`/
            // `$ObjVec` HOF arm invokes the closure natively via
            // `__apply_closure` (same rep an identifier-held callback already
            // crosses with). Mirrors the `Object.groupBy` / `.call`/`.apply`
            // (#3016) precedent; standalone-gated so gc/wasi stay byte-identical.
            if (
              ctx.standalone &&
              (NATIVE_HOF_METHODS.has(methodName) || LAZY_ITER_METHODS.has(methodName)) &&
              (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
            ) {
              const at = compileArrowAsClosure(ctx, fctx, arg);
              if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
              else if (at === null) fctx.body.push({ op: "ref.null.extern" });
              continue;
            }
            const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: dispatchIdx });
          return { kind: "externref" };
        }

        // (#2151 Slice 4) DYNAMIC-spread any-receiver dispatch: `o.m(...xs)` where
        // `xs` is a runtime array (arity unknown at compile time), so the
        // fixed-arity `__call_m_<name>_<arity>` dispatcher above does not apply
        // (flattenCallArgs returned null). Scope: a SINGLE pure spread argument —
        // the dominant shape (`o.m(...xs)`). The vararg dispatcher
        // `__call_m_<name>_vararg(recv, args)` reads each declared param from the
        // spread array via `__extern_get_idx(args, i)`, so the array is passed
        // directly (the native indexer handles wasm vecs and $ObjVec). Mixed
        // `o.m(a, ...xs)` keeps falling through to the generic path (no
        // regression — it returns the same value as before this slice).
        //
        // Gated to `ctx.standalone` ONLY (not wasi): the `__extern_get_idx`
        // array-like / wasm-vec indexing arms the dispatcher relies on are
        // emitted only under standalone (`objArrayLikeArms = ctx.standalone` in
        // object-runtime.ts). Under wasi they are absent, so a vararg dispatcher
        // would read null args — wasi keeps the existing fall-through behaviour
        // (the same pre-existing wasi arg-vec gap noted in the issue). Widening
        // the array-like arms to wasi is a separate, broader change.
        const isSingleDynamicSpread =
          ctx.standalone &&
          !recvIsBuiltinClass &&
          expr.arguments.length === 1 &&
          ts.isSpreadElement(expr.arguments[0]!);
        if (isSingleDynamicSpread) {
          const dispatchIdx = reserveClosedMethodDispatchVararg(ctx, methodName);
          flushLateImportShifts(ctx, fctx);
          // Receiver as externref.
          const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvType && recvType.kind !== "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (recvType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          // The spread source array as externref — passed directly to the vararg
          // dispatcher, which indexes it via __extern_get_idx.
          const spreadExpr = (expr.arguments[0] as ts.SpreadElement).expression;
          const argsType = compileExpression(ctx, fctx, spreadExpr, { kind: "externref" });
          if (argsType && argsType.kind !== "externref") coerceType(ctx, fctx, argsType, { kind: "externref" });
          else if (argsType === null) fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "call", funcIdx: dispatchIdx });
          return { kind: "externref" };
        }

        // (#2151 Slice 5) MIXED-spread any-receiver dispatch: `o.m(a, ...xs)` —
        // fixed leading args followed by a single trailing DYNAMIC spread (arity
        // unknown at compile time). The fixed-arity dispatcher cannot apply
        // (flattenCallArgs returned null), and the pure-dynamic-spread vararg
        // routing above requires exactly one spread arg with no fixed leading
        // args. Here we build the combined arg vector at runtime — a fresh
        // `$ObjVec`, push each fixed leading arg (boxed to externref), then
        // loop-append the spread source's elements (`__extern_length` +
        // `__extern_get_idx`) — and hand it to the SAME
        // `__call_m_<name>_vararg(recv, args)` dispatcher, which reads each
        // declared param from the vec via `__extern_get_idx`. (`$ObjVec` is
        // exactly what `__extern_get_idx` and `__objvec_push` operate on.)
        //
        // Gated to `ctx.standalone` ONLY (same constraint as Slice 4 — the
        // `__extern_get_idx` array-like / wasm-vec indexing arms the dispatcher
        // and the loop-append rely on are emitted only under standalone). Scope:
        // exactly ONE spread, which must be the LAST argument; any other spread
        // shape (leading/middle spread, multiple spreads) keeps the existing
        // fall-through (no regression).
        const spreadCount = expr.arguments.filter((a) => ts.isSpreadElement(a)).length;
        const lastArg = expr.arguments[expr.arguments.length - 1];
        const isMixedTrailingSpread =
          ctx.standalone &&
          !recvIsBuiltinClass &&
          expr.arguments.length >= 2 &&
          spreadCount === 1 &&
          lastArg !== undefined &&
          ts.isSpreadElement(lastArg);
        if (isMixedTrailingSpread) {
          const dispatchIdx = reserveClosedMethodDispatchVararg(ctx, methodName);
          ensureObjVecBuilders(ctx);
          ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
          ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          // Re-resolve every funcIdx by name AFTER the last shift (late-import
          // index-shift class #2043): the `ensureLateImport`s above added imports,
          // which shifted EVERY defined-function index — including the vararg
          // dispatcher reserved above. funcMap holds the post-shift truth. These
          // are all unconditionally registered in standalone (the object runtime
          // provides `__objvec_*` / `__extern_*`); `!` is safe here.
          const dispatchResolvedIdx = ctx.funcMap.get(`__call_m_${methodName}_vararg`) ?? dispatchIdx;
          const objVecNew = ctx.funcMap.get("__objvec_new")!;
          const objVecPush = ctx.funcMap.get("__objvec_push")!;
          const lenFn = ctx.funcMap.get("__extern_length")!;
          const getIdxFn = ctx.funcMap.get("__extern_get_idx")!;

          // Receiver as externref → local (read once; the vec build below also
          // pushes onto the value stack, so stash the receiver first).
          const recvLocal = allocLocal(fctx, `__mspread_recv_${fctx.locals.length}`, { kind: "externref" });
          const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvType && recvType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
          else if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "local.set", index: recvLocal });

          // combined = __objvec_new()
          const argsVecLocal = allocLocal(fctx, `__mspread_args_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "call", funcIdx: objVecNew });
          fctx.body.push({ op: "local.set", index: argsVecLocal });

          // Push each fixed leading arg (all but the trailing spread).
          for (let i = 0; i < expr.arguments.length - 1; i++) {
            fctx.body.push({ op: "local.get", index: argsVecLocal });
            const at = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
            fctx.body.push({ op: "call", funcIdx: objVecPush });
          }

          // Loop-append the spread source's elements.
          const spreadSrcLocal = allocLocal(fctx, `__mspread_src_${fctx.locals.length}`, { kind: "externref" });
          const spreadExpr = (lastArg as ts.SpreadElement).expression;
          const srcType = compileExpression(ctx, fctx, spreadExpr, { kind: "externref" });
          if (srcType && srcType.kind !== "externref") coerceType(ctx, fctx, srcType, { kind: "externref" });
          else if (srcType === null) fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "local.set", index: spreadSrcLocal });

          const spreadLenLocal = allocLocal(fctx, `__mspread_len_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.get", index: spreadSrcLocal });
          fctx.body.push({ op: "call", funcIdx: lenFn });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          fctx.body.push({ op: "local.set", index: spreadLenLocal });

          const spreadIdxLocal = allocLocal(fctx, `__mspread_idx_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.set", index: spreadIdxLocal });
          fctx.body.push({
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // if idx >= len break
                  { op: "local.get", index: spreadIdxLocal },
                  { op: "local.get", index: spreadLenLocal },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // __objvec_push(combined, __extern_get_idx(src, idx))
                  { op: "local.get", index: argsVecLocal },
                  { op: "local.get", index: spreadSrcLocal },
                  { op: "local.get", index: spreadIdxLocal },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: getIdxFn },
                  { op: "call", funcIdx: objVecPush },
                  // idx++
                  { op: "local.get", index: spreadIdxLocal },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: spreadIdxLocal },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          });

          // __call_m_<name>_vararg(recv, combined)
          fctx.body.push({ op: "local.get", index: recvLocal });
          fctx.body.push({ op: "local.get", index: argsVecLocal });
          fctx.body.push({ op: "call", funcIdx: dispatchResolvedIdx });
          return { kind: "externref" };
        }

        // (#2784 S3) Native-vec-aware method dispatch. A `.push`/`.pop` on an
        // `any`/externref receiver that is actually a NATIVE vec (a reconstructed-
        // fnctor `T[]` field read as externref — acorn's `this.scopeStack`) MUST use
        // the WASM `__vec_push`/`__vec_pop` (which mutate the native array), NOT the
        // host `__extern_method_call` bridge. The host cannot introspect the opaque
        // WasmGC vec-struct, so a host `.push` lands the element in a JS-side array
        // that the native `[i]` read (`__vec_get`) never sees — a read/write STORAGE
        // SPLIT that loses the stored struct's identity (the #2784 NaN/hang). Guard:
        // `ref.test` the registered vec carriers; on hit call the native op, else
        // fall through to the host bridge in the `else` arm. Host/gc mode only (acorn
        // dogfoods there); standalone keeps the existing path (a noted follow-up).
        if (!ctx.standalone && (methodName === "push" || methodName === "pop") && ctx.vecTypeMap.size > 0) {
          // (#2784 S3) Add ALL late imports FIRST and flush, so the index space is
          // settled BEFORE reserving the native-vec helper funcIdx (a function push,
          // which does not itself shift). Reserving the helper before these imports
          // would leave its baked funcIdx stale after the import shift.
          const mcIdx = ensureLateImport(
            ctx,
            "__extern_method_call",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
          );
          const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
          const arrPushIdx = ensureLateImport(
            ctx,
            "__js_array_push",
            [{ kind: "externref" }, { kind: "externref" }],
            [],
          );
          const boxNumIdx =
            methodName === "push"
              ? ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }])
              : undefined;
          addStringConstantGlobal(ctx, methodName);
          flushLateImportShifts(ctx, fctx);
          // Reserve the helper AFTER the imports settle — its funcIdx is now final.
          // (Its body is filled in the finalize vec-export pass.)
          const vecOpIdx = reserveVecMethodHelper(ctx, methodName === "push" ? "push" : "pop");
          if (
            vecOpIdx !== undefined &&
            mcIdx !== undefined &&
            arrNewIdx !== undefined &&
            arrPushIdx !== undefined &&
            (methodName === "pop" || boxNumIdx !== undefined)
          ) {
            // Receiver → externref → recvLocal.
            const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
            else if (!recvT) fctx.body.push({ op: "ref.null.extern" });
            const recvLocal = allocLocal(fctx, `__nvm_recv_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: recvLocal });
            // push's single element → argLocal (evaluate side effects once, up front).
            let argLocal: number | undefined;
            if (methodName === "push") {
              const a = expr.arguments[0];
              if (a) {
                const at = compileExpression(ctx, fctx, a, { kind: "externref" });
                if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
                else if (!at) fctx.body.push({ op: "ref.null.extern" });
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
              argLocal = allocLocal(fctx, `__nvm_arg_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "local.set", index: argLocal });
            }
            // isVec = OR of ref.test over every registered vec carrier.
            const anyTmp = allocLocal(fctx, `__nvm_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
            fctx.body.push({ op: "local.get", index: recvLocal });
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "local.set", index: anyTmp });
            let emitted = false;
            for (const vi of new Set(ctx.vecTypeMap.values())) {
              fctx.body.push({ op: "local.get", index: anyTmp });
              fctx.body.push({ op: "ref.test", typeIdx: vi });
              if (emitted) fctx.body.push({ op: "i32.or" });
              emitted = true;
            }
            // THEN (native vec op) — emit then splice into a detached arm.
            const thenStart = fctx.body.length;
            if (methodName === "push") {
              fctx.body.push({ op: "local.get", index: recvLocal });
              fctx.body.push({ op: "local.get", index: argLocal! });
              fctx.body.push({ op: "call", funcIdx: vecOpIdx }); // -> i32 new length
              fctx.body.push({ op: "f64.convert_i32_s" });
              fctx.body.push({ op: "call", funcIdx: boxNumIdx! }); // -> externref
            } else {
              fctx.body.push({ op: "local.get", index: recvLocal });
              fctx.body.push({ op: "call", funcIdx: vecOpIdx }); // -> externref
            }
            const thenInstrs = fctx.body.splice(thenStart);
            // ELSE (host bridge) — build the args array, then __extern_method_call.
            const elseStart = fctx.body.length;
            fctx.body.push({ op: "call", funcIdx: arrNewIdx });
            const argsLocal = allocLocal(fctx, `__nvm_args_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: argsLocal });
            if (methodName === "push") {
              fctx.body.push({ op: "local.get", index: argsLocal });
              fctx.body.push({ op: "local.get", index: argLocal! });
              fctx.body.push({ op: "call", funcIdx: arrPushIdx });
            }
            fctx.body.push({ op: "local.get", index: recvLocal });
            fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
            fctx.body.push({ op: "local.get", index: argsLocal });
            fctx.body.push({ op: "call", funcIdx: mcIdx });
            const elseInstrs = fctx.body.splice(elseStart);
            fctx.body.push({
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } as ValType },
              then: thenInstrs,
              else: elseInstrs,
            });
            return { kind: "externref" };
          }
        }

        // (#799 WI3) Generic host-delegated method call for any/externref receivers.
        // Builds a JS array of arguments and calls __extern_method_call(obj, methodName, args).
        // (#965) For known built-in class identifiers (Object, Array, Proxy, etc.) that would
        // otherwise compile to ref.null.extern, use __get_builtin to get the real JS object.
        {
          // (#1888 Slice 2) Under --target standalone the native
          // __extern_method_call reads its args via __extern_length /
          // __extern_get_idx over a $ObjVec (no JS array exists). Build the args
          // list with the native $ObjVec builders instead of the host
          // __js_array_new / __js_array_push. JS-host / WASI keep the host
          // imports unchanged (byte-for-byte). Per the #1472 S3 note, the
          // __js_array_* builders are NOT globally safe to alias (real JS arrays
          // elsewhere depend on them) — so this is a per-call-site swap.
          let arrNewIdx: number | undefined;
          let arrPushIdx: number | undefined;
          if (ctx.standalone) {
            const b = ensureObjVecBuilders(ctx);
            arrNewIdx = b.newIdx;
            arrPushIdx = b.pushIdx;
          } else {
            arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
            arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
          }
          const methodCallIdx = ensureLateImport(
            ctx,
            "__extern_method_call",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
          );
          // For built-in class identifiers, import __get_builtin to resolve real JS object
          const receiverIsBuiltin =
            ts.isIdentifier(propAccess.expression) && BUILTIN_CLASS_NAMES.has(propAccess.expression.text);
          const getBuiltinIdx = receiverIsBuiltin
            ? ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }])
            : undefined;
          flushLateImportShifts(ctx, fctx);

          if (methodCallIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
            // Compile receiver as externref.
            // For known built-in class identifiers, use __get_builtin to get the real JS object
            // instead of the null produced by compileIdentifier's graceful fallback.
            let recvType: ValType | null;
            if (receiverIsBuiltin && getBuiltinIdx !== undefined) {
              const builtinName = (propAccess.expression as ts.Identifier).text;
              addStringConstantGlobal(ctx, builtinName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
              fctx.body.push({ op: "call", funcIdx: getBuiltinIdx });
              recvType = { kind: "externref" };
            } else {
              recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
              if (recvType && recvType.kind !== "externref") {
                fctx.body.push({ op: "extern.convert_any" });
              }
            }
            const recvLocal = allocLocal(fctx, `__emc_recv_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: recvLocal });

            // Build args array
            fctx.body.push({ op: "call", funcIdx: arrNewIdx });
            const argsLocal = allocLocal(fctx, `__emc_args_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: argsLocal });

            for (const arg of expr.arguments) {
              fctx.body.push({ op: "local.get", index: argsLocal });
              const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
              if (argType && argType.kind !== "externref") {
                fctx.body.push({ op: "extern.convert_any" });
              }
              if (argType === null) {
                fctx.body.push({ op: "ref.null.extern" });
              }
              fctx.body.push({ op: "call", funcIdx: arrPushIdx });
            }

            // Push receiver, method name, args array → call __extern_method_call
            fctx.body.push({ op: "local.get", index: recvLocal });
            addStringConstantGlobal(ctx, methodName);
            fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
            fctx.body.push({ op: "local.get", index: argsLocal });
            fctx.body.push({ op: "call", funcIdx: methodCallIdx });
            return { kind: "externref" };
          }

          // Fallback if imports unavailable: evaluate for side effects, return null
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType) {
            fctx.body.push({ op: "drop" });
          }
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType) {
              fctx.body.push({ op: "drop" });
            }
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }
  }

  // (#742) Identifier-callee dispatch — node:fs global functions, inline
  // global builtins (parseInt/isNaN/parseFloat/isFinite/Array/…), and direct
  // named-function calls resolved via funcMap. Extracted verbatim to
  // compileIdentifierCall; an `undefined` result means the callee is not one
  // of these identifier cases, so dispatch continues below (IIFE / super / …).
  {
    const __idResult = compileIdentifierCall(ctx, fctx, expr);
    if (__idResult !== undefined) return __idResult;
  }

  // Handle IIFE: (function() { ... })() or (() => expr)() — inline the function body
  {
    // Unwrap parenthesized expression to find the function/arrow
    let callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
      // Generator function expressions (function*) must NOT be inlined as IIFEs
      // because their body contains `yield` which requires a generator context.
      // Let them fall through to the normal closure compilation path (#657).
      const isGeneratorIIFE = ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined;
      // (#2707c) A *recursive* named function expression IIFE —
      // `(function f(n){ … f(n-1) … })(N)` — must NOT be inlined either: the
      // inlined body has no real callable to bind its own name `f` to, so the
      // self-call silently fails to recurse (the base case is never reached, so
      // e.g. a test262 TCO counter stays 0). Compile it as a closure instead —
      // the closure path binds the function-expression's own name via `__self`
      // (the lifted param-0 self-reference), exactly as it already does for
      // `var g = function f(n){ … f(n-1) … }`. Conservative: ANY reference to
      // the own name inside the body routes here (compile-as-closure is always
      // semantically correct, just unInlined), so a shadowed reference can never
      // be mis-inlined.
      const isRecursiveNamedFnExprIIFE =
        ts.isFunctionExpression(callee) && callee.name !== undefined && functionExprBodyReferencesOwnName(callee);
      if (isGeneratorIIFE || isRecursiveNamedFnExprIIFE) {
        // Cannot inline: a generator IIFE needs a generator context for `yield`,
        // and a recursive named-fn-expr IIFE needs a real callable to bind its
        // own name to. Compile as closure, store in temp local, invoke via
        // call_ref — the closure path binds `function*`'s context and a named
        // expression's own name (self-reference) correctly.
        const closureType = compileArrowFunction(ctx, fctx, callee as ts.FunctionExpression);
        if (closureType && (closureType.kind === "ref" || closureType.kind === "ref_null")) {
          const typeIdx = (closureType as { typeIdx: number }).typeIdx;
          const closureInfo = ctx.closureInfoByTypeIdx.get(typeIdx);
          if (closureInfo) {
            // Store closure ref in a temp local
            const tmpName = `__iife_closure_${fctx.locals.length}`;
            const tmpLocal = allocLocal(fctx, tmpName, closureType);
            fctx.body.push({ op: "local.set", index: tmpLocal });
            // Register the temp local so compileClosureCall can find it
            fctx.localMap.set(tmpName, tmpLocal);
            return compileClosureCall(ctx, fctx, expr, tmpName, closureInfo);
          }
        }
        // If closure compilation failed, drop any value on stack and fall through to fallback
        if (closureType) {
          fctx.body.push({ op: "drop" });
        }
      } else {
        const params = callee.parameters;
        const args = expr.arguments;
        // Check if the IIFE body references `arguments` (only for function expressions, not arrows)
        const iifeNeedsArguments = ts.isFunctionExpression(callee) && callee.body && usesArguments(callee.body);
        // Support IIFEs with matching parameter/argument counts
        if (params.length <= args.length) {
          // (#3128) Record that this function node is being INLINED into the
          // current fctx: its AST function boundary does not exist in the
          // emitted Wasm. The closure capture-mutability analysis
          // (compileArrowAsClosure `writtenInOuter`) reads this to walk PAST
          // the IIFE when locating the real enclosing scope — otherwise a
          // closure inside the IIFE body that captures an outer var written
          // outside the IIFE (`p2 = (function(){ return () => p2; })()`)
          // misses the write and captures a stale by-value copy.
          (fctx.inlinedIifeNodes ??= new Set()).add(callee);
          // Allocate locals for parameters and compile arguments
          const paramLocals: number[] = [];
          const allArgLocals: { idx: number; type: ValType }[] = [];
          for (let i = 0; i < params.length; i++) {
            const param = params[i]!;
            const paramName = ts.isIdentifier(param.name) ? param.name.text : `__iife_p${i}`;
            const argType = compileExpression(ctx, fctx, args[i]!);
            const localType = argType ?? { kind: "f64" as const };
            const idx = allocLocal(fctx, paramName, localType);
            fctx.body.push({ op: "local.set", index: idx });
            paramLocals.push(idx);
            if (iifeNeedsArguments) {
              allArgLocals.push({ idx, type: localType });
            }
          }
          // Extra arguments beyond declared params
          if (iifeNeedsArguments) {
            // Store extra args in locals for the arguments object
            for (let i = params.length; i < args.length; i++) {
              const t = compileExpression(ctx, fctx, args[i]!);
              const localType = t ?? { kind: "f64" as const };
              if (t === null) {
                // No value produced — push a default
                fctx.body.push({ op: "f64.const", value: 0 });
              }
              const idx = allocLocal(fctx, `__iife_extra_${i}`, localType as ValType);
              fctx.body.push({ op: "local.set", index: idx });
              allArgLocals.push({ idx, type: localType as ValType });
            }
          } else {
            // Drop extra arguments (evaluate for side effects)
            for (let i = params.length; i < args.length; i++) {
              const t = compileExpression(ctx, fctx, args[i]!);
              if (t) {
                fctx.body.push({ op: "drop" });
              }
            }
          }

          // Set up `arguments` vec for the IIFE if needed
          if (iifeNeedsArguments && allArgLocals.length > 0) {
            // Ensure __box_number is available for boxing numeric args
            const hasNumeric = allArgLocals.some((a) => a.type.kind === "f64" || a.type.kind === "i32");
            if (hasNumeric) {
              ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
            }

            const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
            const ati = getArrTypeIdxFromVec(ctx, vti);
            const vecRef: ValType = { kind: "ref", typeIdx: vti };
            const argsLocal = allocLocal(fctx, "arguments", vecRef);
            const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });

            for (const { idx, type } of allArgLocals) {
              fctx.body.push({ op: "local.get", index: idx });
              if (type.kind === "f64") {
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (type.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (type.kind === "ref" || type.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" });
              }
              // externref: already correct
            }
            fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: allArgLocals.length });
            fctx.body.push({ op: "local.set", index: arrTmp });
            fctx.body.push({ op: "i32.const", value: allArgLocals.length });
            fctx.body.push({ op: "local.get", index: arrTmp });
            fctx.body.push({ op: "struct.new", typeIdx: vti });
            fctx.body.push({ op: "local.set", index: argsLocal });
          } else if (iifeNeedsArguments) {
            // No arguments at all — create empty arguments vec
            const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
            const ati = getArrTypeIdxFromVec(ctx, vti);
            const vecRef: ValType = { kind: "ref", typeIdx: vti };
            const argsLocal = allocLocal(fctx, "arguments", vecRef);
            const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });
            fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: 0 });
            fctx.body.push({ op: "local.set", index: arrTmp });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "local.get", index: arrTmp });
            fctx.body.push({ op: "struct.new", typeIdx: vti });
            fctx.body.push({ op: "local.set", index: argsLocal });
          }

          // Compile body
          if (ts.isArrowFunction(callee) && !ts.isBlock(callee.body)) {
            // Concise body: expression — no return issue
            return compileExpression(ctx, fctx, callee.body);
          }

          // Block body (arrow or function expression) — need to handle return
          const bodyStmts = ts.isArrowFunction(callee) ? (callee.body as ts.Block).statements : callee.body.statements;
          if (bodyStmts.length === 0) {
            return VOID_RESULT;
          }

          // Determine return type from TS
          const iifeRetType = ctx.checker.getTypeAtLocation(expr);
          let iifeWasmRetType = isVoidType(iifeRetType) ? null : resolveWasmType(ctx, iifeRetType);
          // (#3128) The ret-local type must agree with what the returned
          // expression will ACTUALLY lower to. Under standalone, an object
          // literal in any/unknown/dictionary context diverts to the open
          // `$Object` path and produces an **externref**
          // (`objectLiteralTakesStandaloneAnyObjectPath`, the #1901/#2542
          // gate) — but `resolveWasmType` types the ret local from the TS
          // struct type. The return-site coercion externref→(ref null $struct)
          // then goes through a `ref.test` arm that silently yields NULL
          // (measured: `p2 = (function(){ return { a: (function(){ return
          // p2; }) }; })()` — p2 read back null; the #3128-A cell write itself
          // was correct, it faithfully wrote the nulled ret value). Mirror the
          // literal's own divert decision here and widen the ret local to
          // externref; struct-typed sibling returns coerce ref→externref
          // losslessly (`extern.convert_any`). Scan only the IIFE's OWN
          // returns — nested function boundaries keep their own return type.
          if (iifeWasmRetType && (iifeWasmRetType.kind === "ref" || iifeWasmRetType.kind === "ref_null")) {
            let divertedObjlitReturn = false;
            const scanReturns = (node: ts.Node): void => {
              if (divertedObjlitReturn) return;
              if (ts.isFunctionLike(node) && node !== callee) return;
              if (ts.isReturnStatement(node) && node.expression) {
                let retExpr: ts.Expression = node.expression;
                while (ts.isParenthesizedExpression(retExpr)) retExpr = retExpr.expression;
                if (ts.isObjectLiteralExpression(retExpr) && objectLiteralTakesStandaloneAnyObjectPath(ctx, retExpr)) {
                  divertedObjlitReturn = true;
                  return;
                }
              }
              forEachChild(node, scanReturns);
            };
            for (const stmt of bodyStmts) scanReturns(stmt);
            if (divertedObjlitReturn) {
              iifeWasmRetType = { kind: "externref" };
            }
          }

          if (iifeWasmRetType) {
            // Returning IIFE: allocate a result local, compile body into a block,
            // and replace `return` with `local.set + br` to exit the block
            const retLocal = allocLocal(fctx, `__iife_ret_${fctx.locals.length}`, iifeWasmRetType);
            const savedBody = fctx.body;
            fctx.savedBodies.push(savedBody);
            const blockBody: Instr[] = [];
            fctx.body = blockBody;

            // Save and override returnType so that return statements inside the
            // IIFE coerce to the IIFE's own return type, not the outer function's.
            // Without this, a boolean-returning IIFE inside an f64-returning
            // function would coerce i32→f64 before local.set into an i32 local.
            const savedReturnType = fctx.returnType;
            fctx.returnType = iifeWasmRetType;

            // Hoist let/const with TDZ flags so accesses before init throw (#790)
            hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
            // Hoist function declarations so they're available before textual position
            hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);

            // Increase block depth so return→br targets the right level
            fctx.blockDepth++;
            for (const stmt of bodyStmts) {
              compileStatement(ctx, fctx, stmt);
            }
            fctx.blockDepth--;

            // Restore outer function's return type
            fctx.returnType = savedReturnType;
            fctx.savedBodies.pop();
            fctx.body = savedBody;

            // Post-process: replace `return` / `return_call` / `return_call_ref` ops
            // with `local.set retLocal + br <depth>`.  Tail-call optimization in
            // compileReturnStatement may have merged call+return into return_call;
            // inside an IIFE we must undo that since we need local.set + br instead.
            function patchReturns(instrs: Instr[], depth: number): void {
              for (let i = 0; i < instrs.length; i++) {
                const op = instrs[i]!.op;
                if (op === "return") {
                  // The instruction before `return` is the return value expression.
                  // Replace `return` with `local.set + br`
                  instrs[i] = { op: "local.set", index: retLocal };
                  instrs.splice(i + 1, 0, { op: "br", depth });
                  i++; // skip the inserted br
                } else if (op === "return_call" || op === "return_call_ref") {
                  // Undo tail-call: return_call funcIdx → call funcIdx + local.set + br
                  const instr = instrs[i] as any;
                  instr.op = op === "return_call" ? "call" : "call_ref";
                  instrs.splice(i + 1, 0, { op: "local.set", index: retLocal }, { op: "br", depth });
                  i += 2; // skip inserted instructions
                }
                // Recurse into sub-blocks (if/then/else/block/loop)
                const instr = instrs[i] as any;
                if (instr.then) patchReturns(instr.then, depth + 1);
                if (instr.else) patchReturns(instr.else, depth + 1);
                if (instr.body && Array.isArray(instr.body)) patchReturns(instr.body, depth + 1);
              }
            }
            patchReturns(blockBody, 0);

            // Emit: block { <body> } local.get retLocal
            fctx.body.push({
              op: "block",
              blockType: { kind: "empty" },
              body: blockBody,
            });
            fctx.body.push({ op: "local.get", index: retLocal });
            return iifeWasmRetType;
          } else {
            // Void IIFE — wrap the body in a block so that `return` inside
            // the IIFE exits ONLY the IIFE rather than the enclosing function
            // (#1348). Without this wrapper, e.g.
            //   (function () { for (var x of it) { return; } }());
            // would emit a Wasm `return` from the outer function, dropping
            // any `for-of`-followups (post-IIFE asserts) and breaking the
            // §14.7.5 IteratorClose-on-return semantics expected by callers.
            const savedBody = fctx.body;
            fctx.savedBodies.push(savedBody);
            const blockBody: Instr[] = [];
            fctx.body = blockBody;

            // Save and override returnType: void IIFE has no return value,
            // so any `return <expr>;` inside the body should drop the value
            // (we model this by setting returnType=null which causes
            // compileReturnStatement to drop the expression value).
            const savedReturnType = fctx.returnType;
            fctx.returnType = null;

            // Hoist let/const with TDZ flags so accesses before init throw (#790)
            hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
            // Hoist function declarations so they're available before textual position
            hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);

            // Increase block depth so return→br targets the right level
            fctx.blockDepth++;
            for (const stmt of bodyStmts) {
              compileStatement(ctx, fctx, stmt);
            }
            fctx.blockDepth--;

            // Restore outer function's return type
            fctx.returnType = savedReturnType;
            fctx.savedBodies.pop();
            fctx.body = savedBody;

            // Post-process: replace `return` / `return_call` / `return_call_ref`
            // with `br <depth>`. Tail-call optimization in compileReturnStatement
            // may have merged call+return into return_call; inside an IIFE we
            // must undo that and lower it back to a plain call.
            function patchVoidReturns(instrs: Instr[], depth: number): void {
              for (let i = 0; i < instrs.length; i++) {
                const op = instrs[i]!.op;
                if (op === "return") {
                  // void IIFE: no value to capture — replace with br
                  instrs[i] = { op: "br", depth };
                } else if (op === "return_call" || op === "return_call_ref") {
                  // Undo tail-call: rewrite as plain call + br
                  const instr = instrs[i] as any;
                  instr.op = op === "return_call" ? "call" : "call_ref";
                  instrs.splice(i + 1, 0, { op: "br", depth });
                  i++; // skip inserted br
                }
                const instr = instrs[i] as any;
                if (instr.then) patchVoidReturns(instr.then, depth + 1);
                if (instr.else) patchVoidReturns(instr.else, depth + 1);
                if (instr.body && Array.isArray(instr.body)) patchVoidReturns(instr.body, depth + 1);
                if (instr.catchAll && Array.isArray(instr.catchAll)) patchVoidReturns(instr.catchAll, depth + 1);
                if (Array.isArray(instr.catches)) {
                  for (const c of instr.catches) {
                    if (Array.isArray(c.body)) patchVoidReturns(c.body, depth + 1);
                  }
                }
              }
            }
            patchVoidReturns(blockBody, 0);

            // Emit: block { <body> }
            fctx.body.push({
              op: "block",
              blockType: { kind: "empty" },
              body: blockBody,
            });
            return VOID_RESULT;
          }
        }
      } // end else (non-generator IIFE)
    }
  }

  // Handle standalone super() calls (constructor chaining) — top-level super(...)
  // statements are handled inline by compileClassBodies, which short-circuits the
  // ExpressionStatement before it reaches this path. When `super(...)` appears
  // nested inside control flow (try/catch, if/loop) inside the user constructor,
  // the inline handler doesn't see it. To preserve §13.3.7.1 step 4 (ArgumentList­
  // Evaluation + ReturnIfAbrupt) we evaluate every argument left-to-right here
  // for side effects, dropping the resulting value. Parent-field assignment
  // remains best-effort: nested-super field forwarding is handled by the
  // inline path; this fallback ensures throws from arg expressions propagate
  // to the user's try/catch (#1551).
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    for (const arg of expr.arguments) {
      const inner = ts.isSpreadElement(arg) ? arg.expression : arg;
      const argResult = compileExpression(ctx, fctx, inner);
      if (argResult !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    // (#1551) Return VOID_RESULT, NOT null. A `null` return signals "no usable
    // value" to the #1919 speculative wrapper in compileExpressionBody, which
    // then calls rollbackSpeculative — TRUNCATING the argument-evaluation
    // instructions we just emitted (including a throwing super-arg call) and
    // replacing them with a default constant. That rollback is exactly why the
    // super-arg throw escaped the enclosing try-region: the exception-raising
    // call was deleted before it could run, so the user's `catch` never fired
    // and execution fell through past `super(...)`. VOID_RESULT means "compiled,
    // void result, KEEP the emitted instructions" — the wrapper preserves the
    // arg evaluation so ArgumentListEvaluation's abrupt completion propagates.
    return VOID_RESULT;
  }

  // Handle IIFE: (function(...) { ... })(...) — immediately invoked function expression
  {
    const iifeResult = compileIIFE(ctx, fctx, expr);
    if (iifeResult !== undefined) return iifeResult;
  }

  // Handle comma-operator indirect calls: (0, foo)() or (expr, fn)()
  // Unwrap parenthesized comma expression, evaluate left for side effects, call right.
  {
    let callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // Evaluate left side for side effects and drop
      const leftType = compileExpression(ctx, fctx, callee.left);
      if (leftType) {
        fctx.body.push({ op: "drop" });
      }
      // Create a synthetic call with the right side as callee
      const syntheticCall = ts.factory.createCallExpression(
        callee.right as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      // Preserve parent for type checker resolution
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle ElementAccessExpression calls: obj['method']() or obj[0]() or obj[constKey]()
  // Convert to equivalent property access method call when the index resolves to a static key.
  if (ts.isElementAccessExpression(expr.expression)) {
    const elemAccess = expr.expression;
    const argExpr = elemAccess.argumentExpression;
    // Resolve the key to a static string: string literals, numeric literals, const variables, etc.
    let resolvedMethodName: string | undefined;
    if (argExpr) {
      if (ts.isStringLiteral(argExpr)) {
        resolvedMethodName = argExpr.text;
      } else if (ts.isNumericLiteral(argExpr)) {
        resolvedMethodName = String(Number(argExpr.text));
      } else {
        resolvedMethodName = resolveComputedKeyExpression(ctx, argExpr);
      }
    }

    // Handle super['method']() calls — resolve to ParentClass_method with this as first arg
    if (elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword && resolvedMethodName !== undefined) {
      return compileSuperElementMethodCall(ctx, fctx, expr, resolvedMethodName);
    }

    if (resolvedMethodName !== undefined) {
      const methodName = resolvedMethodName;
      const receiverType = ctx.checker.getTypeAtLocation(elemAccess.expression);

      // Iterator protocol dispatch (#1016b): obj[Symbol.iterator]() and
      // obj[Symbol.asyncIterator]() must drive the iterator protocol via the
      // host imports __iterator / __async_iterator. Without this, calls like
      // `array[Symbol.iterator]()` fall through to the null-pushing fallback
      // because no class method `__@@iterator` is registered for built-in JS
      // iterables (TypedArray, Map, Set, RegExpStringIterator, etc.).
      // The runtime __iterator handles all dispatch paths:
      //   - direct Symbol.iterator on JS objects
      //   - sidecar @@iterator on WasmGC structs
      //   - WasmGC closure via __call_fn_0
      //   - __call_@@iterator export for user-defined iterable classes
      //   - __vec_len/__vec_get fallback for vec structs (arrays)
      if (methodName === "@@iterator" || methodName === "@@asyncIterator") {
        // (#3013) Standalone/WASI: `<array>[Symbol.iterator]()` is, per
        // §23.1.3.40, the SAME operation as `Array.prototype.values` —
        // `Array.prototype[Symbol.iterator] === Array.prototype.values`. Route an
        // array receiver to the native `.values()` lowering so it produces the
        // identical `$__IterRec` value host-free, instead of leaking the
        // `env::__iterator` host import (the sole leak of the array-iterator
        // conformance cluster). The `.values()`/`.keys()`/`.entries()` forms are
        // already native; this closes the `[Symbol.iterator]()` gap. Host/gc mode
        // keeps the existing `__iterator` bridge (byte-inert). Async iterator and
        // non-array receivers fall through unchanged.
        if (methodName === "@@iterator" && (ctx.standalone || ctx.wasi) && resolveArrayInfo(ctx, receiverType)) {
          const nativeResult = compileArrayMethodCall(ctx, fctx, elemAccess, expr, receiverType, "values");
          if (nativeResult !== undefined && nativeResult !== null) return nativeResult as ValType;
          // Fall through to the host bridge if the native path declined.
        }
        const importName = methodName === "@@iterator" ? "__iterator" : "__async_iterator";
        const recvType = compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType) {
          if (recvType.kind === "ref" || recvType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (recvType.kind === "f64") {
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else if (recvType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
          // externref / funcref / other: assume already iterable-shaped
        }
        // Iterator methods take no arguments; evaluate any extras for side effects only.
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType) fctx.body.push({ op: "drop" });
        }
        const iterIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (iterIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: iterIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        return { kind: "externref" };
      }

      // (#1439) RegExp.prototype[@@replace/@@match/@@search/@@split/@@matchAll]
      // protocol dispatch. `regex[Symbol.replace](str, replaceValue)` is the
      // ECMAScript §22.2.5 mechanism that `String.prototype.replace` and
      // friends delegate to. The receiver is an externref (RegExp lives in
      // the host), so a direct call_ref on the property access would deref
      // a null pointer — there's no Wasm function bound to the symbol key
      // on a host object. Route to `__regex_symbol_call(regex, id, arg0, arg1)`
      // which performs `regex[Symbol.X](arg0[, arg1])` in JS land.
      {
        const REGEX_SYMBOL_METHODS: Record<string, number> = {
          "@@match": 7,
          "@@replace": 8,
          "@@search": 9,
          "@@split": 10,
          "@@matchAll": 15,
        };
        const protocolId = REGEX_SYMBOL_METHODS[methodName];
        if (protocolId !== undefined) {
          // Receiver is RegExp, or its static type is unresolvable (`any` /
          // `unknown`) so we cannot prove it is *not* a RegExp. The latter
          // covers `(re as any)[Symbol.split](str)`, a RegExp stored in an
          // `any`/parameter slot, and `RegExp.prototype[Symbol.split]`
          // accessed off a base that loses its type (#1331). In all these
          // cases the host helper `__regex_symbol_call` does a fully dynamic
          // `recv[Symbol.X](args)` lookup, so routing here is correct for any
          // object that implements the well-known symbol method — not just
          // RegExp. We must NOT catch receivers that resolve to a user-defined
          // wasm class (handled by the ClassName_method dispatch below) or the
          // `@@iterator`/`@@asyncIterator` cases (already handled above).
          const recvSym = receiverType.getSymbol()?.name;
          // (#1330) When a regex flows through an `any`/unresolved variable —
          // the common test262 shape `re[Symbol.search](s)` with `re: any` —
          // recvSym is undefined and the narrow `=== "RegExp"` guard rejects
          // it, so dispatch falls through to generic method lookup which can't
          // resolve the "@@search" string key → returns 0/undefined. Route
          // these through `__regex_symbol_call` too: the host import validates
          // the receiver at runtime (throws the correct TypeError if it isn't a
          // RegExp), so widening here is spec-safe. Stay narrow for receivers
          // that resolve to a *user* class/struct, which may define their own
          // @@match/@@replace/etc.
          const isRegExpRecv = recvSym === "RegExp" || recvSym === "RegExpConstructor";
          let resolvedClassName = receiverType.getSymbol()?.name;
          if (resolvedClassName && !ctx.classSet.has(resolvedClassName)) {
            resolvedClassName = ctx.classExprNameMap.get(resolvedClassName) ?? resolvedClassName;
          }
          const recvIsUserClass = !!resolvedClassName && ctx.classSet.has(resolvedClassName);
          const recvIsUnresolved = (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
          if ((isRegExpRecv || recvIsUnresolved) && !recvIsUserClass) {
            if (ctx.standalone) {
              // (#2161) Route the well-known-symbol protocol READ forms
              // (`re[Symbol.match/matchAll/search](str)`) to the native engine
              // for static / backend-created RegExp receivers — the
              // operand-swapped dual of the String.prototype.* native path.
              // Returns undefined for forms not yet wired (dynamic receivers,
              // @@replace/@@split, string-coercion args), which fall through to
              // the refusal below.
              const symResult = tryCompileStandaloneRegExpSymbolCall(
                ctx,
                fctx,
                expr,
                elemAccess.expression,
                methodName,
              );
              if (symResult !== undefined) return symResult;
              reportError(
                ctx,
                expr,
                `Codegen error: standalone RegExp literal-substring backend does not support ` +
                  `${methodName} symbol protocol calls (#682/#1474). Use RegExp.prototype.test ` +
                  `with a plain static pattern and no flags, or recompile without --target standalone.`,
              );
              return null;
            }

            // Push receiver as externref (already a RegExp host object)
            const recvType = compileExpression(ctx, fctx, elemAccess.expression);
            if (recvType) {
              if (recvType.kind === "ref" || recvType.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" });
              } else if (recvType.kind === "f64") {
                const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
              } else if (recvType.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            // symbol ID
            fctx.body.push({ op: "i32.const", value: protocolId });
            // arg0 (the string operand) — coerce to externref
            if (expr.arguments.length > 0) {
              const a0 = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
              if (a0) {
                if (a0.kind === "ref" || a0.kind === "ref_null") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (a0.kind === "f64") {
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else if (a0.kind === "i32") {
                  fctx.body.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                }
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else {
              // Spec: ToString(undefined) → "undefined" — but at the host
              // boundary an `undefined` externref roundtrip is fine because
              // the host method does its own ToString coercion.
              fctx.body.push({ op: "ref.null.extern" });
            }
            // arg1 (replaceValue / limit) — coerce to externref, default null
            if (expr.arguments.length > 1) {
              const a1 = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
              if (a1) {
                if (a1.kind === "ref" || a1.kind === "ref_null") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (a1.kind === "f64") {
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else if (a1.kind === "i32") {
                  fctx.body.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                }
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            // Drop any extra arguments (evaluate for side effects)
            for (let i = 2; i < expr.arguments.length; i++) {
              const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extra !== null) fctx.body.push({ op: "drop" });
            }
            const callIdx = ensureLateImport(
              ctx,
              "__regex_symbol_call",
              [{ kind: "externref" }, { kind: "i32" }, { kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (callIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: callIdx });
            } else {
              // Shouldn't happen, but be defensive
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
            return { kind: "externref" };
          }
        }
      }

      // Try class instance method: ClassName_methodName
      let receiverClassName = receiverType.getSymbol()?.name;
      if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
        receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
      }
      if (receiverClassName && ctx.classSet.has(receiverClassName)) {
        const fullName = `${receiverClassName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument
          compileExpression(ctx, fctx, elemAccess.expression);
          // Push remaining arguments with type hints
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaMethodParamCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, eaMethodParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return VOID_RESULT;
        }
      }

      // Try struct method: structName_methodName
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          const recvType = compileExpression(ctx, fctx, elemAccess.expression);
          // Check if receiver went through emitGuardedRefCast — null may mean
          // "wrong struct type" rather than genuinely null (#789)
          const eaReceiverWasCast = (fctx as any).__lastGuardedCastBackup !== undefined;
          // Null-guard: if receiver is ref_null, check for null before calling method
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName))
                callReturnType = brandExternMethodResult(
                  ctx,
                  retType,
                  getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
                );
            }
            const tmp = allocLocal(fctx, `__ng_ea_recv_${fctx.locals.length}`, recvType);
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" });
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaNgParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaNgParamCount) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (let i = Math.min(expr.arguments.length, eaNgParamCount) + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            fctx.body.push({ op: "call", funcIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              // If null after cast, skip (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: eaReceiverWasCast ? [] : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType =
                callReturnType.kind === "ref"
                  ? {
                      kind: "ref_null",
                      typeIdx: (callReturnType as any).typeIdx,
                    }
                  : callReturnType;
              // If null after cast, default (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: eaReceiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaNnParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaNnParamCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, eaNnParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return VOID_RESULT;
        }
      }

      // Try static method: ClassName.staticMethod via element access
      if (ts.isIdentifier(elemAccess.expression) && ctx.classSet.has(elemAccess.expression.text)) {
        const clsName = elemAccess.expression.text;
        const fullName = `${clsName}_${methodName}`;
        if (ctx.staticMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined) {
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaStaticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaStaticParamCount) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            fctx.body.push({ op: "call", funcIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
              return brandExternMethodResult(
                ctx,
                retType,
                getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
              );
            }
            return VOID_RESULT;
          }
        }
      }

      // Try string method: string_methodName
      if (isStringType(receiverType)) {
        // (#3027) Native-strings mode (standalone/wasi `--nativeStrings`)
        // never registers the host `string_<method>` import looked up right
        // below — a computed-key string method call (`"str"["charAt"](i)`,
        // `new String(x)["slice"](i)`) always found `funcIdx === undefined`
        // and fell through every later branch to the generic dynamic-call
        // fallback, which produces a null/non-callable value for a native
        // string or wrapper receiver (there is no host `$Object` to ask) —
        // manifesting downstream as "Cannot access property on null or
        // undefined". The dot form (`"str".charAt(i)`) already dispatches
        // correctly through the native `__str_*` engine (incl. the String-
        // wrapper `__to_primitive` unwrap) earlier in this same function;
        // recompile this call as the equivalent dot form (same receiver, same
        // method, same arguments) so it takes that exact path instead of
        // duplicating the logic here.
        if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
          const syntheticProp = ts.factory.createPropertyAccessExpression(elemAccess.expression, methodName);
          ts.setTextRange(syntheticProp, elemAccess);
          (syntheticProp as unknown as { parent: ts.Node }).parent = expr;
          const syntheticCall = ts.factory.createCallExpression(syntheticProp, expr.typeArguments, expr.arguments);
          ts.setTextRange(syntheticCall, expr);
          (syntheticCall as unknown as { parent: ts.Node }).parent = expr.parent;
          return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
        }
        const importName = `string_${methodName}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, elemAccess.expression);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const args = expr.arguments;
          for (let ai = 0; ai < args.length; ai++) {
            const argResult = compileExpression(ctx, fctx, args[ai]!);
            const expectedType = paramTypes?.[ai + 1];
            if (argResult && expectedType && argResult.kind !== expectedType.kind) {
              coerceType(ctx, fctx, argResult, expectedType);
            }
          }
          if (paramTypes && args.length + 1 < paramTypes.length) {
            for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
              const pt = paramTypes[pi]!;
              if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
              else if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
              else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          const returnsBool = methodName === "includes" || methodName === "startsWith" || methodName === "endsWith";
          return returnsBool
            ? { kind: "i32" }
            : methodName === "indexOf" || methodName === "lastIndexOf" || methodName === "search"
              ? { kind: "f64" }
              : { kind: "externref" };
        }
      }

      // Try number method: number.toString(), number.toFixed(), toPrecision(), toExponential()
      if (
        isNumberType(receiverType) &&
        (methodName === "toString" ||
          methodName === "toFixed" ||
          methodName === "toPrecision" ||
          methodName === "toExponential")
      ) {
        // RangeError validation for toString(radix) — radix must be integer 2-36
        // (#2029 family C) Hoisted so the call below can PASS the radix — the
        // old code validated it, then called the 1-arg `number_toString`
        // (radix silently dropped → `5["toString"](2)` returned "5").
        let radixLocal: number | undefined;
        if (methodName === "toString" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
          // Floor the radix (ToInteger semantics)
          fctx.body.push({ op: "f64.floor" });
          radixLocal = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 2 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 36 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          // Check radix is NaN (NaN != NaN)
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
            // (#2029 family C) Dual-mode message push — the raw
            // `global.get stringGlobalMap.get(msg)!` baked the -1 sentinel
            // under standalone/nativeStrings (`5["toString"](2)` emit-crashed
            // with "global index out of range — -1"); the dot-access twin of
            // this site already uses the helper. Host mode is byte-identical.
            addStringConstantGlobal(ctx, rangeErrMsg);
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
              else: [],
            });
          }
          // radix was consumed by the validation comparisons above (via local.tee),
          // no extra drop needed
        }
        const exprType = compileExpression(ctx, fctx, elemAccess.expression);
        if (exprType && exprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        if (methodName === "toFixed" && expr.arguments.length > 0) {
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // RangeError: fractionDigits must be 0-100
          const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 100 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
            // (#2029 family C) Dual-mode message push — see the toString()
            // radix twin above (`1["toFixed"](5)` was the standalone
            // emit-crash repro for property-accessors/S11.2.1_A3_T2).
            addStringConstantGlobal(ctx, rangeErrMsg);
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
              else: [],
            });
          }
          fctx.body.push({ op: "local.get", index: digitsLocal });
        } else if (methodName === "toFixed") {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        if (methodName === "toPrecision" && expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
          // (#3078) explicit `undefined` precision ≡ no arg (§21.1.3.5 step 2) —
          // route to the `toString`-equivalent else branch, not ToInteger→0.
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // (#49) See `number.toPrecision` site above — the precision
          // range check was moved into the runtime helper because per
          // spec §21.1.3.5 step 4, non-finite receivers must return
          // Number::toString(x) BEFORE the range check fires.
        } else if (methodName === "toPrecision") {
          // No argument → same as toString()
          const funcIdx = ctx.funcMap.get("number_toString");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "toExponential" && expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
          // (#3078) explicit `undefined` fractionDigits ≡ no arg (§21.1.3.3
          // step 2) — route to the NaN-sentinel else branch (variable digits),
          // not ToInteger→0.
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // (#49) See `number.toExponential` site above — the
          // fractionDigits range check was moved into the runtime
          // helper because per spec §21.1.3.3 step 3, non-finite
          // receivers must return Number::toString(x) BEFORE the
          // range check fires. Removing the codegen pre-check lets
          // `(NaN).toExponential(101)` return "NaN" as the spec
          // requires.
        } else if (methodName === "toExponential") {
          // No argument → pass NaN sentinel
          fctx.body.push({ op: "f64.const", value: NaN });
        }
        const funcName =
          methodName === "toFixed"
            ? "number_toFixed"
            : methodName === "toPrecision"
              ? "number_toPrecision"
              : methodName === "toExponential"
                ? "number_toExponential"
                : radixLocal !== undefined
                  ? "number_toString_radix"
                  : "number_toString";
        const funcIdx = ctx.funcMap.get(funcName);
        if (funcIdx !== undefined) {
          // (#2029 family C) The 2-arg radix helper takes (x, radix) — mirror
          // the dot-access site: receiver is already on the stack, append the
          // validated radix.
          if (funcName === "number_toString_radix" && radixLocal !== undefined) {
            fctx.body.push({ op: "local.get", index: radixLocal });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }

      // Try array method calls
      {
        const arrMethodResult = compileArrayMethodCall(ctx, fctx, elemAccess, expr, receiverType, methodName);
        if (arrMethodResult !== undefined) return arrMethodResult;
      }

      // ELEM ACCESS RESOLVED, NO METHOD MATCHED — try callable element type
      // (#1306). Covers `fns[0](args)` and `fns[ConstKey](args)` where
      // `fns` is an array (or other element-access-able value) of callables.
      {
        const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
        if (cea !== undefined) return cea;
      }

      // (#3166 S1) Computed-key call on a class-instance FIELD holding a
      // closure: `c[1+1]()` where `[1+1] = () => …` is a class field. TS does
      // NOT track a member named "2" for a computed-name field, so the callee
      // (`c[1+1]`) carries no call signature — `compileCallableElementAccessCall`
      // above bailed — and it is NOT a prototype method (no `ClassName_2` in
      // funcMap). The struct-field READ works (numeric/string keys already
      // canonicalise to field "2"); only the INVOCATION was dropped. Route the
      // read + dynamic closure dispatch through the same ref.test-guarded
      // `call_ref` machinery an `any`-typed identifier call uses. The runtime
      // ref.test guards make this safe for a non-closure field value (the
      // default arm reproduces the historical `ref.null.extern`).
      if (elemAccessReceiverIsUserClass(ctx, elemAccess) && classInstanceHasField(ctx, elemAccess, methodName)) {
        const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
        if (dyn !== null) return dyn;
      }

      // Fallback for resolved element access calls that didn't match any known method:
      // compile receiver, discard; compile each argument for side effects; return externref.
      {
        const recvType = compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType) {
          fctx.body.push({ op: "drop" });
        }
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType) {
            fctx.body.push({ op: "drop" });
          }
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // ELEM ACCESS UNRESOLVED — try callable element type (#1306) before
    // falling through to the drop-everything path. Covers
    // `mws[idx](c, next)` where `idx` is a runtime variable.
    {
      const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
      if (cea !== undefined) return cea;
    }

    // (#3166 S1) Runtime-key call on a class-instance field holding a closure:
    // `c[String(1+1)]()` — the key is not const-foldable so no static field
    // name is known, but the dynamic element READ already canonicalises the key
    // (ToPropertyKey) and finds struct field "2". Only the INVOCATION was
    // dropped. Route the read + ref.test-guarded dynamic closure dispatch, gated
    // on a user-class-instance receiver so primitive/array receivers keep their
    // historical behaviour. A non-closure read value hits the safe default arm.
    if (elemAccessReceiverIsUserClass(ctx, elemAccess)) {
      const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
      if (dyn !== null) return dyn;
    }

    // Fallback for element access calls where the key couldn't be resolved statically:
    // compile receiver + index expression + arguments for side effects; return externref.
    {
      const recvType = compileExpression(ctx, fctx, elemAccess.expression);
      if (recvType) {
        fctx.body.push({ op: "drop" });
      }
      if (argExpr) {
        const keyType = compileExpression(ctx, fctx, argExpr);
        if (keyType) {
          fctx.body.push({ op: "drop" });
        }
      }
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle fn.bind(thisArg, ...partialArgs)(...remainingArgs) — immediate bind+call
  // Transform to fn(...partialArgs, ...remainingArgs), dropping thisArg.
  // (#1337) Also accept the equivalent Function.prototype.bind.call(fn, thisArg, ...) form
  // by reshaping bindCall to the method form before pattern-matching.
  if (ts.isCallExpression(expr.expression)) {
    let bindCall = expr.expression;
    if (
      ts.isPropertyAccessExpression(bindCall.expression) &&
      bindCall.expression.name.text === "call" &&
      ts.isPropertyAccessExpression(bindCall.expression.expression) &&
      bindCall.expression.expression.name.text === "bind" &&
      ts.isPropertyAccessExpression(bindCall.expression.expression.expression) &&
      bindCall.expression.expression.expression.name.text === "prototype" &&
      ts.isIdentifier(bindCall.expression.expression.expression.expression) &&
      bindCall.expression.expression.expression.expression.text === "Function" &&
      bindCall.arguments.length >= 1
    ) {
      const fnExpr = bindCall.arguments[0]!;
      const reshapedArgs = bindCall.arguments.slice(1);
      const reshapedProp = ts.factory.createPropertyAccessExpression(fnExpr as ts.LeftHandSideExpression, "bind");
      ts.setTextRange(reshapedProp, bindCall.expression);
      const reshapedInner = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
      ts.setTextRange(reshapedInner, bindCall);
      (reshapedInner as any).parent = expr;
      bindCall = reshapedInner;
    }
    if (ts.isPropertyAccessExpression(bindCall.expression) && bindCall.expression.name.text === "bind") {
      const bindTarget = bindCall.expression.expression;

      // Case: identifier.bind(thisArg, ...partialArgs)(...args)
      if (ts.isIdentifier(bindTarget)) {
        const funcName = bindTarget.text;
        const closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first bind argument) for side effects
          if (bindCall.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, bindCall.arguments[0]!);
            if (thisType) {
              fctx.body.push({ op: "drop" });
            }
          }

          // Collect all effective arguments: partial args from bind + remaining args from outer call
          const partialArgs = bindCall.arguments.length > 1 ? Array.from(bindCall.arguments).slice(1) : [];
          const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

          if (closureInfo) {
            const syntheticCall = ts.factory.createCallExpression(
              bindTarget,
              undefined,
              allArgs as unknown as readonly ts.Expression[],
            );
            (syntheticCall as any).parent = expr.parent;
            return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
          }

          // Regular function call
          const paramTypes = getFuncParamTypes(ctx, funcIdx!);
          for (let i = 0; i < allArgs.length; i++) {
            compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i]);
          }

          // Supply defaults for missing optional params
          const optInfo = ctx.funcOptionalParams.get(funcName);
          if (optInfo) {
            for (const opt of optInfo) {
              if (opt.index >= allArgs.length) {
                pushParamSentinel(fctx, opt.type, ctx, opt);
              }
            }
          }

          // Pad remaining missing params
          if (paramTypes) {
            const optFilledCount = optInfo ? optInfo.filter((o) => o.index >= allArgs.length).length : 0;
            const totalPushed = allArgs.length + optFilledCount;
            for (let i = totalPushed; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }

          const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
          maybeSetArgcForKnownCall(
            ctx,
            fctx,
            funcName,
            allArgs.length,
            getFuncParamTypes(ctx, finalFuncIdx)?.length ?? allArgs.length,
          );
          fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
        }
      }

      // Case: obj.method.bind(thisArg)(...args) — method call with different receiver
      if (ts.isPropertyAccessExpression(bindTarget)) {
        const methodName = bindTarget.name.text;
        const objExpr = bindTarget.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && bindCall.arguments.length > 0) {
            // First bind argument is the thisArg (receiver)
            compileExpression(ctx, fctx, bindCall.arguments[0]!);

            // Remaining bind args + outer call args
            const partialArgs = bindCall.arguments.length > 1 ? Array.from(bindCall.arguments).slice(1) : [];
            const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            // User-visible param count excludes self (param 0)
            const bindParamCount = paramTypes ? paramTypes.length - 1 : allArgs.length;
            for (let i = 0; i < allArgs.length; i++) {
              if (i < bindParamCount) {
                compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i + 1]);
              } else {
                // Extra argument beyond method's parameter count — evaluate for
                // side effects (JS semantics) and discard the result
                const extraType = compileExpression(ctx, fctx, allArgs[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            // Pad missing arguments with defaults (skip self at index 0)
            if (paramTypes) {
              for (let i = allArgs.length + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }

            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
              return brandExternMethodResult(
                ctx,
                retType,
                getWasmFuncReturnType(ctx, finalCallIdx) ?? resolveWasmType(ctx, retType),
              );
            }
            return VOID_RESULT;
          }
        }
      }
    }
  }

  // Handle CallExpression as callee: fn()(), makeAdder(10)(32), etc.
  // The inner call returns a closure struct (possibly coerced to externref),
  // and we need to call the returned closure with the outer arguments.
  if (ts.isCallExpression(expr.expression)) {
    // Get the TS type of the inner call result — should be a callable type
    const innerResultTsType = ctx.checker.getTypeAtLocation(expr.expression);
    let callSigs = innerResultTsType.getCallSignatures?.();
    if (!callSigs || callSigs.length === 0) {
      // (#1298) Strip nullable members for callees like `Map<K, Fn>.get(...)`
      // whose return type is `Fn | undefined`. Storage is externref either way.
      const nonNull = ctx.checker.getNonNullableType(innerResultTsType);
      callSigs = nonNull.getCallSignatures?.();
    }

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // Find matching closure info by comparing param types and return type
      // against all registered closure types
      let matchedClosureInfo: ClosureInfo | undefined;
      let matchedStructTypeIdx: number | undefined;

      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        // Check return type match
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
        // Check param types match
        let paramsMatch = true;
        for (let i = 0; i < sigParamCount; i++) {
          if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
            paramsMatch = false;
            break;
          }
        }
        if (paramsMatch) {
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }

      if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
        // Compile the inner call expression to get the closure on the stack
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        // Save closure ref to a local so we can extract both args and funcref
        let closureLocal: number;
        if (innerResultType?.kind === "externref") {
          // Need to convert externref back to the closure struct ref (guarded)
          const closureRefType: ValType = {
            kind: "ref_null",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(fctx, `__call_ret_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, matchedStructTypeIdx);
          fctx.body.push({ op: "local.set", index: closureLocal });
        } else {
          const closureRefType: ValType = innerResultType ?? {
            kind: "ref",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(fctx, `__call_ret_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "local.set", index: closureLocal });
        }

        // Push closure ref as first arg (self param) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

        // Push call arguments (only up to declared param count)
        const crParamCnt = matchedClosureInfo.paramTypes.length;
        // biome-ignore lint/complexity/noUselessLoneBlockStatements: groups arg-emit + extras-pack as one logical unit
        {
          for (let i = 0; i < Math.min(expr.arguments.length, crParamCnt); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
          }
        }

        // Pad missing arguments with defaults
        for (let i = expr.arguments.length; i < crParamCnt; i++) {
          pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
        }

        // (#1511) For indirect calls we cannot know whether the lifted target
        // reads `arguments`; pack any overflow args into `__extras_argv` and
        // set `__argc` so a callee that DOES read `arguments` sees the full
        // call-site length. Overflow args are NOT pushed to the wasm stack —
        // they live in the global. Cleanup happens after call_ref.
        emitClosureCallArgcExtras(ctx, fctx, expr.arguments, crParamCnt);

        // Push the funcref from the closure struct (field 0) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: matchedStructTypeIdx,
          fieldIdx: 0,
        });
        // Guard funcref cast to avoid illegal cast (#778)
        emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });

        // call_ref with the lifted function's type index
        fctx.body.push({
          op: "call_ref",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });

        // (#1511) Reset __argc / __extras_argv. A callee that doesn't read
        // `arguments` never consumed them and would otherwise leak stale
        // values into the next call.
        if (matchedClosureInfo.returnType === null) {
          emitResetArgcExtras(ctx, fctx);
        } else {
          const _retLocal = allocLocal(fctx, `__cr_ret_${fctx.locals.length}`, matchedClosureInfo.returnType);
          fctx.body.push({ op: "local.set", index: _retLocal });
          emitResetArgcExtras(ctx, fctx);
          fctx.body.push({ op: "local.get", index: _retLocal });
        }

        // Return VOID_RESULT for void closures so compileExpression doesn't
        // treat the null return as a compilation failure and roll back instructions
        return matchedClosureInfo.returnType ?? VOID_RESULT;
      }
    }
  }

  // Handle ConditionalExpression as callee (not wrapped in parens):
  // (cond ? fn1 : fn2)(args) — handled directly
  if (ts.isConditionalExpression(expr.expression)) {
    return compileConditionalCallee(ctx, fctx, expr, expr.expression);
  }

  // (#1298 fix #3) Generic fallback: ref.test-guarded closure dispatch.
  //
  // For callees whose TS type carries a call signature, eagerly resolve the
  // wrapper struct/funcref pair via getOrCreateFuncRefWrapperTypes so the
  // dispatch is order-independent. Then gate the actual cast + call_ref on a
  // RUNTIME `ref.test (ref $__fn_wrap_N)`:
  //   - then branch (ref.test == 1): the value really is a wasm closure of
  //     this signature shape — cast + dispatch.
  //   - else branch (ref.test == 0): host function ref, foreign externref,
  //     null, or wasm closure of a different shape — fall back to the
  //     graceful `ref.null.extern` semantics that the pre-rewrite scan-only
  //     fallback used at this site.
  //
  // This avoids the v1 (PR #223) regression cluster (340 null_derefs in
  // Temporal/* etc.): the v1 path committed unconditionally to the wasm
  // closure dispatch and the first `emitNullCheckThrow` after a failed cast
  // turned the graceful-null exit into a TypeError.
  //
  // Args are evaluated into locals BEFORE the ref.test so the else branch
  // doesn't have to re-evaluate them (preserves side-effect ordering).
  //
  // See plan/issues/sprints/50/1298-fn-typed-fields-call-drops.md
  // (`## Fix #3 — Safe reimplementation`) for the full design.
  {
    const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
    let callSigs = calleeTsType.getCallSignatures?.();
    if (!callSigs || callSigs.length === 0) {
      // (#1298) Strip nullable members for `Fn | null | undefined` callees.
      const nonNull = ctx.checker.getNonNullableType(calleeTsType);
      callSigs = nonNull.getCallSignatures?.();
    }

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      // (#1298 PR #231 fix) Look up an existing wrapper struct/funcref pair
      // for this signature WITHOUT registering a new one. The earlier draft
      // of fix #3 called `getOrCreateFuncRefWrapperTypes` here to get
      // order-independent dispatch, but registering a fresh wrapper struct
      // at this fallback site polluted `closureInfoByTypeIdx` with a struct
      // that wasn't actually used by any compiled closure. Downstream
      // funcref-candidate scans (e.g. the identifier-callable-param path's
      // multi-funcref dispatch at calls.ts:5106) then picked the unused
      // wrapper as a candidate, mismatching the closure that was actually
      // stored — `language/statements/function/S13_A18.js` reproduced this
      // as a null-deref inside a lifted closure body. Conservative fix:
      // only enter the dispatch path when a closure of this signature has
      // already been registered (the original scan-only behavior), and
      // gate THAT dispatch with ref.test. If no match, fall through to the
      // graceful tail at the end of compileCallExpression.
      let matchedClosureInfo: ClosureInfo | undefined;
      let matchedStructTypeIdx: number | undefined;
      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
        let paramsMatch = true;
        for (let i = 0; i < sigParamCount; i++) {
          if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
            paramsMatch = false;
            break;
          }
        }
        if (paramsMatch) {
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }
      const wrapperTypes =
        matchedClosureInfo && matchedStructTypeIdx !== undefined
          ? {
              closureInfo: matchedClosureInfo,
              structTypeIdx: matchedStructTypeIdx,
              liftedFuncTypeIdx: matchedClosureInfo.funcTypeIdx,
            }
          : null;

      if (wrapperTypes) {
        const closureInfo = wrapperTypes.closureInfo;
        const structTypeIdx = wrapperTypes.structTypeIdx;
        const funcTypeIdx = closureInfo.funcTypeIdx;

        // 1. Compile the callee once. It must be a ref-shaped value (we can't
        //    `ref.test` an i32 / f64). For non-ref callees, drop value + args
        //    and emit graceful null directly.
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        const isRefShaped =
          innerResultType !== null &&
          (innerResultType.kind === "externref" ||
            innerResultType.kind === "ref" ||
            innerResultType.kind === "ref_null");

        if (!isRefShaped) {
          if (innerResultType !== null) {
            fctx.body.push({ op: "drop" });
          }
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType !== null) fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }

        // 2. Save callee value to a local. Stash type matches the compiled
        //    callee shape so re-loading roundtrips losslessly.
        const calleeStashType: ValType = innerResultType.kind === "externref" ? { kind: "externref" } : innerResultType;
        const calleeLocal = allocLocal(fctx, `__cb_callee_${fctx.locals.length}`, calleeStashType);
        fctx.body.push({ op: "local.set", index: calleeLocal });

        // 3. Compile call args into locals so both branches can re-push them
        //    without re-evaluating side effects.
        const argLocals: Array<{ local: number; type: ValType }> = [];
        const ccParamCnt = closureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, ccParamCnt); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
          const argLocal = allocLocal(fctx, `__cb_carg_${fctx.locals.length}`, closureInfo.paramTypes[i]!);
          fctx.body.push({ op: "local.set", index: argLocal });
          argLocals.push({ local: argLocal, type: closureInfo.paramTypes[i]! });
        }
        // (#1511) Excess args: compile and save to externref locals so we can
        // pack them into __extras_argv inside the then branch without
        // re-running side effects.
        const extrasLocals: number[] = [];
        for (let i = ccParamCnt; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
          if (extraType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (extraType.kind === "f64") {
            const boxIdx = ctx.funcMap.get("__box_number");
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (extraType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const boxIdx = ctx.funcMap.get("__box_number");
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (extraType.kind === "ref" || extraType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          const extraLocal = allocLocal(fctx, `__cb_cextra_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: extraLocal });
          extrasLocals.push(extraLocal);
        }
        // Pad missing args. For non-nullable ref params widen to nullable so
        // `pushDefaultValue` emits a plain `ref.null` (no `ref.as_non_null`
        // trap). The lifted func sig accepts nullable refs, so the call_ref
        // type matches.
        for (let i = expr.arguments.length; i < ccParamCnt; i++) {
          const paramType = closureInfo.paramTypes[i]!;
          const padType: ValType =
            paramType.kind === "ref" ? { kind: "ref_null", typeIdx: paramType.typeIdx } : paramType;
          pushDefaultValue(fctx, padType, ctx);
          const argLocal = allocLocal(fctx, `__cb_cpad_${fctx.locals.length}`, padType);
          fctx.body.push({ op: "local.set", index: argLocal });
          argLocals.push({ local: argLocal, type: padType });
        }

        // 4. Emit the ref.test guard. Stack before the if: [i32].
        fctx.body.push({ op: "local.get", index: calleeLocal });
        if (innerResultType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

        // 5. then branch — ref.test passed, do the dispatch.
        // (#1395 fix) Use pushBody/popBody so the saved body is tracked in
        // fctx.savedBodies. Without this, late-import index shifts via
        // `fixupModuleGlobalIndices` walking only `ctx.currentFunc.body` +
        // `savedBodies` would miss `global.get`/`global.set` instructions
        // that were emitted into the OUTER body before the swap. In
        // particular, `compileExpression(C.f)` at line 7436 above pushes
        // `global.get <staticPropIdx>` for a class static-field receiver
        // into the outer body; if a string-constant import then gets
        // added during dispatch compilation below (step 4b/5), the
        // shifter's threshold/delta would correctly bump the static-prop
        // map but skip the orphaned outer body, producing a stale index
        // that points at a sibling global (e.g. `__class_C` instead of
        // `__static_C_f`). Tests:
        // language/statements/class/elements/static-field-init-this-
        // inside-arrow-function.js (#1395 followup).
        const savedBody = pushBody(fctx);
        const thenInstrs = fctx.body;

        // Re-load callee + plain ref.cast (test already proved it succeeds).
        fctx.body.push({ op: "local.get", index: calleeLocal });
        if (innerResultType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
        const closureLocal = allocLocal(fctx, `__cb_closure_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: structTypeIdx,
        });
        fctx.body.push({ op: "local.set", index: closureLocal });

        // Push self (closure ref) + saved args.
        fctx.body.push({ op: "local.get", index: closureLocal });
        for (const al of argLocals) {
          fctx.body.push({ op: "local.get", index: al.local });
        }

        // (#1511) Set __extras_argv (from saved extras locals) and __argc so
        // the lifted callee can compute the correct arguments.length when it
        // reads `arguments`. Stack contributions are immediately consumed.
        if (extrasLocals.length > 0) {
          const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTi } = ensureExtrasArgvGlobal(ctx);
          const extrasArrTi = getArrTypeIdxFromVec(ctx, extrasVecTi);
          for (const el of extrasLocals) {
            fctx.body.push({ op: "local.get", index: el });
          }
          fctx.body.push({ op: "array.new_fixed", typeIdx: extrasArrTi, length: extrasLocals.length });
          const arrTmp = allocLocal(fctx, `__cb_extras_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: extrasArrTi,
          });
          fctx.body.push({ op: "local.set", index: arrTmp });
          fctx.body.push({ op: "i32.const", value: extrasLocals.length });
          fctx.body.push({ op: "local.get", index: arrTmp });
          fctx.body.push({ op: "struct.new", typeIdx: extrasVecTi });
          fctx.body.push({ op: "global.set", index: extrasGlobalIdx });
        }
        emitSetArgc(ctx, fctx, expr.arguments.length, ccParamCnt);

        // Push funcref from closure struct, guarded cast + null-check, call_ref.
        fctx.body.push({ op: "local.get", index: closureLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 });
        emitGuardedFuncRefCast(fctx, funcTypeIdx);
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: funcTypeIdx });
        fctx.body.push({ op: "call_ref", typeIdx: funcTypeIdx });

        // Coerce return value to externref so the if-block has a single
        // result type. For void closures, push ref.null.extern.
        if (closureInfo.returnType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (closureInfo.returnType.kind !== "externref") {
          coerceType(ctx, fctx, closureInfo.returnType, { kind: "externref" });
        }
        // (#1511) Reset argc/extras after the call. Return value (externref) is
        // on the stack at this point — save, reset, restore.
        {
          const _retL = allocLocal(fctx, `__cb_ret_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: _retL });
          emitResetArgcExtras(ctx, fctx);
          fctx.body.push({ op: "local.get", index: _retL });
        }

        // 6. else branch — graceful null.
        const elseInstrs: Instr[] = [{ op: "ref.null.extern" }];

        // 7. Restore body, emit the if/else.
        popBody(fctx, savedBody);
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: thenInstrs,
          else: elseInstrs,
        });

        return { kind: "externref" };
      }
    }
  }

  // Graceful fallback: compile the callee expression and all arguments for side effects,
  // then push ref.null.extern. This avoids hard compile errors for unrecognized call patterns
  // (e.g. chained calls, dynamic dispatch, uncommon AST shapes).
  {
    const calleeType = compileExpression(ctx, fctx, expr.expression);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * (#3123) Generic dynamic method dispatch for a method MISS on a
 * fnctor-subclass receiver (`class C extends F`, F a top-level plain
 * function). The member may live on F's runtime-assigned `.prototype`
 * (host-side), so compile the receiver as externref (extern.convert_any for
 * the struct instance), marshal the args into a host JS array (native $ObjVec
 * under standalone), and call `__extern_method_call(recv, "<name>", args)` —
 * mirroring the any-receiver generic ladder (#799 WI3) so both entry points
 * behave identically. Helper indices are re-read from funcMap at each use so
 * late-import shifts during arg compilation cannot bake stale call targets.
 */
function emitFnctorSubclassDynamicMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): InnerResult | undefined {
  let arrNewIdx: number | undefined;
  let arrPushIdx: number | undefined;
  const arrNewName = ctx.standalone ? "__objvec_new" : "__js_array_new";
  const arrPushName = ctx.standalone ? "__objvec_push" : "__js_array_push";
  if (ctx.standalone) {
    const b = ensureObjVecBuilders(ctx);
    arrNewIdx = b.newIdx;
    arrPushIdx = b.pushIdx;
  } else {
    arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  }
  const methodCallIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  // The fallback's method-name string constant, materialized BEFORE any body
  // instructions so the global index is settled.
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  if (methodCallIdx === undefined || arrNewIdx === undefined || arrPushIdx === undefined) return undefined;

  const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  const recvLocal = allocLocal(fctx, `__fsd_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(arrNewName) ?? arrNewIdx });
  const argsLocal = allocLocal(fctx, `__fsd_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType && argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(arrPushName) ?? arrPushIdx });
  }
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_method_call") ?? methodCallIdx });
  return { kind: "externref" };
}

/**
 * Compile a call with a ConditionalExpression callee: (cond ? fn1 : fn2)(args)
 *
 * We compile the condition, then emit an if/else where each branch makes
 * the call with the respective callee.
 *
 * Cannot create synthetic CallExpression via ts.factory because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler above.
 */
function compileConditionalCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  condExpr: ts.ConditionalExpression,
): InnerResult {
  // Compile condition
  const condType = compileExpression(ctx, fctx, condExpr.condition);
  if (!condType) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  // Determine the expected return type of the call from the original expression
  const callSig = ctx.checker.getResolvedSignature(expr);
  let callRetType: ValType | null = null;
  if (callSig) {
    const retTsType = ctx.checker.getReturnTypeOfSignature(callSig);
    if (!isVoidType(retTsType)) {
      callRetType = resolveWasmType(ctx, retTsType);
    }
  }

  // Helper: compile a call branch by constructing the call inline
  // Uses the branch expression (whenTrue or whenFalse) as the callee.
  function compileBranchCall(branchExpr: ts.Expression): InnerResult {
    // If the branch is an identifier referencing a known function, call it directly
    if (ts.isIdentifier(branchExpr)) {
      const funcName = branchExpr.text;
      let closureInfo = ctx.closureMap.get(funcName);
      if (!closureInfo) {
        closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
      }
      if (closureInfo) {
        // Use the original expr's arguments but with this identifier as callee
        // Create a minimal synthetic object that mimics a CallExpression
        // for compileClosureCall
        const syntheticCall = Object.create(expr);
        syntheticCall.expression = branchExpr;
        return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
      }
      const funcIdx = ctx.funcMap.get(funcName);
      if (funcIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const ccParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
        for (let i = 0; i < expr.arguments.length; i++) {
          if (i < ccParamCount) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          } else {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing arguments with defaults
        if (paramTypes) {
          for (let i = expr.arguments.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
        maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, ccParamCount);
        fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
        if (callRetType) return callRetType;
        // Try to determine return type from the branch function's signature
        const branchType = ctx.checker.getTypeAtLocation(branchExpr);
        const branchSigs = branchType.getCallSignatures?.();
        if (branchSigs && branchSigs.length > 0) {
          const retType = ctx.checker.getReturnTypeOfSignature(branchSigs[0]!);
          if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
          return brandExternMethodResult(
            ctx,
            retType,
            getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType),
          );
        }
        return callRetType ?? getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
      }
    }

    // If the branch is itself a conditional, recurse
    if (ts.isConditionalExpression(branchExpr)) {
      return compileConditionalCallee(ctx, fctx, expr, branchExpr);
    }

    // If the branch is wrapped in parens, unwrap
    if (ts.isParenthesizedExpression(branchExpr)) {
      let inner: ts.Expression = branchExpr;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      return compileBranchCall(inner);
    }

    // If the branch is a property access, try method call
    if (ts.isPropertyAccessExpression(branchExpr)) {
      // Create a synthetic call with the property access as callee
      // PropertyAccessExpression IS a LeftHandSideExpression so no infinite recursion
      const syntheticCall = ts.factory.createCallExpression(branchExpr, expr.typeArguments, expr.arguments);
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }

    // Fallback: compile expression value and try to use as closure call
    const calleeType = compileExpression(ctx, fctx, branchExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    if (callRetType) {
      pushDefaultValue(fctx, callRetType, ctx);
      return callRetType;
    }
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }

  // Compile then-branch call
  const savedBody = fctx.body;
  fctx.body = [];
  const thenType = compileBranchCall(condExpr.whenTrue);
  let thenInstrs = fctx.body;

  // Compile else-branch call
  fctx.body = [];
  const elseType = compileBranchCall(condExpr.whenFalse);
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  // Determine result type
  if (thenType === VOID_RESULT && elseType === VOID_RESULT) {
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: elseInstrs,
    });
    return VOID_RESULT;
  }

  // Coerce branches to a common type
  const thenVal: ValType = thenType && thenType !== VOID_RESULT ? thenType : (callRetType ?? { kind: "f64" });
  const elseVal: ValType = elseType && elseType !== VOID_RESULT ? elseType : (callRetType ?? { kind: "f64" });
  let resultType: ValType = callRetType ?? thenVal;

  // If types don't match, coerce both to the result type
  if (thenVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, thenVal, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }
  if (elseVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, elseVal, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  // Handle void branches that need to produce a value
  if (thenType === VOID_RESULT || thenType === null) {
    thenInstrs = [...thenInstrs, ...defaultValueInstrs(resultType)];
  }
  if (elseType === VOID_RESULT || elseType === null) {
    elseInstrs = [...elseInstrs, ...defaultValueInstrs(resultType)];
  }

  // Widen ref to ref_null when a branch uses defaultValueInstrs (which produces ref.null)
  if (
    resultType.kind === "ref" &&
    (thenType === VOID_RESULT || thenType === null || elseType === VOID_RESULT || elseType === null)
  ) {
    resultType = { kind: "ref_null", typeIdx: (resultType as any).typeIdx };
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  return resultType;
}

/**
 * Compile a call where the callee is an arbitrary expression that is not a
 * LeftHandSideExpression (e.g. assignment: `(x = fn)()`, logical: `(a || fn)()`).
 *
 * We cannot use ts.factory.createCallExpression for these because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler.
 *
 * Strategy: compile the callee expression to get its value on the stack,
 * then try to use the result as a closure call (closure-matching by type),
 * or as a direct function call if the expression resolves to a known function.
 */
function compileExpressionCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  calleeExpr: ts.Expression,
): InnerResult {
  // For assignment expressions, we can look at the RHS to identify the function
  // being called, while still compiling the full assignment for side effects.
  if (
    ts.isBinaryExpression(calleeExpr) &&
    calleeExpr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    calleeExpr.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    calleeExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // For simple assignment (x = fn)(), compile the assignment for side effects
    // then call the RHS function directly if it's identifiable.
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs)) {
      const funcIdx = ctx.funcMap.get(rhs.text);
      const closureInfo = ctx.closureMap.get(rhs.text);
      if (funcIdx !== undefined || closureInfo) {
        // Compile the full assignment for side effects (stores value in LHS)
        const assignResult = compileExpression(ctx, fctx, calleeExpr);
        if (assignResult) {
          fctx.body.push({ op: "drop" });
        }
        // Now make a direct call using the RHS identifier as callee
        const syntheticCall = ts.factory.createCallExpression(rhs, expr.typeArguments, expr.arguments);
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }
    }
  }

  // Generic path: compile the callee expression and try closure-matching
  const calleeTsType = ctx.checker.getTypeAtLocation(calleeExpr);
  const callSigs = calleeTsType.getCallSignatures?.();

  if (callSigs && callSigs.length > 0) {
    const sig = callSigs[0]!;

    // Look for a matching closure type
    const sigParamCount = sig.parameters.length;
    const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
    const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
    const sigParamWasmTypes: ValType[] = [];
    for (let i = 0; i < sigParamCount; i++) {
      const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
      sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
    }

    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      if (info.paramTypes.length !== sigParamCount) continue;
      if (sigRetWasm === null && info.returnType !== null) continue;
      if (sigRetWasm !== null && info.returnType === null) continue;
      if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
      let paramsMatch = true;
      for (let i = 0; i < sigParamCount; i++) {
        if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
          paramsMatch = false;
          break;
        }
      }
      if (paramsMatch) {
        matchedClosureInfo = info;
        matchedStructTypeIdx = typeIdx;
        break;
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile the callee expression to get the closure on the stack
      const innerResultType = compileExpression(ctx, fctx, calleeExpr);

      // Save closure ref to a local
      let closureLocal: number;
      if (innerResultType?.kind === "externref") {
        const closureRefType: ValType = {
          kind: "ref_null",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(fctx, `__expr_call_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, matchedStructTypeIdx);
        fctx.body.push({ op: "local.set", index: closureLocal });
      } else {
        const closureRefType: ValType = innerResultType ?? {
          kind: "ref",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(fctx, `__expr_call_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "local.set", index: closureLocal });
      }

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

      // Push call arguments (only up to declared param count)
      const ecParamCnt = matchedClosureInfo.paramTypes.length;
      // biome-ignore lint/complexity/noUselessLoneBlockStatements: groups arg-emit + extras-pack as one logical unit
      {
        for (let i = 0; i < Math.min(expr.arguments.length, ecParamCnt); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
      }

      // Pad missing arguments
      for (let i = expr.arguments.length; i < ecParamCnt; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
      }

      // (#1511) Indirect call — propagate overflow args via __extras_argv so
      // a callee reading `arguments` gets the correct length.
      emitClosureCallArgcExtras(ctx, fctx, expr.arguments, ecParamCnt);

      // Push the funcref from closure struct and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
      fctx.body.push({
        op: "struct.get",
        typeIdx: matchedStructTypeIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      // (#1511) Cleanup
      if (matchedClosureInfo.returnType === null) {
        emitResetArgcExtras(ctx, fctx);
      } else {
        const _retLocal = allocLocal(fctx, `__ec_ret_${fctx.locals.length}`, matchedClosureInfo.returnType);
        fctx.body.push({ op: "local.set", index: _retLocal });
        emitResetArgcExtras(ctx, fctx);
        fctx.body.push({ op: "local.get", index: _retLocal });
      }

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  // Last resort: compile the callee for side effects and try to resolve
  // the call via the RHS of an assignment or the last operand
  if (ts.isBinaryExpression(calleeExpr)) {
    const assignResult = compileExpression(ctx, fctx, calleeExpr);
    if (assignResult) {
      fctx.body.push({ op: "drop" });
    }
    // Try calling the RHS (for assignment) or right operand (for logical)
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs) || ts.isPropertyAccessExpression(rhs)) {
      const syntheticCall = ts.factory.createCallExpression(
        rhs as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Graceful fallback for non-LHSE callee: compile callee and args for side effects,
  // return externref null. Avoids hard compile errors for uncommon callee shapes.
  {
    const calleeType = compileExpression(ctx, fctx, calleeExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile an IIFE (Immediately Invoked Function Expression):
 *   (function(params) { body })(args)
 *
 * Strategy: compile the function expression as a named module-level function
 * with a unique synthetic name, then emit a direct call to it.
 * Captures from the enclosing scope are passed as extra leading parameters.
 *
 * Returns undefined if the expression is not an IIFE pattern.
 */
function compileIIFE(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult | undefined {
  // Unwrap parenthesized expression to find the function expression
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (!ts.isFunctionExpression(callee) && !ts.isArrowFunction(callee)) {
    return undefined; // not an IIFE
  }
  // Generator function expressions (function*) cannot be inlined as IIFEs
  // because their body uses `yield` which requires a generator FunctionContext (#657).
  if (ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined) {
    return undefined;
  }
  const funcExpr = callee as ts.FunctionExpression | ts.ArrowFunction;

  // Determine parameter types from the function's declared parameters
  const paramTypes: ValType[] = [];
  for (const p of funcExpr.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    paramTypes.push(resolveWasmType(ctx, paramType));
  }

  // Determine return type
  const sig = ctx.checker.getSignatureFromDeclaration(funcExpr);
  let returnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      returnType = resolveWasmType(ctx, retType);
    }
  }

  // Analyze captured variables from the enclosing scope
  const body = funcExpr.body;
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  // Detect which captured variables are written inside the IIFE body
  const writtenInIIFE = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInIIFE);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInIIFE);
  }

  const ownParamNames = new Set(
    funcExpr.parameters.filter((p) => ts.isIdentifier(p.name)).map((p) => (p.name as ts.Identifier).text),
  );

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
  }[] = [];
  for (const name of referencedNames) {
    if (ownParamNames.has(name)) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInIIFE.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // Generate a unique name for the IIFE
  const iifeName = `__iife_${ctx.closureCounter++}`;
  const results: ValType[] = returnType ? [returnType] : [];

  // Build parameter types: for mutable captures use ref cells, others pass by value
  // Use ref_null for ref types to allow null default initialization (var hoisting)
  const captureParamTypes = captures.map((c) => {
    if (c.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
      return { kind: "ref_null" as const, typeIdx: refCellTypeIdx };
    }
    // Widen ref to ref_null so hoisted vars initialized to null can be passed
    if (c.type.kind === "ref") {
      return {
        kind: "ref_null" as const,
        typeIdx: (c.type as { typeIdx: number }).typeIdx,
      };
    }
    return c.type;
  });
  const allParamTypes = [...captureParamTypes, ...paramTypes];
  const funcTypeIdx = addFuncType(ctx, allParamTypes, results, `${iifeName}_type`);

  const liftedFctx: FunctionContext = {
    name: iifeName,
    params: [
      ...captures.map((c, i) => ({
        name: c.name,
        type: captureParamTypes[i]!,
      })),
      ...funcExpr.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: paramTypes[i] ?? ({ kind: "f64" } as ValType),
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // For mutable captures, register them as boxed so read/write uses struct.get/set.
  // Also register non-mutable captures that are already boxed in the outer scope.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType: cap.type,
      });
    } else {
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, {
          refCellTypeIdx: outerBoxed.refCellTypeIdx,
          valType: outerBoxed.valType,
        });
      }
    }
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;

  if (ts.isBlock(body)) {
    // Hoist var declarations and let/const with TDZ flags (#790)
    hoistVarDeclarations(ctx, liftedFctx, body.statements);
    hoistLetConstWithTdz(ctx, liftedFctx, body.statements);
    hoistFunctionDeclarations(ctx, liftedFctx, body.statements);
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    // Concise arrow body — expression is the return value
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType === null && returnType) {
      // Push default return value
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  // Append default return if needed
  if (returnType) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Register the lifted function
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: iifeName,
    typeIdx: funcTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(iifeName, funcIdx);

  // Emit the call: push captures (with ref cells for mutable ones), then arguments, then call
  for (const cap of captures) {
    if (cap.mutable) {
      // Wrap the current value in a ref cell for mutable capture
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      // Check if the outer local is already boxed
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        // Create a ref cell, store value, keep ref on stack
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        // Re-register the original name to point to the boxed local
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }

  // Compile call arguments, matching to declared params; extras are evaluated and dropped
  // Flatten spread elements on array literals into individual expressions
  const flatIIFEArgs = flattenCallArgs(expr.arguments) ?? (expr.arguments as unknown as ts.Expression[]);
  const paramCount = paramTypes.length;
  for (let i = 0; i < flatIIFEArgs.length; i++) {
    const arg = flatIIFEArgs[i]!;
    // Skip any remaining spread elements that couldn't be flattened
    if (ts.isSpreadElement(arg)) continue;
    if (i < paramCount) {
      compileExpression(ctx, fctx, arg, paramTypes[i]);
    } else {
      // Extra argument — evaluate for side effects, drop result
      const extraType = compileExpression(ctx, fctx, arg);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  // Supply defaults for missing params (use NaN sentinel for f64, #787)
  for (let i = flatIIFEArgs.length; i < paramCount; i++) {
    const pt = paramTypes[i] ?? { kind: "f64" as const };
    if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: NaN });
    else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (pt.kind === "ref" || pt.kind === "ref_null") fctx.body.push({ op: "ref.null", typeIdx: pt.typeIdx });
  }

  // Re-lookup in case addUnionImports shifted indices
  const finalFuncIdx = ctx.funcMap.get(iifeName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

  if (returnType) return returnType;
  return VOID_RESULT;
}

// ── New expressions ──────────────────────────────────────────────────

/** Resolve the enclosing class name from a FunctionContext.
 *  Uses enclosingClassName if set (e.g. closures), otherwise parses ClassName from "ClassName_methodName". */

/**
 * Compile a string expression argument and write it to WASI linear memory via bump allocator.
 * Pushes (ptr: i32, len: i32) onto the stack.
 *
 * For string literals, this is handled at the call site via wasiAllocStringData.
 * This function handles dynamic string values (variables, expressions) by
 * compiling a runtime copy from the WasmGC string to linear memory.
 *
 * Current limitation: only supports string literals assigned to variables at compile time.
 * For truly dynamic strings, we'd need a runtime string-to-memory encoder.
 * For now, emit unreachable for unsupported cases.
 */
export function compileWasiStringArgToLinearMemory(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): void {
  // If it's an identifier referencing a const/let with a string literal initializer,
  // we can resolve it at compile time
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    if (sym?.valueDeclaration && ts.isVariableDeclaration(sym.valueDeclaration)) {
      const init = sym.valueDeclaration.initializer;
      if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
        const data = wasiAllocStringData(ctx, init.text);
        fctx.body.push({ op: "i32.const", value: data.offset });
        fctx.body.push({ op: "i32.const", value: data.length });
        return;
      }
    }
  }

  // Template literal with only a head (no substitutions)
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    const data = wasiAllocStringData(ctx, expr.text);
    fctx.body.push({ op: "i32.const", value: data.offset });
    fctx.body.push({ op: "i32.const", value: data.length });
    return;
  }

  // Fallback: unsupported dynamic string — trap at runtime
  // TODO: implement runtime GC-string to linear-memory copy for dynamic strings
  fctx.body.push({ op: "unreachable" });
}

// ── #2922 arms 2+3 — dynamic Promise.all/race argument ──────────────────────

/**
 * (#2922) Decide whether a probed (and rolled-back) combinator argument may
 * take the dynamic `__combinator_to_vec` path. Everything EXCEPT the shapes
 * that must keep the host fallthrough byte-unchanged:
 *   - `__vec_*` structs that are not externref-backed (`number[]` — the Gap-4
 *     output-representation escalation documented in promise-combinators.ts);
 *     externref-backed vecs were already committed by arm 1.
 *   - strings (checker-typed OR lowering to a native string struct): strings
 *     ARE iterable per spec (§22.1.5) — the drain has no string arm yet, so
 *     routing them would produce a WRONG observable reject. Follow-up.
 *   - native-generator subjects: they iterate via the dedicated compile-time
 *     resume path (`emitNativeGeneratorToVec`), not the runtime dispatchers —
 *     the drain would wrongly reject them. Follow-up.
 *   - funcref/v128/i64-shaped values: conservative fallthrough.
 */
function isDynamicCombinatorArgEligible(ctx: CodegenContext, argType: ValType | null, arg0: ts.Expression): boolean {
  if (argType === null) return false;
  if (isStringType(ctx.checker.getTypeAtLocation(arg0))) return false;
  switch (argType.kind) {
    case "f64":
    case "i32":
    case "externref":
    case "anyref":
    case "eqref":
      return true;
    case "ref":
    case "ref_null": {
      const typeIdx = (argType as { typeIdx?: number }).typeIdx;
      if (typeof typeIdx !== "number" || typeIdx < 0) return false;
      const structName = ctx.typeIdxToStructName.get(typeIdx);
      if (structName !== undefined && structName.startsWith("__vec_")) return false;
      if (typeIdx === ctx.anyStrTypeIdx || typeIdx === ctx.nativeStrTypeIdx || typeIdx === ctx.consStrTypeIdx) {
        return false;
      }
      if (nativeGeneratorInfoForForOfSubject(ctx, argType) !== undefined) return false;
      return true;
    }
    default:
      return false;
  }
}

/**
 * (#2922 arms 2+3) Emit the dynamic combinator argument path:
 *
 *   arg      = <compile arg0 as externref>
 *   drained  = __combinator_to_vec(arg)       ;; $Vec | null (= not iterable)
 *   notIter  = drained == null                ;; (empty vec substituted)
 *   <arm-1 runtime loop over drained, rejecting the result promise with a
 *    native TypeError when notIter — see emitStandalonePromiseCombinatorRuntime>
 *
 * ALL ensure* registrations run BEFORE any instruction is built so no late
 * import can land between an instr's funcIdx bake and its landing in
 * `fctx.body` (where `shiftLateImportIndices` walks it, nested arms included).
 * `ensureNativeIteratorRuntime` is required so `emitIteratorMethodExport`
 * actually emits the `__call_*` dispatchers at finalize (it early-returns
 * unless `__iterator` is registered) — without it `fillCombinatorToVec`
 * could never fill the user-iterable arm.
 */
function emitDynamicCombinatorArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: NativeCombinator,
  arg0: ts.Expression,
): ValType {
  ensureNativeIteratorRuntime(ctx);
  const ids = ensureCombinatorFunctions(ctx);
  ensureCombinatorToVec(ctx);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const msg = `Promise.${methodName} argument is not iterable`;
  addStringConstantGlobal(ctx, msg);

  // arg → externref (committed compile; the natural-type probe was rolled back).
  compileExpression(ctx, fctx, arg0, { kind: "externref" });
  const argLocal = allocLocal(fctx, `__comb_dynarg_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argLocal });

  // drained = __combinator_to_vec(arg)
  const drainedLocal = allocLocal(fctx, `__comb_drained_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: argLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__combinator_to_vec")! });
  fctx.body.push({ op: "local.set", index: drainedLocal });

  // notIter = drained == null; vec = notIter ? <fresh empty $Vec> : cast(drained)
  const notIterLocal = allocLocal(fctx, `__comb_notiter_${fctx.locals.length}`, { kind: "i32" });
  const vecLocal = allocLocal(fctx, `__comb_argvec_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ids.vecTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: drainedLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: notIterLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: ids.arrTypeIdx },
      { op: "struct.new", typeIdx: ids.vecTypeIdx },
      { op: "local.set", index: vecLocal },
    ],
    else: [
      { op: "local.get", index: drainedLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: ids.vecTypeIdx },
      { op: "local.set", index: vecLocal },
    ],
  });

  // Reject-reason instrs (externref TypeError instance). funcMap is read AFTER
  // every ensure above (and after the arg compile), so the baked funcIdx is
  // current; once embedded in fctx.body (inside the emitter's `if` arm) any
  // later shift walks it like every other nested instruction.
  const rejectReason: Instr[] = [
    ...stringConstantExternrefInstrs(ctx, msg),
    { op: "call", funcIdx: ctx.funcMap.get("__new_TypeError")! },
  ];

  return emitStandalonePromiseCombinatorRuntime(ctx, fctx, methodName, vecLocal, ids.vecTypeIdx, ids.arrTypeIdx, {
    notIterLocal,
    rejectReason,
  });
}

export { compileCallExpression, compileIIFE, compileOptionalCallExpression };
