// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3231) Wasm-native `DisposableStack` runtime for standalone / WASI targets.
 *
 * In JS-host mode `new DisposableStack()` and every method route through the
 * `DisposableStack_*` host imports (registered in index.ts). Under `--target
 * standalone` / `--target wasi` there is no JS host to satisfy those imports, so
 * this module emits a pure-WasmGC DisposableStack: an externref-carried struct
 * holding a growable array of disposal entries.
 *
 * The instance flows as an **externref** (matching the extern-class default in
 * `resolveWasmType`, index.ts) wrapping a `$DisposableStack` struct via
 * `extern.convert_any`; each method site casts externref → struct
 * (`any.convert_extern` + `ref.cast`). This avoids the Map-style `ref $Map`
 * type-resolution special case.
 *
 * ## Disposal callback dispatch (the funcIdx-ordering crux)
 *
 * `defer`/`adopt` callbacks are stored as first-class WasmGC closures (the
 * standalone gate in `closures.ts` routes them to the closure-struct path, not
 * `__make_callback`). The dispose loop must invoke HETEROGENEOUS stored closures,
 * which only the `__call_fn_N` dispatchers (funcref-type dispatch, emitted LATE
 * at finalize) can do. So the dispose function is a **reserve/fill driver**
 * (mirrors `accessor-driver.ts`): reserved early with a placeholder body so
 * `.dispose()` sites can `call` its funcIdx, then filled at finalize once
 * `__call_fn_0`/`__call_fn_1` exist.
 *
 * Phase 1a scope: construct / `disposed` / `defer` / `adopt` / `dispose` (LIFO) /
 * `move` / disposed-throw / `[Symbol.dispose]`.
 *
 * Phase 1b adds `use(value)`: a RUNTIME `value[Symbol.dispose]` member lookup on
 * an arbitrary receiver (`__box_symbol(13)` + `__extern_get` over the native
 * `$Object` substrate), TypeError on a non-disposable arg, and a third disposer
 * kind (`ENTRY_KIND_USE`) invoked at dispose via `__call_fn_method_0(value,
 * method)` so the method's `this` binds to the used value. SuppressedError
 * multi-error aggregation remains a follow-up (see the issue file).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType, StructTypeDef, ArrayTypeDef } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addFuncType } from "./registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts, VOID_RESULT } from "./shared.js";
import { ensureObjectRuntime } from "./object-runtime.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

const INITIAL_CAPACITY = 4;

/** Disposal-entry kind discriminant (matches the dispose driver's switch). */
export const ENTRY_KIND_DEFER = 0; // cb()            via __call_fn_0
export const ENTRY_KIND_ADOPT = 1; // cb(value)       via __call_fn_1
export const ENTRY_KIND_USE = 2; // value[@@dispose]() via __call_fn_method_0 (Phase 1b)

interface DisposableTypes {
  stackTypeIdx: number;
  entryTypeIdx: number;
  entriesTypeIdx: number;
}

const TYPE_CACHE = new WeakMap<CodegenContext, DisposableTypes>();

/** Register (idempotent) the WasmGC struct/array types for the native runtime. */
export function ensureDisposableStackTypes(ctx: CodegenContext): DisposableTypes {
  const cached = TYPE_CACHE.get(ctx);
  if (cached) return cached;

  // $DisposeEntry: struct { cb: externref(mut); value: externref(mut); kind: i32(mut) }
  const entryTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "DisposeEntry",
    fields: [
      { name: "cb", type: EXTERNREF, mutable: true },
      { name: "value", type: EXTERNREF, mutable: true },
      { name: "kind", type: I32, mutable: true },
    ],
  } as StructTypeDef);

  // $DisposeEntries: (array (mut (ref null $DisposeEntry)))
  const entriesTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "DisposeEntries",
    element: { kind: "ref_null", typeIdx: entryTypeIdx },
    mutable: true,
  } as ArrayTypeDef);

  // $DisposableStack: struct { disposed: i32(mut); entries: (ref null $DisposeEntries)(mut); count: i32(mut) }
  const stackTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "DisposableStack",
    fields: [
      { name: "disposed", type: I32, mutable: true },
      { name: "entries", type: { kind: "ref_null", typeIdx: entriesTypeIdx }, mutable: true },
      { name: "count", type: I32, mutable: true },
    ],
  } as StructTypeDef);
  ctx.structMap.set("DisposableStack", stackTypeIdx);
  ctx.typeIdxToStructName.set(stackTypeIdx, "DisposableStack");

  const types = { stackTypeIdx, entryTypeIdx, entriesTypeIdx };
  TYPE_CACHE.set(ctx, types);
  return types;
}

