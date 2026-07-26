// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3610) **Static** receiver brand gate for `<Builtin>.prototype.<member>`.
 *
 * ## The defect this closes
 *
 * Nearly every native builtin arm under `src/codegen/` discriminates its
 * receiver by the **TypeScript type name** (`objType.getSymbol()?.name` /
 * `ctx.oracle.builtinReceiverOf`). For a `<Ctor>.prototype` receiver TypeScript
 * reports the *instance* type name — `Uint8ClampedArray.prototype` has type
 * `Uint8ClampedArray`, `Date.prototype` has type `Date` — because lib.d.ts
 * declares `interface DateConstructor { prototype: Date }`. So the arms treat
 * the **prototype object** as an **instance** and emit the instance lowering:
 * an unconditional `ref.cast` to the backing vec/struct (→ uncatchable
 * `illegal cast`) or a bare `struct.get` on a null receiver (→ uncatchable
 * `null reference`).
 *
 * A trap is strictly worse than a wrong answer: it aborts the whole module and
 * escapes `try`/`catch`, so `assert.throws(TypeError, …)` can never observe the
 * TypeError the spec requires.
 *
 * ## Why a STATIC gate is the right general mechanism here
 *
 * Every member in the tables below begins with `RequireInternalSlot(O, [[…]])`
 * (or `ValidateTypedArray` / `thisTimeValue`), and a builtin's `.prototype` is
 * an **ordinary object that provably never carries that slot** (§23.2.7
 * "The %TypedArray% prototype object … is not a TypedArray instance",
 * §21.4.4 "The Date prototype object … is not a Date instance", …). So
 * `<Ctor>.prototype.<member>` is a *compile-time-decidable* unconditional
 * TypeError. We compile the brand check away (project principle: compile away,
 * don't emulate) instead of paying a runtime `ref.test` on every instance call.
 *
 * The complementary DYNAMIC gate — `ref.test` + catchable TypeError for a
 * receiver that is only known at runtime not to carry the slot — already
 * exists as {@link ./receiver-brand.ts}'s `emitReceiverBrandCheck` and is used
 * by the reflective closure bodies (`gOPD(X.prototype, m).get.call(recv)`).
 * The two are siblings, not alternatives: this one covers the *syntactic*
 * prototype receiver that never reaches a reflective closure at all.
 *
 * ## Shadow safety
 *
 * The gate fires only when the base identifier's own type symbol is the lib
 * `<Name>Constructor` interface (`declare var Date: DateConstructor`). A
 * user-declared `class Date {}` types its identifier as `typeof Date` with
 * symbol name `Date`, so it never matches — the gate cannot hijack a
 * user-defined class that happens to share a builtin name. This is strictly
 * tighter than the `getSymbol()?.name` test the surrounding arms use, and it
 * is answered entirely through `ctx.oracle` (no raw checker use).
 *
 * ## Lane scope
 *
 * `noJsHost` only (standalone / WASI). In JS-host mode these reads/calls
 * already route to the host getter, which throws a genuine host TypeError;
 * re-routing them to a wasm-constructed one would be a behavioural change to a
 * lane that is not broken. See #3610.
 */
import ts from "typescript";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError, noJsHost } from "./js-errors.js";

/** WasmGC `none` bottom heap type (signed LEB −18) — `ref.null none`, the
 *  canonical `anyref` null (mirrors receiver-brand.ts / map-runtime.ts). */
const NONE_HEAP = -18;

const TYPED_ARRAY_CTORS = [
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
] as const;

/**
 * Accessor getters whose spec step 1–2 is `RequireInternalSlot` — reading one
 * off the constructor's `.prototype` object throws TypeError unconditionally.
 *
 * Deliberately EXCLUDED — these have an explicit spec carve-out that returns a
 * value instead of throwing when `this` is the prototype, so a gate here would
 * be a wrong answer:
 *   - `RegExp.prototype.{source,flags,global,…}` (§22.2.6: `SameValue(R, %RegExp.prototype%)`
 *     → `"(?:)"` / `""` / `undefined`).
 *   - `Array.prototype.length` / `String.prototype.length` — own data properties
 *     of the prototype object itself (0), not brand-checked accessors.
 */
const BRANDED_PROTO_GETTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ...TYPED_ARRAY_CTORS.map(
    (name) => [name, new Set(["buffer", "byteLength", "byteOffset", "length"])] as [string, ReadonlySet<string>],
  ),
  // §25.1.6 — get ArrayBuffer.prototype.{byteLength,maxByteLength,resizable,detached}
  ["ArrayBuffer", new Set(["byteLength", "maxByteLength", "resizable", "detached"])],
  // §25.2.5 — get SharedArrayBuffer.prototype.{byteLength,maxByteLength,growable}
  ["SharedArrayBuffer", new Set(["byteLength", "maxByteLength", "growable"])],
  // §25.3.4 — get DataView.prototype.{buffer,byteLength,byteOffset}
  ["DataView", new Set(["buffer", "byteLength", "byteOffset"])],
]);

