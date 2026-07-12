// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2903 R3 — native standalone LAZY Iterator-helper wrappers for dynamic
 * (`any`/externref) iterator receivers: `%Iterator.prototype%.map / filter /
 * take / drop` (ES2025 §27.1.4.2/.3/.4/.5). Sub-front 2 (iter-hof-native.ts)
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
 * (`inner` is reserved for a future flatMap slice — unused here.)
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
export const LAZY_ITER_METHODS: ReadonlySet<string> = new Set(["map", "filter", "take", "drop"]);

/** `state` semantics differ by kind (see module header). */
const KIND: Record<string, number> = { map: 0, filter: 1, take: 2, drop: 3 };

/** Field indices of `$LazyIterHelper` — load-bearing order. */
const F_KIND = 0;
const F_SRC = 1;
const F_FN = 2;
const F_STATE = 3;
// const F_INNER = 4; // reserved for flatMap

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
  ensureNativeArrayFromIterN(ctx);
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
  if (
    applyClosureIdx === undefined ||
    boxNumIdx === undefined ||
    unboxNumIdx === undefined ||
    isTruthyIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined
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
  const { helperTypeIdx, nextIdx, closeIdx, applyClosureIdx, boxNumIdx, isTruthyIdx, objVecNewIdx, objVecPushIdx } =
    deps;

  // Locals: 0 param (externref), 1 helperAny (anyref), 2 src, 3 kind (i32),
  // 4 st (f64), 5 done (i32), 6 val, 7 args, 8 res.
  const P = 0;
  const HANY = 1;
  const SRC = 2;
  const KIND_L = 3;
  const ST = 4;
  const DONE = 5;
  const VAL = 6;
  const ARGS = 7;
  const RES = 8;

  const cast = (): Instr[] => [
    { op: "local.get", index: HANY } as Instr,
    { op: "ref.cast", typeIdx: helperTypeIdx } as Instr,
  ];
  const doneReturn: Instr[] = [
    { op: "i32.const", value: 1 } as Instr,
    { op: "ref.null.extern" } as Instr,
    { op: "return" } as Instr,
  ];
  // (done, val) = __iter_hof_next(src); if done → return (done, null).
  const pullStep: Instr[] = [
    { op: "local.get", index: SRC } as Instr,
    { op: "call", funcIdx: nextIdx } as Instr,
    { op: "local.set", index: VAL } as Instr,
    { op: "local.set", index: DONE } as Instr,
    { op: "local.get", index: DONE } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: doneReturn } as Instr,
  ];
  // args = [val, box(st)].
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx } as Instr,
    { op: "local.set", index: ARGS } as Instr,
    { op: "local.get", index: ARGS } as Instr,
    { op: "local.get", index: VAL } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
    { op: "local.get", index: ARGS } as Instr,
    { op: "local.get", index: ST } as Instr,
    { op: "call", funcIdx: boxNumIdx } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
  ];
  // res = __apply_closure(helper.fn, undefined, args).
  const invoke: Instr[] = [
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_FN } as Instr,
    { op: "ref.null.extern" } as Instr,
    { op: "local.get", index: ARGS } as Instr,
    { op: "call", funcIdx: applyClosureIdx } as Instr,
    { op: "local.set", index: RES } as Instr,
  ];
  // st += 1; persist to struct.
  const bumpCounter: Instr[] = [
    { op: "local.get", index: ST } as Instr,
    { op: "f64.const", value: 1 } as Instr,
    { op: "f64.add" } as Instr,
    { op: "local.set", index: ST } as Instr,
    ...cast(),
    { op: "local.get", index: ST } as Instr,
    { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_STATE } as Instr,
  ];

  const mapArm: Instr[] = [
    ...pullStep,
    ...buildArgs,
    ...invoke,
    ...bumpCounter,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: RES } as Instr,
    { op: "return" } as Instr,
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
        { op: "local.get", index: RES } as Instr,
        { op: "call", funcIdx: isTruthyIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.get", index: VAL } as Instr,
            { op: "return" } as Instr,
          ],
        } as Instr,
        { op: "br", depth: 0 } as Instr,
      ],
    } as Instr,
  ];

  const takeArm: Instr[] = [
    // st <= 0 ⇒ IteratorClose(src) + done.
    { op: "local.get", index: ST } as Instr,
    { op: "f64.const", value: 0 } as Instr,
    { op: "f64.le" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: SRC } as Instr, { op: "call", funcIdx: closeIdx } as Instr, ...doneReturn],
    } as Instr,
    ...pullStep,
    // st -= 1; persist.
    ...cast(),
    { op: "local.get", index: ST } as Instr,
    { op: "f64.const", value: 1 } as Instr,
    { op: "f64.sub" } as Instr,
    { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_STATE } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: VAL } as Instr,
    { op: "return" } as Instr,
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
            { op: "local.get", index: ST } as Instr,
            { op: "f64.const", value: 0 } as Instr,
            { op: "f64.le" } as Instr,
            { op: "br_if", depth: 1 } as Instr, // done skipping → exit block
            ...pullStep,
            // st -= 1; persist.
            { op: "local.get", index: ST } as Instr,
            { op: "f64.const", value: 1 } as Instr,
            { op: "f64.sub" } as Instr,
            { op: "local.set", index: ST } as Instr,
            ...cast(),
            { op: "local.get", index: ST } as Instr,
            { op: "struct.set", typeIdx: helperTypeIdx, fieldIdx: F_STATE } as Instr,
            { op: "br", depth: 0 } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
    ...pullStep,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: VAL } as Instr,
    { op: "return" } as Instr,
  ];

  const stepBody: Instr[] = [
    { op: "local.get", index: P } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "local.set", index: HANY } as Instr,
    // src = helper.src
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_SRC } as Instr,
    { op: "local.set", index: SRC } as Instr,
    // null source ⇒ empty iterator.
    { op: "local.get", index: SRC } as Instr,
    { op: "ref.is_null" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: doneReturn } as Instr,
    // kind / st
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_KIND } as Instr,
    { op: "local.set", index: KIND_L } as Instr,
    ...cast(),
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_STATE } as Instr,
    { op: "local.set", index: ST } as Instr,
    // if kind==map
    { op: "local.get", index: KIND_L } as Instr,
    { op: "i32.eqz" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: mapArm } as Instr,
    // if kind==filter
    { op: "local.get", index: KIND_L } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.eq" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: filterArm } as Instr,
    // if kind==take
    { op: "local.get", index: KIND_L } as Instr,
    { op: "i32.const", value: 2 } as Instr,
    { op: "i32.eq" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: takeArm } as Instr,
    // if kind==drop
    { op: "local.get", index: KIND_L } as Instr,
    { op: "i32.const", value: 3 } as Instr,
    { op: "i32.eq" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: dropArm } as Instr,
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
    ],
    body: stepBody,
    exported: false,
  });

  // __lazy_iter_close(helperExt) → IteratorClose(src) when non-null.
  const closeBody: Instr[] = [
    { op: "local.get", index: 0 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: helperTypeIdx } as Instr,
    { op: "struct.get", typeIdx: helperTypeIdx, fieldIdx: F_SRC } as Instr,
    { op: "local.set", index: 1 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "ref.is_null" } as Instr,
    { op: "i32.eqz" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 1 } as Instr, { op: "call", funcIdx: closeIdx } as Instr],
    } as Instr,
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
    { op: "local.get", index: 0 } as Instr,
    { op: "call", funcIdx: openIdx } as Instr,
    { op: "local.set", index: 2 } as Instr,
  ];
  if (isCount) {
    // cnt = floor(ToNumber(arg)); clamp NaN/negative → 0.
    body.push(
      { op: "local.get", index: 1 } as Instr,
      { op: "call", funcIdx: unboxNumIdx } as Instr,
      { op: "f64.floor" } as Instr,
      { op: "local.set", index: 3 } as Instr,
      { op: "local.get", index: 3 } as Instr,
      { op: "f64.const", value: 0 } as Instr,
      { op: "f64.lt" } as Instr,
      { op: "local.get", index: 3 } as Instr,
      { op: "local.get", index: 3 } as Instr,
      { op: "f64.ne" } as Instr, // NaN
      { op: "i32.or" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: 3 } as Instr],
      } as Instr,
    );
  }
  // struct.new $LazyIterHelper { kind, src, fn, state, inner:null }
  body.push(
    { op: "i32.const", value: kind } as Instr, // kind
    { op: "local.get", index: 2 } as Instr, // src
    isCount ? ({ op: "ref.null.extern" } as Instr) : ({ op: "local.get", index: 1 } as Instr), // fn
    isCount ? ({ op: "local.get", index: 3 } as Instr) : ({ op: "f64.const", value: 0 } as Instr), // state
    { op: "ref.null.extern" } as Instr, // inner
    { op: "struct.new", typeIdx: helperTypeIdx } as Instr,
    { op: "extern.convert_any" } as Instr,
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
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "ref.test", typeIdx: helperTypeIdx } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: thenBody } as Instr,
      ...fn.body,
    ];
  };

  // __iterator(obj) → obj (the wrapper is its own iterator).
  prepend("__iterator", [{ op: "local.get", index: 0 } as Instr, { op: "return" } as Instr]);
  // __iterator_next(rec) → __lazy_iter_step(rec) (multivalue i32,externref).
  prepend("__iterator_next", [
    { op: "local.get", index: 0 } as Instr,
    { op: "call", funcIdx: stepIdx } as Instr,
    { op: "return" } as Instr,
  ]);
  // __iterator_return(rec) → __lazy_iter_close(rec).
  prepend("__iterator_return", [
    { op: "local.get", index: 0 } as Instr,
    { op: "call", funcIdx: closeIdx } as Instr,
    { op: "return" } as Instr,
  ]);
  // __iterator_rest(rec) → __array_from_iter_n(rec, -1) — the bulk drain used by
  // `Array.from(...)` / `[...wrapper]`. `__iterator_rest`'s vec body would hard-
  // cast the wrapper to `$IterRec`; delegate to the element-wise drainer (which
  // admits `$LazyIterHelper` and drives it via the ladder prepends above).
  const afinIdx = ctx.funcMap.get("__array_from_iter_n");
  if (afinIdx !== undefined) {
    prepend("__iterator_rest", [
      { op: "local.get", index: 0 } as Instr,
      { op: "f64.const", value: -1 } as Instr,
      { op: "call", funcIdx: afinIdx } as Instr,
      { op: "return" } as Instr,
    ]);
  }
}