/** ValType helpers once types are registered. */
function stackRefNull(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: ensureDisposableStackTypes(ctx).stackTypeIdx };
}

/** Instrs: convert an externref (top of stack) → (ref null $DisposableStack). */
function externToStack(ctx: CodegenContext): Instr[] {
  const t = ensureDisposableStackTypes(ctx);
  return [{ op: "any.convert_extern" } as Instr, { op: "ref.cast_null", typeIdx: t.stackTypeIdx } as Instr];
}

// ── Helper functions (early-emitted; struct/array ops + error throw only) ─────

function ensureHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: { name: string; type: ValType }[],
  buildBody: () => Instr[],
): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body: buildBody(), exported: false });
  return funcIdx;
}

/**
 * `__disposablestack_new() -> externref` — allocate an empty stack wrapped as
 * externref. entries starts as a fixed-capacity array of nulls; count = 0.
 */
export function ensureDisposableStackNew(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  return ensureHelper(ctx, "__disposablestack_new", [], [EXTERNREF], [], () => [
    // disposed = 0
    { op: "i32.const", value: 0 } as Instr,
    // entries = new $DisposeEntries[INITIAL_CAPACITY] (nulls)
    { op: "ref.null", typeIdx: t.entryTypeIdx } as Instr,
    { op: "i32.const", value: INITIAL_CAPACITY } as Instr,
    { op: "array.new", typeIdx: t.entriesTypeIdx } as Instr,
    // count = 0
    { op: "i32.const", value: 0 } as Instr,
    { op: "struct.new", typeIdx: t.stackTypeIdx } as Instr,
    { op: "extern.convert_any" } as Instr,
  ]);
}

/**
 * `__disposablestack_append(stack, cb, value, kind)` — RequireInternalSlot +
 * disposed-throw (ReferenceError), then push an entry (growing the backing array
 * on demand). Locals: 4=struct, 5=entries, 6=cap, 7=count, 8=newEntries.
 */