/**
 * §23.2.3 — every `%TypedArray%.prototype` method starts at
 * `ValidateTypedArray(this)` → `RequireInternalSlot(O, [[TypedArrayName]])`.
 *
 * `toString` / `toLocaleString` are EXCLUDED: `%TypedArray%.prototype.toString`
 * IS `Array.prototype.toString` (§23.2.3.32), a generic function, so gating it
 * would be gating a member the prototype legitimately shares with Array.
 * (It still throws — via the `join` it forwards to — just not from here.)
 */
const TYPED_ARRAY_PROTO_METHODS: ReadonlySet<string> = new Set([
  "at",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "reverse",
  "set",
  "slice",
  "some",
  "sort",
  "subarray",
  "toReversed",
  "toSorted",
  "values",
  "with",
]);

/**
 * §21.4.4 — every `Date.prototype` method starts at `thisTimeValue(this)` (or
 * `ToObject` + an inherited `valueOf` that does), which throws TypeError when
 * `this` has no [[DateValue]]. `Date.prototype` provably has none. Mirrors the
 * `DATE_METHODS` set in `expressions/builtins.ts` (`compileDateMethodCall`),
 * which is exactly the set that lowers to a `struct.get $Date` on the receiver
 * — i.e. exactly the set that traps `null reference` today.
 *
 * Inherited `Object.prototype` members (`hasOwnProperty`, `isPrototypeOf`, …)
 * are NOT here: they are generic and must keep working on a prototype object.
 *
 * RegExp is absent on purpose: `RegExp.prototype.test()` already throws a
 * catchable TypeError via the native RegExp lowering, and `RegExp.prototype.exec()`
 * is claimed by an earlier dispatch arm that this gate never sees (it returns a
 * wrong value rather than trapping — a correctness gap, not a trap; tracked in
 * #3610). Its accessors additionally have the §22.2.6 prototype carve-out
 * (`source` → `"(?:)"`), so the family is not a uniform "always throws" one.
 */
const BRANDED_PROTO_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ...TYPED_ARRAY_CTORS.map((name) => [name, TYPED_ARRAY_PROTO_METHODS] as [string, ReadonlySet<string>]),
  // §25.1.6 / §25.2.5 — RequireInternalSlot([[ArrayBufferData]]).
  ["ArrayBuffer", new Set(["slice", "resize", "transfer", "transferToFixedLength", "transferToImmutable"])],
  ["SharedArrayBuffer", new Set(["slice", "grow"])],
  // §24.1.3 / §24.2.4 — RequireInternalSlot([[MapData]] / [[SetData]]).
  ["Map", new Set(["get", "set", "has", "delete", "clear", "forEach", "entries", "keys", "values"])],
  [
    "Set",
    new Set([
      "add",
      "has",
      "delete",
      "clear",
      "forEach",
      "entries",
      "keys",
      "values",
      "union",
      "intersection",
      "difference",
      "symmetricDifference",
      "isSubsetOf",
      "isSupersetOf",
      "isDisjointFrom",
    ]),
  ],
  ["WeakMap", new Set(["get", "set", "has", "delete"])],
  ["WeakSet", new Set(["add", "has", "delete"])],
  [
    "Date",
    new Set([
      "getTime",
      "valueOf",
      "getFullYear",
      "getMonth",
      "getDate",
      "getHours",
      "getMinutes",
      "getSeconds",
      "getMilliseconds",
      "getDay",
      "setTime",
      "setMilliseconds",
      "setSeconds",
      "setMinutes",
      "setHours",
      "setUTCMilliseconds",
      "setUTCSeconds",
      "setUTCMinutes",
      "setUTCHours",
      "setDate",
      "setUTCDate",
      "setMonth",
      "setUTCMonth",
      "setFullYear",
      "setUTCFullYear",
      "setYear",
      "getYear",
      "getTimezoneOffset",
      "getUTCFullYear",
      "getUTCMonth",
      "getUTCDate",
      "getUTCHours",
      "getUTCMinutes",
      "getUTCSeconds",
      "getUTCMilliseconds",
      "getUTCDay",
      "toISOString",
      "toJSON",
      "toString",
      "toDateString",
      "toTimeString",
      "toLocaleDateString",
      "toLocaleTimeString",
      "toLocaleString",
      "toUTCString",
      "toGMTString",
    ]),
  ],
]);

