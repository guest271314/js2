// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2903 R3/R3b — native standalone LAZY Iterator-helper wrappers for dynamic
 * (`any`/externref) iterator receivers: `%Iterator.prototype%.map / filter /
 * take / drop / flatMap` (ES2025 §27.1.4.2/.3/.4/.5/.6). Sub-front 2 (iter-hof-native.ts)
 * covered the EAGER helpers (find/every/some/forEach/reduce/toArray) that drive
 * the source to completion and return a value; the lazy helpers instead return
 * a NEW iterator that produces transformed elements on demand.
 *
 * Design (per the #2903 re-ground R3 plan): ONE closed struct
 * `$LazyIterHelper { kind i32, src externref, fn externref, state (mut f64),
 * inner (mut externref) }`. `.map(fn)` etc. on an iterator receiver allocates a
 * wrapper whose `src` is the OPENED source handle (`__iter_hof_open(recv)` —
 * GetIteratorDirect at call time, §27.1.4 step 3) and whose `fn`/`state` carry
 * the transform. A single `__lazy_iter_step(wrapper) -> (i32 done, externref
 * value)` drives `src` via `__iter_hof_next` and applies the kind-dispatched
 * transform:
 *   - map:    apply `fn(value, counter)`, counter in `state`.
 *   - filter: loop pulling until `fn(value, counter)` is truthy.
 *   - take:   `state` = remaining; 0 ⇒ IteratorClose(src) + done.
 *   - drop:   `state` = remaining-to-skip; drain that many, then pass through.
 *   - flatMap: `inner` = the current inner-iterator handle; drain it fully
 *     (`__iter_hof_open(mapper(v, counter))`) before advancing `src`.
 *
 * The wrapper is itself an iterator: it is admitted by `__iter_hof_open`
 * (pass-through) so it CHAINS into downstream eager helpers / `.toArray()` /
 * further lazy helpers (arms in {@link fillIterHofSteppers}), and by the
 * `__iterator` / `__iterator_next` / `__iterator_return` GetIterator ladder
 * (prepended arms, {@link fillLazyIterLadderArms}) so `Array.from(...)`, spread,
 * and `for…of` drive it natively. No `env.__make_callback` host bridge, no host
 * import — the whole point of R3.
 *
 * BOUNDARIES (documented, same no-throw discipline as the eager helpers, #3098):
 *  - `.map`/`.filter`/`.take`/`.drop` on a NON-iterator receiver → the source
 *    handle is null ⇒ the wrapper yields nothing (empty), rather than the spec
 *    TypeError. (The dispatch arm already routes only non-`$Object`/non-vec
 *    receivers here; a plain object with no `[Symbol.iterator]` produces null.)
 *  - `take(n)`/`drop(n)` do ToInteger-ish flooring + clamp-negative-to-0, NOT
 *    the spec RangeError on negative/NaN (§27.1.4.4/.5 step 3.c).
 *  - IteratorClose on early exit is best-effort (`take` closes on limit; a
 *    caller's early break closes via `__iterator_return`); a driven-generator
 *    source frame's `.return()`/finally is not triggered (§27.5.3.3 boundary,
 *    inherited from the eager steppers).
 *  - `result-is-iterator` / `instanceof Iterator` brand identity is NOT modeled
 *    (the wrapper is a bespoke struct, not `%IteratorHelperPrototype%`).
 *
 * Emitted at RESERVE time (append-only defined funcs — no funcIdx shift), so the
 * fills only READ funcMap/structMap (#1719). Standalone only. Idempotent.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { reserveIterHofSteppers } from "./iter-hof-native.js";
import { ensureNativeArrayFromIterN, ensureNativeIteratorRuntime } from "./iterator-native.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";

/** Method names served by {@link ensureNativeLazyIter}. */
export const LAZY_ITER_METHODS: ReadonlySet<string> = new Set(["map", "filter", "take", "drop", "flatMap"]);

/** `state` semantics differ by kind (see module header). */
const KIND: Record<string, number> = { map: 0, filter: 1, take: 2, drop: 3, flatMap: 4 };

/** Field indices of `$LazyIterHelper` — load-bearing order. */
const F_KIND = 0;
const F_SRC = 1;
const F_FN = 2;
const F_STATE = 3;
const F_INNER = 4; // flatMap: the current inner-iterator handle (or null)

/** True when `methodName`/`arity` is a form the lazy arm services. */
export function isLazyIterForm(methodName: string, arity: number): boolean {
  return LAZY_ITER_METHODS.has(methodName) && arity >= 1;
}

/**
 * Lazily register (or fetch) the `$LazyIterHelper` GC struct type. One per
 * module, cached via `ctx.structMap`. Mirrors `getOrRegisterIterRecType`.
 */
function getOrRegisterLazyHelperType(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("$LazyIterHelper");
  if (existing !== undefined) return existing;
  const fields = [
    { name: "kind", type: { kind: "i32" as const }, mutable: false },
    { name: "src", type: { kind: "externref" as const }, mutable: false },
    { name: "fn", type: { kind: "externref" as const }, mutable: false },
    { name: "state", type: { kind: "f64" as const }, mutable: true },
    { name: "inner", type: { kind: "externref" as const }, mutable: true },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "$LazyIterHelper", fields });
  ctx.structMap.set("$LazyIterHelper", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "$LazyIterHelper");
  ctx.structFields.set("$LazyIterHelper", fields);
  return typeIdx;
}

interface LazyDeps {
  helperTypeIdx: number;
  openIdx: number;
  nextIdx: number;
  closeIdx: number;
  applyClosureIdx: number;
  boxNumIdx: number;
  unboxNumIdx: number;
  isTruthyIdx: number;
  objVecNewIdx: number;
  objVecPushIdx: number;
  arrayFromIterNIdx: number;
  iteratorIdx: number;
}

/** Gather (registering as needed) every dependency the lazy runtime needs.
 *  Returns undefined when a dep is unavailable (⇒ no native arm; legacy path). */
function gatherLazyDeps(ctx: CodegenContext): LazyDeps | undefined {
  if (!ctx.standalone) return undefined;
  ensureObjectRuntime(ctx);
  addUnionImportsViaRegistry(ctx);
  ensureNativeIteratorRuntime(ctx);
  // (#2903 R3) Register the bulk-drain helper so `Array.from(lazyWrapper)` /
  // spread (which route through `__iterator_rest`) have it available; the
  // `__iterator_rest` lazy arm delegates to it, and the finalize rebuild admits
  // `$LazyIterHelper` to its drain guard.
  const arrayFromIterNIdx = ensureNativeArrayFromIterN(ctx);
  reserveApplyClosure(ctx);
  const steppers = reserveIterHofSteppers(ctx);
  if (steppers === undefined) return undefined;
  const helperTypeIdx = getOrRegisterLazyHelperType(ctx);
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const iteratorIdx = ctx.funcMap.get("__iterator");
  if (
    applyClosureIdx === undefined ||
    boxNumIdx === undefined ||
    unboxNumIdx === undefined ||
    isTruthyIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    iteratorIdx === undefined
  ) {
    return undefined;
  }
  return {
    helperTypeIdx,
    openIdx: steppers.openIdx,
    nextIdx: steppers.nextIdx,
    closeIdx: steppers.closeIdx,
    applyClosureIdx,
    boxNumIdx,
    unboxNumIdx,
    isTruthyIdx,
    objVecNewIdx,
    objVecPushIdx,
    arrayFromIterNIdx,
    iteratorIdx,
  };
}

/**
 * Emit (or fetch) the native lazy-helper constructor `__iter_lazy_<methodName>`
 * plus the shared `__lazy_iter_step` / `__lazy_iter_close` steppers. Returns the
 * constructor funcIdx, or undefined when unavailable. Append-only — safe at
 * reserve time.
 */
export function ensureNativeLazyIter(ctx: CodegenContext, methodName: string): number | undefined {
  if (!LAZY_ITER_METHODS.has(methodName)) return undefined;
  const ctorName = `__iter_lazy_${methodName}`;
  const existing = ctx.funcMap.get(ctorName);
  if (existing !== undefined) return existing;

  const deps = gatherLazyDeps(ctx);
  if (deps === undefined) return undefined;

  ensureLazyStepper(ctx, deps);
  return emitLazyConstructor(ctx, methodName, deps);
}

/** Reserve the shared `__lazy_iter_step` / `__lazy_iter_close`. Idempotent. */
function ensureLazyStepper(ctx: CodegenContext, deps: LazyDeps): void {
  if (ctx.funcMap.get("__lazy_iter_step") !== undefined) return;
  const {
    helperTypeIdx,
    nextIdx,
    closeIdx,
    applyClosureIdx,
    boxNumIdx,
    isTruthyIdx,
    objVecNewIdx,
    objVecPushIdx,
    iteratorIdx,
  } = deps;

  // Locals: 0 param (externref), 1 helperAny (anyref), 2 src, 3 kind (i32),
  // 4 st (f64), 5 done (i32), 6 val, 7 args, 8 res, 9 inner (flatMap).
  const P = 0;
  const HANY = 1;
  const SRC = 2;
  const KIND_L = 3;
  const ST = 4;
  const DONE = 5;
  const VAL = 6;
  const ARGS = 7;
  const RES = 8;
  const INNER = 9;

  const cast = (): Instr[] => [
    { op: "local.get", index: HANY },
    { op: "ref.cast", typeIdx: helperTypeIdx },
  ];
  const doneReturn: Instr[] = [{ op: "i32.const", value: 1 }, { op: "ref.null.extern" }, { op: "return" }];
  // (done, val) = __iter_hof_next(src); if done → return (done, null).
  const pullStep: Instr[] = [
    { op: "local.get", index: SRC },
    { op: "call", funcIdx: nextIdx },
    { op: "local.set", index: VAL },
    { op: "local.set", index: DONE },
    { op: "local.get", index: DONE },
    { op: "if", blockType: { kind: "empty" }, then: doneReturn },
  ];
  // args = [val, box(st)].
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: ARGS },
    { op: "local.get", index: ARGS },
    { op: "local.get", index: VAL },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: ARGS },
    { op: "local.get", index: ST },
    { op: "call", funcIdx: boxNumIdx },
    { op: "call", funcIdx: objVecPushIdx },
  ];
  // res = __apply_closure(helper.fn, undefined, args).
  const invoke: Instr[] = [
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_FN },
    { op: "ref.null.extern" },
    { op: "local.get", index: ARGS },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "local.set", index: RES },
  ];
  // st += 1; persist to struct.
  const bumpCounter: Instr[] = [
    { op: "local.get", index: ST },
    { op: "f64.const", value: 1 },
    { op: "f64.add" },
    { op: "local.set", index: ST },
    ...cast(),
    { op: "local.get", index: ST },
    { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_STATE },
  ];

  const mapArm: Instr[] = [
    ...pullStep,
    ...buildArgs,
    ...invoke,
    ...bumpCounter,
    { op: "i32.const", value: 0 },
    { op: "local.get", index: RES },
    { op: "return" },
  ];

  const filterArm: Instr[] = [
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        ...pullStep,
        ...buildArgs,
        ...invoke,
        ...bumpCounter,
        { op: "local.get", index: RES },
        { op: "call", funcIdx: isTruthyIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 }, { op: "local.get", index: VAL }, { op: "return" }],
        },
        { op: "br", depth: 0 },
      ],
    },
  ];

  const takeArm: Instr[] = [
    // st <= 0 ⇒ IteratorClose(src) + done.
    { op: "local.get", index: ST },
    { op: "f64.const", value: 0 },
    { op: "f64.le" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: SRC }, { op: "call", funcIdx: closeIdx }, ...doneReturn],
    },
    ...pullStep,
    // st -= 1; persist.
    ...cast(),
    { op: "local.get", index: ST },
    { op: "f64.const", value: 1 },
    { op: "f64.sub" },
    { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_STATE },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: VAL },
    { op: "return" },
  ];

  const dropArm: Instr[] = [
    // Skip `st` elements (once — state persists, so re-entry after yielding
    // sees st==0 and skips the block).
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: ST },
            { op: "f64.const", value: 0 },
            { op: "f64.le" },
            { op: "br_if", depth: 1 }, // done skipping → exit block
            ...pullStep,
            // st -= 1; persist.
            { op: "local.get", index: ST },
            { op: "f64.const", value: 1 },
            { op: "f64.sub" },
            { op: "local.set", index: ST },
            ...cast(),
            { op: "local.get", index: ST },
            { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_STATE },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...pullStep,
    { op: "i32.const", value: 0 },
    { op: "local.get", index: VAL },
    { op: "return" },
  ];

  // flatMap (§27.1.4.6): drain the current `inner` iterator fully before pulling
  // the next outer value, whose `mapper(v, counter)` result is opened into a new
  // `inner`. `inner` persists in the struct across steps. A non-iterable mapper
  // result opens to null ⇒ SKIPPED (no-throw discipline; spec is a TypeError).
  const flatMapArm: Instr[] = [
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        // inner = helper.inner
        ...cast(),
        { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_INNER },
        { op: "local.set", index: INNER },
        // if inner != null: try to step it
        { op: "local.get", index: INNER },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: INNER },
            { op: "call", funcIdx: nextIdx },
            { op: "local.set", index: VAL },
            { op: "local.set", index: DONE },
            // inner yielded → return (0, val)
            { op: "local.get", index: DONE },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "local.get", index: VAL }, { op: "return" }],
            },
            // inner exhausted → clear it
            ...cast(),
            { op: "ref.null.extern" },
            { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_INNER },
          ],
        },
        // pull next outer value
        ...pullStep,
        // res = mapper(val, counter); counter++
        ...buildArgs,
        ...invoke,
        ...bumpCounter,
        // helper.inner = __iterator(res) — GetIterator over the mapper result.
        // The full ladder (unlike `__iter_hof_open`) normalizes typed vecs /
        // $ObjVec / arrays via the #3100 vec-family arms AND drives generators,
        // closed iterables, and (via the R3 prepend) nested lazy wrappers. A
        // non-null non-iterable result traps (§27.1.4.6 step 6.b is a TypeError;
        // the trap is our no-throw-boundary approximation — the mapper is
        // required to return an iterable).
        ...cast(),
        { op: "local.get", index: RES },
        { op: "call", funcIdx: iteratorIdx },
        { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_INNER },
        // loop to drain the freshly-opened inner
        { op: "br", depth: 0 },
      ],
    },
  ];

  const stepBody: Instr[] = [
    { op: "local.get", index: P },
    { op: "any.convert_extern" },
    { op: "local.set", index: HANY },
    // src = helper.src
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_SRC },
    { op: "local.set", index: SRC },
    // null source ⇒ empty iterator.
    { op: "local.get", index: SRC },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: doneReturn },
    // kind / st
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_KIND },
    { op: "local.set", index: KIND_L },
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_STATE },
    { op: "local.set", index: ST },
    // if kind==map
    { op: "local.get", index: KIND_L },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: mapArm },
    // if kind==filter
    { op: "local.get", index: KIND_L },
    { op: "i32.const", value: 1 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: filterArm },
    // if kind==take
    { op: "local.get", index: KIND_L },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: takeArm },
    // if kind==drop
    { op: "local.get", index: KIND_L },
    { op: "i32.const", value: 3 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: dropArm },
    // if kind==flatMap
    { op: "local.get", index: KIND_L },
    { op: "i32.const", value: 4 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: flatMapArm },
    // fallthrough: unknown kind ⇒ done.
    ...doneReturn,
  ];

  const stepTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }, { kind: "externref" }]);
  const stepIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__lazy_iter_step", stepIdx);
  pushDefinedFunc(ctx, stepIdx, {
    name: "__lazy_iter_step",
    typeIdx: stepTypeIdx,
    locals: [
      { name: "helperAny", type: { kind: "anyref" } },
      { name: "src", type: { kind: "externref" } },
      { name: "kind", type: { kind: "i32" } },
      { name: "st", type: { kind: "f64" } },
      { name: "done", type: { kind: "i32" } },
      { name: "val", type: { kind: "externref" } },
      { name: "args", type: { kind: "externref" } },
      { name: "res", type: { kind: "externref" } },
      { name: "inner", type: { kind: "externref" } },
    ],
    body: stepBody,
    exported: false,
  });

  // __lazy_iter_close(helperExt) → IteratorClose(src) when non-null.
  const closeBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: helperTypeIdx },
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_SRC },
    { op: "local.set", index: 1 },
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: closeIdx },
      ],
    },
  ];
  const closeTypeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  const lazyCloseIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__lazy_iter_close", lazyCloseIdx);
  pushDefinedFunc(ctx, lazyCloseIdx, {
    name: "__lazy_iter_close",
    typeIdx: closeTypeIdx,
    locals: [{ name: "src", type: { kind: "externref" } }],
    body: closeBody,
    exported: false,
  });
}