export function ensureDisposableStackAppend(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  const entriesRefNull: ValType = { kind: "ref_null", typeIdx: t.entriesTypeIdx };
  return ensureHelper(
    ctx,
    "__disposablestack_append",
    [EXTERNREF, EXTERNREF, EXTERNREF, I32],
    [],
    [
      { name: "__ds", type: stackRefNull(ctx) },
      { name: "__entries", type: entriesRefNull },
      { name: "__cap", type: I32 },
      { name: "__count", type: I32 },
      { name: "__new", type: entriesRefNull },
      { name: "__i", type: I32 },
    ],
    () => {
      const STACK = 0,
        CB = 1,
        VALUE = 2,
        KIND = 3,
        DS = 4,
        ENTRIES = 5,
        CAP = 6,
        COUNT = 7,
        NEW = 8,
        I = 9;
      const body: Instr[] = [];
      // ds = cast(stack); RequireInternalSlot: null → ReferenceError
      body.push({ op: "local.get", index: STACK } as Instr);
      body.push(...externToStack(ctx));
      body.push({ op: "local.tee", index: DS } as Instr);
      body.push({ op: "ref.is_null" } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack has no [[DisposableState]]"),
        else: [],
      } as Instr);
      // if disposed: throw ReferenceError
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack already disposed"),
        else: [],
      } as Instr);
      // entries = ds.entries; count = ds.count; cap = len(entries)
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 1 } as Instr);
      body.push({ op: "local.tee", index: ENTRIES } as Instr);
      body.push({ op: "array.len" } as Instr);
      body.push({ op: "local.set", index: CAP } as Instr);
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 2 } as Instr);
      body.push({ op: "local.set", index: COUNT } as Instr);
      // if count >= cap: grow (new array of cap*2, copy)
      body.push({ op: "local.get", index: COUNT } as Instr);
      body.push({ op: "local.get", index: CAP } as Instr);
      body.push({ op: "i32.ge_s" } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // new = new $DisposeEntries[cap*2]
          { op: "ref.null", typeIdx: t.entryTypeIdx } as Instr,
          { op: "local.get", index: CAP } as Instr,
          { op: "i32.const", value: 2 } as Instr,
          { op: "i32.mul" } as Instr,
          { op: "i32.const", value: INITIAL_CAPACITY } as Instr,
          { op: "i32.add" } as Instr, // +INITIAL guards cap==0
          { op: "array.new", typeIdx: t.entriesTypeIdx } as Instr,
          { op: "local.set", index: NEW } as Instr,
          // copy: array.copy(new, 0, entries, 0, count)
          { op: "local.get", index: NEW } as Instr,
          { op: "i32.const", value: 0 } as Instr,
          { op: "local.get", index: ENTRIES } as Instr,
          { op: "i32.const", value: 0 } as Instr,
          { op: "local.get", index: COUNT } as Instr,
          { op: "array.copy", dstTypeIdx: t.entriesTypeIdx, srcTypeIdx: t.entriesTypeIdx } as Instr,
          // entries = new; ds.entries = new
          { op: "local.get", index: NEW } as Instr,
          { op: "local.set", index: ENTRIES } as Instr,
          { op: "local.get", index: DS } as Instr,
          { op: "local.get", index: NEW } as Instr,
          { op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 1 } as Instr,
        ],
        else: [],
      } as Instr);
      // entries[count] = new $DisposeEntry(cb, value, kind)
      body.push({ op: "local.get", index: ENTRIES } as Instr);
      body.push({ op: "local.get", index: COUNT } as Instr);
      body.push({ op: "local.get", index: CB } as Instr);
      body.push({ op: "local.get", index: VALUE } as Instr);
      body.push({ op: "local.get", index: KIND } as Instr);
      body.push({ op: "struct.new", typeIdx: t.entryTypeIdx } as Instr);
      body.push({ op: "array.set", typeIdx: t.entriesTypeIdx } as Instr);
      // ds.count = count + 1
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "local.get", index: COUNT } as Instr);
      body.push({ op: "i32.const", value: 1 } as Instr);
      body.push({ op: "i32.add" } as Instr);
      body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 2 } as Instr);
      void I;
      return body;
    },
  );
}

/**
 * `__disposablestack_move(stack) -> externref` — RequireInternalSlot +
 * disposed-throw, then create a new stack that takes over this stack's entries
 * and mark this stack disposed (§12.3.3.5).
 */
export function ensureDisposableStackMove(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  return ensureHelper(
    ctx,
    "__disposablestack_move",
    [EXTERNREF],
    [EXTERNREF],
    [{ name: "__ds", type: stackRefNull(ctx) }],
    () => {
      const STACK = 0,
        DS = 1;
      const body: Instr[] = [];
      body.push({ op: "local.get", index: STACK } as Instr);
      body.push(...externToStack(ctx));
      body.push({ op: "local.tee", index: DS } as Instr);
      body.push({ op: "ref.is_null" } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack has no [[DisposableState]]"),
        else: [],
      } as Instr);
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack already disposed"),
        else: [],
      } as Instr);
      // new stack struct { disposed:0, entries: ds.entries, count: ds.count }
      body.push({ op: "i32.const", value: 0 } as Instr);
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 1 } as Instr);
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 2 } as Instr);
      body.push({ op: "struct.new", typeIdx: t.stackTypeIdx } as Instr);
      body.push({ op: "extern.convert_any" } as Instr);
      // mark this disposed: ds.disposed = 1; ds.count = 0
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "i32.const", value: 1 } as Instr);
      body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 0 } as Instr);
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "i32.const", value: 0 } as Instr);
      body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 2 } as Instr);
      // The new-stack externref built above is still on the value stack (the two
      // struct.set ops consume only DS + their operand), so it is the return value.
      return body;
    },
  );
}

/**
 * `__disposablestack_check_active(stack)` — RequireInternalSlot (null →
 * ReferenceError) + disposed-throw (ReferenceError). No append/return. `use()`
 * needs this as a standalone check because the null/undefined-value fast path
 * (§ AddDisposableResource step 1.a) skips the append helper (which carries the
 * same check) yet the disposed check must STILL fire first (§
 * DisposableStack.prototype.use steps 2–3 run before AddDisposableResource).
 */