/**
 * When `recv` is syntactically `<Id>.prototype` and `<Id>` is the LIB global
 * constructor of that name, return the constructor name; otherwise undefined.
 *
 * The lib-identity test is `declaredNameOf(<Id>) === "<Id>Constructor"` — the
 * uniform lib.d.ts shape (`declare var Date: DateConstructor`). A user
 * `class Date {}` gives `declaredNameOf` === `"Date"`, so it is rejected.
 */
export function builtinPrototypeReceiver(ctx: CodegenContext, recv: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(recv) || recv.name.text !== "prototype") return undefined;
  const base = recv.expression;
  if (!ts.isIdentifier(base)) return undefined;
  const name = base.text;
  return ctx.oracle.declaredNameOf(base) === `${name}Constructor` ? name : undefined;
}

/**
 * Emit the unconditional catchable TypeError plus a typed, unreachable sentinel
 * so the surrounding expression keeps its static ValType and the stack stays
 * well-typed (`throw` is stack-polymorphic, but the emitters downstream of a
 * property read still reason about a concrete result type).
 */
function emitBrandThrowWithSentinel(
  ctx: CodegenContext,
  fctx: FunctionContext,
  message: string,
  result: ValType,
): ValType {
  emitThrowTypeError(ctx, fctx, message);
  for (const instr of sentinelInstrs(result)) fctx.body.push(instr);
  return result;
}

/** A zero/null value of `t`, emitted after the (terminal) throw purely to keep
 *  the surrounding expression's static ValType and the stack well-typed. */
function sentinelInstrs(t: ValType): Instr[] {
  switch (t.kind) {
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    case "externref":
      return [{ op: "ref.null.extern" }];
    case "funcref":
      return [{ op: "ref.null.func" }];
    case "anyref":
      return [{ op: "ref.null", typeIdx: NONE_HEAP }];
    case "ref":
      return [{ op: "ref.null", typeIdx: t.typeIdx }, { op: "ref.as_non_null" }];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: t.typeIdx }];
    default:
      return [{ op: "f64.const", value: 0 }];
  }
}

/**
 * Property-read arm: `<Builtin>.prototype.<brandedGetter>`.
 *
 * Returns the result ValType when the gate fired (a TypeError throw was
 * emitted), or `undefined` to fall through to the normal dispatch chain.
 *
 * The receiver is NOT compiled: it is syntactically an identifier plus a
 * `.prototype` read, which is observably side-effect-free, so skipping it
 * preserves evaluation order.
 */
export function tryBuiltinPrototypeGetterBrandThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (!noJsHost(ctx) && !ctx.strictNoHostImports) return undefined;
  const ctor = builtinPrototypeReceiver(ctx, expr.expression);
  if (ctor === undefined) return undefined;
  if (BRANDED_PROTO_GETTERS.get(ctor)?.has(propName) !== true) return undefined;
  const result: ValType = propName === "buffer" ? { kind: "externref" } : ctx.fast ? { kind: "i32" } : { kind: "f64" };
  return emitBrandThrowWithSentinel(
    ctx,
    fctx,
    `TypeError: Method get ${ctor}.prototype.${propName} called on incompatible receiver ${ctor}.prototype`,
    result,
  );
}

/**
 * Method-call arm: `<Builtin>.prototype.<brandedMethod>(...args)`.
 *
 * Arguments ARE compiled (and dropped): per §13.3.6.1 EvaluateCall runs
 * ArgumentListEvaluation BEFORE Call(), so `Date.prototype.setFullYear(f())`
 * must still observe `f()`'s side effects before the TypeError.
 *
 * `compileArg` is injected to avoid a module cycle with `expressions.ts`.
 */
export function tryBuiltinPrototypeMethodBrandThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  compileArg: (arg: ts.Expression) => ValType | null,
  expectedType?: ValType,
): ValType | undefined {
  if (!noJsHost(ctx) && !ctx.strictNoHostImports) return undefined;
  const ctor = builtinPrototypeReceiver(ctx, propAccess.expression);
  if (ctor === undefined) return undefined;
  const method = propAccess.name.text;
  if (BRANDED_PROTO_METHODS.get(ctor)?.has(method) !== true) return undefined;
  for (const arg of expr.arguments) {
    const t = compileArg(arg);
    if (t !== null) fctx.body.push({ op: "drop" });
  }
  // Honour the contextual type when the caller has one: these methods return
  // arrays / views / iterators, and handing back an f64 where a `(ref $vec)`
  // was requested would force a coercion the (dead) sentinel cannot satisfy.
  return emitBrandThrowWithSentinel(
    ctx,
    fctx,
    `TypeError: Method ${ctor}.prototype.${method} called on incompatible receiver ${ctor}.prototype`,
    expectedType ?? (ctx.fast ? { kind: "i32" } : { kind: "f64" }),
  );
}