/** Emit `__iter_lazy_<methodName>(recv, arg) -> externref`. */
function emitLazyConstructor(ctx: CodegenContext, methodName: string, deps: LazyDeps): number {
  const { helperTypeIdx, openIdx, unboxNumIdx } = deps;
  const kind = KIND[methodName];
  const isCount = methodName === "take" || methodName === "drop";
  const ctorName = `__iter_lazy_${methodName}`;

  // Locals: 0 recv, 1 arg, 2 src (externref), 3 cnt (f64).
  const body: Instr[] = [
    // src = __iter_hof_open(recv)
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: openIdx },
    { op: "local.set", index: 2 },
  ];
  if (isCount) {
    // cnt = floor(ToNumber(arg)); clamp NaN/negative → 0.
    body.push(
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: unboxNumIdx },
      { op: "f64.floor" },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "f64.const", value: 0 },
      { op: "f64.lt" },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 3 },
      { op: "f64.ne" }, // NaN
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "f64.const", value: 0 },
          { op: "local.set", index: 3 },
        ],
      },
    );
  }
  // struct.new $LazyIterHelper { kind, src, fn, state, inner:null }
  body.push(
    { op: "i32.const", value: kind }, // kind
    { op: "local.get", index: 2 }, // src
    isCount ? { op: "ref.null.extern" } : { op: "local.get", index: 1 }, // fn
    isCount ? { op: "local.get", index: 3 } : { op: "f64.const", value: 0 }, // state
    { op: "ref.null.extern" }, // inner
    { op: "struct.new", typeIdx: helperTypeIdx },
    { op: "extern.convert_any" },
  );

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(ctorName, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: ctorName,
    typeIdx,
    locals: [
      { name: "src", type: { kind: "externref" } },
      { name: "cnt", type: { kind: "f64" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * FINALIZE fill: prepend a `$LazyIterHelper` recognition arm to the GetIterator
 * ladder bodies (`__iterator` / `__iterator_next` / `__iterator_return`) so
 * `Array.from(...)`, spread, and `for…of` drive a lazy wrapper natively. A
 * wrapper is its OWN iterator: `__iterator` returns it unchanged, `_next`
 * delegates to `__lazy_iter_step`, `_return` to `__lazy_iter_close`. No-op when
 * the module built no lazy wrapper. Must run AFTER `fillNativeIteratorLateArms`
 * (which rebuilds those bodies) in the index.ts finalize sequence.
 */
export function fillLazyIterLadderArms(ctx: CodegenContext): void {
  const helperTypeIdx = ctx.structMap.get("$LazyIterHelper");
  const stepIdx = ctx.funcMap.get("__lazy_iter_step");
  const closeIdx = ctx.funcMap.get("__lazy_iter_close");
  if (helperTypeIdx === undefined || stepIdx === undefined || closeIdx === undefined) return;

  // FRESH instr objects per prepend (#2169b / shared-instr double-remap hazard):
  // one `Instr` object aliased into multiple function bodies is remapped at most
  // once by the DCE type-remap's WeakSet guard, desyncing the others — the
  // `ref.test $LazyIterHelper` embedded in `__iterator`/`_next`/`_return` MUST be
  // three distinct objects. Each `prepend` builds its own.
  const prepend = (funcName: string, thenBody: Instr[]): void => {
    const idx = ctx.funcMap.get(funcName);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.body = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: helperTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: thenBody },
      ...fn.body,
    ];
  };

  // __iterator(obj) → obj (the wrapper is its own iterator).
  prepend("__iterator", [{ op: "local.get", index: 0 }, { op: "return" }]);
  // __iterator_next(rec) → __lazy_iter_step(rec) (multivalue i32,externref).
  prepend("__iterator_next", [{ op: "local.get", index: 0 }, { op: "call", funcIdx: stepIdx }, { op: "return" }]);
  // __iterator_return(rec) → __lazy_iter_close(rec).
  prepend("__iterator_return", [{ op: "local.get", index: 0 }, { op: "call", funcIdx: closeIdx }, { op: "return" }]);
  // __iterator_rest(rec) → __array_from_iter_n(rec, -1) — the bulk drain used by
  // `Array.from(...)` / `[...wrapper]`. `__iterator_rest`'s vec body would hard-
  // cast the wrapper to `$IterRec`; delegate to the element-wise drainer (which
  // admits `$LazyIterHelper` and drives it via the ladder prepends above).
  const afinIdx = ctx.funcMap.get("__array_from_iter_n");
  if (afinIdx !== undefined) {
    prepend("__iterator_rest", [
      { op: "local.get", index: 0 },
      { op: "f64.const", value: -1 },
      { op: "call", funcIdx: afinIdx },
      { op: "return" },
    ]);
  }
}