export function ensureDisposableStackCheckActive(ctx: CodegenContext): number {
  const t = ensureDisposableStackTypes(ctx);
  return ensureHelper(
    ctx,
    "__disposablestack_check_active",
    [EXTERNREF],
    [],
    [{ name: "__ds", type: stackRefNull(ctx) }],
    () => {
      const STACK = 0,
        DS = 1;
      const body: Instr[] = [];
      body.push({ op: "local.get", index: STACK } as Instr);
      body.push(...externToStack(ctx));
      body.push({ op: "local.tee", index: DS } as Instr);
      body.push({ op: "ref.is_null" } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack has no [[DisposableState]]"),
        else: [],
      } as Instr);
      body.push({ op: "local.get", index: DS } as Instr);
      body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "ReferenceError", "DisposableStack already disposed"),
        else: [],
      } as Instr);
      return body;
    },
  );
}

// ── dispose reserve/fill driver (needs __call_fn_N, emitted late) ────────────

const DISPOSE_DRIVER = "__disposablestack_dispose";

/**
 * Reserve `__disposablestack_dispose(stack)` with a placeholder body so
 * `.dispose()` sites can `call` its funcIdx. Body filled by
 * `fillDisposableStackDisposeDriver` at finalize.
 */
export function reserveDisposableStackDisposeDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(DISPOSE_DRIVER);
  if (existing !== undefined) return existing;
  ensureDisposableStackTypes(ctx);
  const typeIdx = addFuncType(ctx, [EXTERNREF], []);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(DISPOSE_DRIVER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: DISPOSE_DRIVER,
    typeIdx,
    locals: [],
    body: [{ op: "return" } as Instr],
    exported: false,
  });
  (ctx as unknown as { disposableStackDisposeReserved?: boolean }).disposableStackDisposeReserved = true;
  return funcIdx;
}

/**
 * Fill the reserved dispose driver at finalize, AFTER `__call_fn_0`/`__call_fn_1`
 * are registered. Runs each stored disposer LIFO. No-op when the driver was
 * never reserved.
 */
export function fillDisposableStackDisposeDriver(ctx: CodegenContext): void {
  if (!(ctx as unknown as { disposableStackDisposeReserved?: boolean }).disposableStackDisposeReserved) return;
  const driverIdx = ctx.funcMap.get(DISPOSE_DRIVER);
  if (driverIdx === undefined) return;
  const driverFn = definedFuncAt(ctx, driverIdx);
  if (!driverFn) return;
  const t = ensureDisposableStackTypes(ctx);
  // `__call_fn_N` exports are pushed straight onto mod.functions/mod.exports by
  // `emitClosureCallExportN` and are NOT registered in `funcMap` (unlike
  // `__call_fn_method_N`), so resolve their funcIdx via the export table.
  const callFnIdx = (name: string): number | undefined => {
    const exp = ctx.mod.exports.find((e) => e.name === name && e.desc?.kind === "func");
    return exp?.desc?.kind === "func" ? exp.desc.index : undefined;
  };
  const callFn0 = callFnIdx("__call_fn_0");
  const callFn1 = callFnIdx("__call_fn_1");
  // (#3231 Phase 1b) `use()` disposers invoke `value[@@dispose]()` — the stored
  // method with `value` bound as `this` — via the `__call_fn_method_0` bridge
  // (unlike `__call_fn_N`, it IS registered in `funcMap`; #1636-S1). Emitted by
  // `emitClosureMethodCallExportN(0)` BEFORE this fill runs (index.ts finalize
  // order: 2560 < 2621), so a `use()` module has it. Resolve by name.
  const callFnMethod0 = ctx.funcMap.get("__call_fn_method_0");

  const STACK = 0,
    DS = 0 + 1,
    ENTRIES = 2,
    I = 3,
    ENTRY = 4,
    KIND = 5;
  driverFn.locals = [
    { name: "__ds", type: stackRefNull(ctx) },
    { name: "__entries", type: { kind: "ref_null", typeIdx: t.entriesTypeIdx } },
    { name: "__i", type: I32 },
    { name: "__entry", type: { kind: "ref_null", typeIdx: t.entryTypeIdx } },
    { name: "__kind", type: I32 },
  ];

  const body: Instr[] = [];
  // ds = cast(stack); if null return
  body.push({ op: "local.get", index: STACK } as Instr);
  body.push(...externToStack(ctx));
  body.push({ op: "local.tee", index: DS } as Instr);
  body.push({ op: "ref.is_null" } as Instr);
  body.push({ op: "if", blockType: { kind: "empty" }, then: [{ op: "return" } as Instr], else: [] } as Instr);
  // if already disposed: return
  body.push({ op: "local.get", index: DS } as Instr);
  body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 } as Instr);
  body.push({ op: "if", blockType: { kind: "empty" }, then: [{ op: "return" } as Instr], else: [] } as Instr);
  // ds.disposed = 1
  body.push({ op: "local.get", index: DS } as Instr);
  body.push({ op: "i32.const", value: 1 } as Instr);
  body.push({ op: "struct.set", typeIdx: t.stackTypeIdx, fieldIdx: 0 } as Instr);
  // entries = ds.entries; i = ds.count - 1
  body.push({ op: "local.get", index: DS } as Instr);
  body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 1 } as Instr);
  body.push({ op: "local.set", index: ENTRIES } as Instr);
  body.push({ op: "local.get", index: DS } as Instr);
  body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 2 } as Instr);
  body.push({ op: "i32.const", value: 1 } as Instr);
  body.push({ op: "i32.sub" } as Instr);
  body.push({ op: "local.set", index: I } as Instr);

  // LIFO loop
  const loopBody: Instr[] = [];
  // if i < 0 break
  loopBody.push({ op: "local.get", index: I } as Instr);
  loopBody.push({ op: "i32.const", value: 0 } as Instr);
  loopBody.push({ op: "i32.lt_s" } as Instr);
  loopBody.push({ op: "br_if", depth: 1 } as Instr); // break out of block (depth 1 = enclosing block)
  // entry = entries[i]
  loopBody.push({ op: "local.get", index: ENTRIES } as Instr);
  loopBody.push({ op: "local.get", index: I } as Instr);
  loopBody.push({ op: "array.get", typeIdx: t.entriesTypeIdx } as Instr);
  loopBody.push({ op: "local.tee", index: ENTRY } as Instr);
  // if entry != null: dispatch
  loopBody.push({ op: "ref.is_null" } as Instr);
  loopBody.push({ op: "i32.eqz" } as Instr);
  const dispatch: Instr[] = [];
  dispatch.push({ op: "local.get", index: ENTRY } as Instr);
  dispatch.push({ op: "struct.get", typeIdx: t.entryTypeIdx, fieldIdx: 2 } as Instr);
  dispatch.push({ op: "local.set", index: KIND } as Instr);
  // Instr helpers for the entry's callback (fieldIdx 0) and captured value (1).
  const entryCb = (): Instr[] => [
    { op: "local.get", index: ENTRY } as Instr,
    { op: "struct.get", typeIdx: t.entryTypeIdx, fieldIdx: 0 } as Instr,
  ];
  const entryValue = (): Instr[] => [
    { op: "local.get", index: ENTRY } as Instr,
    { op: "struct.get", typeIdx: t.entryTypeIdx, fieldIdx: 1 } as Instr,
  ];
  // Per-kind invocation, each a no-op when its dispatcher is unavailable:
  //   USE   (2): `value[@@dispose]()` → __call_fn_method_0(value, method)
  //   ADOPT (1): onDispose(value)     → __call_fn_1(cb, value)
  //   DEFER (0): onDispose()          → __call_fn_0(cb)
  const useCall: Instr[] =
    callFnMethod0 !== undefined
      ? [...entryValue(), ...entryCb(), { op: "call", funcIdx: callFnMethod0 } as Instr, { op: "drop" } as Instr]
      : [];
  const adoptCall: Instr[] =
    callFn1 !== undefined
      ? [...entryCb(), ...entryValue(), { op: "call", funcIdx: callFn1 } as Instr, { op: "drop" } as Instr]
      : [];
  const deferCall: Instr[] =
    callFn0 !== undefined ? [...entryCb(), { op: "call", funcIdx: callFn0 } as Instr, { op: "drop" } as Instr] : [];
  // if kind == USE → useCall; else if kind == ADOPT → adoptCall; else deferCall.
  dispatch.push({ op: "local.get", index: KIND } as Instr);
  dispatch.push({ op: "i32.const", value: ENTRY_KIND_USE } as Instr);
  dispatch.push({ op: "i32.eq" } as Instr);
  dispatch.push({
    op: "if",
    blockType: { kind: "empty" },
    then: useCall,
    else: [
      { op: "local.get", index: KIND } as Instr,
      { op: "i32.const", value: ENTRY_KIND_ADOPT } as Instr,
      { op: "i32.eq" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: adoptCall, else: deferCall } as Instr,
    ],
  } as Instr);
  loopBody.push({ op: "if", blockType: { kind: "empty" }, then: dispatch, else: [] } as Instr);
  // i = i - 1; continue
  loopBody.push({ op: "local.get", index: I } as Instr);
  loopBody.push({ op: "i32.const", value: 1 } as Instr);
  loopBody.push({ op: "i32.sub" } as Instr);
  loopBody.push({ op: "local.set", index: I } as Instr);
  loopBody.push({ op: "br", depth: 0 } as Instr); // continue loop

  // block { loop { ... } }
  body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);

  driverFn.body = body;
}

// ── Front-end intercepts ─────────────────────────────────────────────────────

/** Compile an argument expression and coerce the result to externref. */
function compileArgAsExternref(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const t = compileExpression(ctx, fctx, arg);
  if (t !== null && !(t.kind === "externref")) coerceType(ctx, fctx, t, EXTERNREF);
}

/**
 * (#3231) Intercept a `DisposableStack.prototype.*` method call in standalone /
 * `nativeStrings` mode. Handles `dispose` / `defer` / `adopt` / `move`. Returns
 * the result ValType/sentinel when handled, else `undefined` (host fallthrough —
 * e.g. `use`, Phase 1b). The receiver and args are compiled here.
 */
export function tryCompileNativeDisposableStackMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const methodName = propAccess.name.text;
  const args = callExpr.arguments;
  ensureDisposableStackTypes(ctx);

  if (methodName === "dispose") {
    const driver = reserveDisposableStackDisposeDriver(ctx);
    compileExpression(ctx, fctx, propAccess.expression); // stack externref
    fctx.body.push({ op: "call", funcIdx: driver } as Instr);
    return VOID_RESULT;
  }

  if (methodName === "move") {
    const moveIdx = ensureDisposableStackMove(ctx);
    compileExpression(ctx, fctx, propAccess.expression); // stack externref
    fctx.body.push({ op: "call", funcIdx: moveIdx } as Instr);
    return EXTERNREF;
  }

  if (methodName === "defer") {
    const appendIdx = ensureDisposableStackAppend(ctx);
    // Eval order: receiver, then onDispose(arg0). Buffer via locals so the
    // append arg order (stack, cb, value, kind) is independent of eval order.
    const stackLocal = allocLocal(fctx, `__ds_stack_${fctx.locals.length}`, EXTERNREF);
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.set", index: stackLocal } as Instr);
    const cbLocal = allocLocal(fctx, `__ds_cb_${fctx.locals.length}`, EXTERNREF);
    if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
    else fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "local.set", index: cbLocal } as Instr);
    fctx.body.push({ op: "local.get", index: stackLocal } as Instr);
    fctx.body.push({ op: "local.get", index: cbLocal } as Instr);
    fctx.body.push({ op: "ref.null.extern" } as Instr); // value = null
    fctx.body.push({ op: "i32.const", value: ENTRY_KIND_DEFER } as Instr);
    fctx.body.push({ op: "call", funcIdx: appendIdx } as Instr);
    return VOID_RESULT;
  }

  if (methodName === "adopt") {
    const appendIdx = ensureDisposableStackAppend(ctx);
    // adopt(value, onDispose) — eval value then onDispose; return value.
    const stackLocal = allocLocal(fctx, `__ds_stack_${fctx.locals.length}`, EXTERNREF);
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.set", index: stackLocal } as Instr);
    const valueLocal = allocLocal(fctx, `__ds_val_${fctx.locals.length}`, EXTERNREF);
    if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
    else fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "local.set", index: valueLocal } as Instr);
    const cbLocal = allocLocal(fctx, `__ds_cb_${fctx.locals.length}`, EXTERNREF);
    if (args[1]) compileArgAsExternref(ctx, fctx, args[1]);
    else fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "local.set", index: cbLocal } as Instr);
    fctx.body.push({ op: "local.get", index: stackLocal } as Instr);
    fctx.body.push({ op: "local.get", index: cbLocal } as Instr);
    fctx.body.push({ op: "local.get", index: valueLocal } as Instr);
    fctx.body.push({ op: "i32.const", value: ENTRY_KIND_ADOPT } as Instr);
    fctx.body.push({ op: "call", funcIdx: appendIdx } as Instr);
    fctx.body.push({ op: "local.get", index: valueLocal } as Instr); // return value
    return EXTERNREF;
  }

  if (methodName === "use") {
    return compileNativeDisposableStackUse(ctx, fctx, propAccess, args);
  }

  return undefined;
}

/** Well-known-symbol id for `Symbol.dispose` (property-access.ts registry). */
const SYMBOL_DISPOSE_ID = 13;

/**
 * (#3231 Phase 1b) `DisposableStack.prototype.use(value)` — the one method whose
 * disposer is discovered by a RUNTIME member lookup on an arbitrary receiver
 * (§ CreateDisposableResource → GetDisposeMethod → GetMethod(V, @@dispose)),
 * rather than a caller-supplied `onDispose`. Spec order (§12.3.3.3):
 *
 *   1. RequireInternalSlot + disposed-throw (ReferenceError) — ALWAYS first,
 *      even for `use(null)` on a disposed stack (test `throws-if-disposed`).
 *   2. If value is null/undefined → return value, no resource added
 *      (AddDisposableResource step 1.a; tests `allows-null-value`/`returns-value`).
 *   3. Else GetMethod(value, @@dispose): read `value[Symbol.dispose]` ONCE (an
 *      accessor is invoked exactly once — test `gets-value-…-property-once`) via
 *      the native `$Object` dynamic reader `__extern_get(value, __box_symbol(13))`.
 *      A non-object receiver reads back undefined (miss), so it lands in the same
 *      TypeError arm as an object missing the method — matching the spec's two
 *      distinct TypeError sources with one observable result.
 *   4. If the method is nullish → TypeError (tests `throws-if-value-not-object`,
 *      `throws-if-value-missing-Symbol.dispose`, `…-property-is-null`).
 *   5. Append entry{cb: method, value, kind: USE}; the dispose loop later runs
 *      `__call_fn_method_0(value, method)` (method-bound `this`). Return value.
 *
 * Gated `ctx.nativeStrings` (the caller's gate). The value is read via the same
 * native `$Object`/`__box_symbol` substrate the object-literal writer uses
 * (`literals.ts`), so a `{ [Symbol.dispose]() {} }` resource — always represented
 * as a native `$Object` under a `$Symbol` key — is found host-free.
 */
function compileNativeDisposableStackUse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  args: ts.NodeArray<ts.Expression> | readonly ts.Expression[],
): InnerResult {
  const appendIdx = ensureDisposableStackAppend(ctx);
  const checkIdx = ensureDisposableStackCheckActive(ctx);
  // Ensure the native object runtime is registered so `__extern_get` and
  // `__box_symbol` exist for the reads below.
  ensureObjectRuntime(ctx);

  const stackLocal = allocLocal(fctx, `__ds_stack_${fctx.locals.length}`, EXTERNREF);
  const valueLocal = allocLocal(fctx, `__ds_val_${fctx.locals.length}`, EXTERNREF);
  const methodLocal = allocLocal(fctx, `__ds_method_${fctx.locals.length}`, EXTERNREF);

  // Eval receiver → stackLocal; disposed-throw check FIRST (spec steps 2–3).
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: stackLocal } as Instr);
  fctx.body.push({ op: "local.get", index: stackLocal } as Instr);
  fctx.body.push({ op: "call", funcIdx: checkIdx } as Instr);

  // Eval value → valueLocal.
  if (args[0]) compileArgAsExternref(ctx, fctx, args[0]);
  else fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "local.set", index: valueLocal } as Instr);

  // Resolve the runtime helpers (registered by ensureObjectRuntime). `__box_symbol`
  // + `__extern_is_undefined` are ensured as (native, in standalone) late imports;
  // flush index shifts against fctx before baking the funcIdxs.
  const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");

  // The substrate should always exist once ensureObjectRuntime ran; if not, keep
  // the stack consistent (value evaluated for its side effects) and return value
  // rather than emit an unbalanced body.
  if (boxSymIdx === undefined || externGetIdx === undefined || isUndefinedIdx === undefined) {
    fctx.body.push({ op: "local.get", index: valueLocal } as Instr);
    return EXTERNREF;
  }

  // Regime-independent "is null OR undefined" for a value held in `localIdx`,
  // leaving an i32 on the stack. `__extern_is_nullish` exists only under the
  // undefined-singleton regime (object-runtime.ts, #2106 S1); combine the always-
  // present `ref.is_null` (JS null / ref.null.extern) with `__extern_is_undefined`
  // (the boxed/singleton undefined) so both regimes are covered.
  const nullishOf = (localIdx: number): Instr[] => [
    { op: "local.get", index: localIdx } as Instr,
    { op: "ref.is_null" } as Instr,
    { op: "local.get", index: localIdx } as Instr,
    { op: "call", funcIdx: isUndefinedIdx } as Instr,
    { op: "i32.or" } as Instr,
  ];
  const typeErr = (msg: string): Instr[] => buildThrowJsErrorInstrs(ctx, "TypeError", msg, { flush: fctx });

  // if !nullish(value): read method, validate, append.
  const nonNullishBody: Instr[] = [];
  // method = __extern_get(value, __box_symbol(SYMBOL_DISPOSE_ID)) — read ONCE.
  nonNullishBody.push({ op: "local.get", index: valueLocal } as Instr);
  nonNullishBody.push({ op: "i32.const", value: SYMBOL_DISPOSE_ID } as Instr);
  nonNullishBody.push({ op: "call", funcIdx: boxSymIdx } as Instr);
  nonNullishBody.push({ op: "call", funcIdx: externGetIdx } as Instr);
  nonNullishBody.push({ op: "local.set", index: methodLocal } as Instr);
  // if nullish(method): TypeError (non-object receiver OR missing/null @@dispose).
  nonNullishBody.push(...nullishOf(methodLocal));
  nonNullishBody.push({
    op: "if",
    blockType: { kind: "empty" },
    then: typeErr("DisposableStack.prototype.use: value is not disposable"),
    else: [],
  } as Instr);
  // append entry{cb: method, value, kind: USE}
  nonNullishBody.push({ op: "local.get", index: stackLocal } as Instr);
  nonNullishBody.push({ op: "local.get", index: methodLocal } as Instr);
  nonNullishBody.push({ op: "local.get", index: valueLocal } as Instr);
  nonNullishBody.push({ op: "i32.const", value: ENTRY_KIND_USE } as Instr);
  nonNullishBody.push({ op: "call", funcIdx: appendIdx } as Instr);

  fctx.body.push(...nullishOf(valueLocal));
  fctx.body.push({ op: "i32.eqz" } as Instr);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: nonNullishBody, else: [] } as Instr);

  // Return value.
  fctx.body.push({ op: "local.get", index: valueLocal } as Instr);
  return EXTERNREF;
}

/**
 * (#3231) Intercept the `DisposableStack.prototype.disposed` accessor in
 * standalone / `nativeStrings` mode → the struct's `disposed` i32 flag (0/1).
 * Receiver is compiled here. Returns i32 when handled, else `undefined`.
 */
export function tryCompileNativeDisposableStackDisposedGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const t = ensureDisposableStackTypes(ctx);
  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType === null) return undefined;
  if (recvType.kind === "externref") {
    fctx.body.push(...externToStack(ctx));
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== t.stackTypeIdx) {
    return undefined;
  }
  // struct.get disposed (fieldIdx 0) — a null receiver here would trap; the
  // getter is only reached on a real DisposableStack instance (brand-typed).
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: t.stackTypeIdx, fieldIdx: 0 } as Instr);
  return { kind: "i32" } as ValType;
}
