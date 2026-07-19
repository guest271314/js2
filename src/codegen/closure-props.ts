// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3468 C-core) Closure-own-property side table for `--target standalone`.
 *
 * ## The gap
 * Function objects (closures) are WasmGC structs, NOT `$Object`s, so the three
 * terminal dynamic-property helpers in `object-runtime.ts` — `__extern_set`,
 * `__extern_get`, `__extern_method_call` — all gate on `ref.test $Object(recv)`
 * and fall through to a no-op / undefined / `ref.null.extern` for a closure
 * receiver. Consequence: `f.p = v`, `f.p`, and `f.m()` are silently dropped for
 * a function value. That is why the test262 `assert` harness (a `function
 * assert(){}` whose `sameValue`/`throws`/`_isSameValue` are assigned as own
 * properties) never invokes anything under standalone — assertions become
 * vacuous passes (#3468 root cause).
 *
 * ## The fix (Approach C-core)
 * Keep closures as-is and give those three dead arms a fallback: a runtime,
 * closure-identity-keyed side table mapping each property-carrying closure to a
 * fresh `$Object` "bag" that holds its own properties. The bag reuses the
 * existing `$Object` prop machinery (`__new_plain_object` + `__extern_get`/
 * `__extern_set`), so reads/writes/method-calls on a function value work exactly
 * as they do on a plain object.
 *
 * The table is a singly-linked list of `$ClosurePropEntry { next; key; bag }`
 * rooted at the module global `$__closure_prop_head`. Append = prepend (O(1));
 * lookup = walk with `ref.eq` on the closure identity. The tiny count of
 * property-carrying closures makes a list cheaper than a copy-on-grow array.
 *
 * ## Why reserve-then-fill (the funcIdx / type-completeness ordering problem)
 * The helper bodies self-call `__extern_get`/`__extern_set` on the bag, but a
 * function's own funcIdx is NOT in `funcMap` while its body is being built
 * (`registerNative` mints at registration time, after the body array is
 * constructed) — and `__is_closure_internal`'s `ref.test` chain needs the
 * COMPLETE closure base-wrapper type set, which is only known at FINALIZE
 * (`collectClosureBaseWrapperTypeIdxs`). So, exactly like `reserveApplyClosure`/
 * `fillApplyClosure` (#1888) and the accessor drivers (#1719): reserve the five
 * helper funcIdxs with `unreachable` stubs at object-runtime-emit time (so the
 * `__extern_*` arms bake a stable `call <idx>`), then fill the real bodies in
 * post-processing. Routing every reference through `funcMap` keeps the
 * late-import index shifter (#329/#1899) in sync.
 *
 * ## Byte-neutrality
 * Everything here is gated on `ctx.standalone || ctx.wasi`. In gc/host mode the
 * `env::__extern_*` host imports own the dynamic-property path — the defined
 * `__extern_*` bodies (and therefore these helpers) are never emitted — so the
 * gc/host output stays byte-identical.
 *
 * ## No throws (S1 discipline)
 * C-core is deliberately throw-free (like `__apply_closure` S1) so it pulls no
 * late error machinery (`__new_TypeError` + exn tag + string constants) into the
 * object runtime, avoiding the #1839/#117/#1886 late-registration index-shift
 * trap.
 */
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** WasmGC `eq` abstract heap type (used for `ref.cast`/`ref.null` to eqref). */
const EQ_HEAP_TYPE = -19;

/** Reserved helper names (all internal, non-exported). */
export const IS_CLOSURE_INTERNAL = "__is_closure_internal";
export const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
export const CLOSURE_BAG_ENSURE = "__closure_bag_ensure";
export const CLOSURE_PROP_GET = "__closure_prop_get";
export const CLOSURE_PROP_SET = "__closure_prop_set";

/** $ClosurePropEntry field indices. */
const F_NEXT = 0;
const F_KEY = 1;
const F_BAG = 2;

/**
 * Register the `$ClosurePropEntry` struct type + `$__closure_prop_head` global
 * and reserve the five closure-own-property helper placeholders. Called from
 * `ensureObjectRuntime`'s type section under `ctx.standalone || ctx.wasi`,
 * BEFORE the `__extern_get`/`__extern_set`/`__extern_method_call` bodies bake
 * their `call <idx>`. Idempotent (guards on `ctx.closurePropHelpersReserved`).
 *
 * The struct type is appended at `ctx.mod.types.length`, so it never shifts an
 * existing type index. The five func placeholders are appended at the current
 * end of the function space, so they never shift an existing funcIdx either.
 */
export function reserveClosurePropHelpers(ctx: CodegenContext): void {
  if (ctx.closurePropHelpersReserved) return;

  // --- $ClosurePropEntry struct: { next: (ref null self); key: eqref; bag: externref } ---
  const entryTypeIdx = ctx.mod.types.length;
  const entryFields: FieldDef[] = [
    // next — immutable; a prepend creates a NEW head whose next = old head, so
    // existing entries' `next` never changes (no struct.set anywhere).
    { name: "next", type: { kind: "ref_null", typeIdx: entryTypeIdx }, mutable: false },
    // key — the closure identity, narrowed to eqref via `ref.cast eq`. Compared
    // with `ref.eq` at lookup. Same struct ref at set-site and get-site ⇒ match.
    { name: "key", type: { kind: "eqref" }, mutable: false },
    // bag — the per-closure own-property `$Object`, wrapped to externref.
    { name: "bag", type: { kind: "externref" }, mutable: false },
  ];
  ctx.mod.types.push({ kind: "struct", name: "$ClosurePropEntry", fields: entryFields });
  ctx.closurePropEntryTypeIdx = entryTypeIdx;

  // --- $__closure_prop_head : (mut ref null $ClosurePropEntry) = ref.null ---
  const headGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "$__closure_prop_head",
    type: { kind: "ref_null", typeIdx: entryTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: entryTypeIdx }],
  });
  ctx.closurePropHeadGlobalIdx = headGlobalIdx;

  // --- Reserve the five helper placeholders (filled by fillClosurePropHelpers) ---
  const reserve = (name: string, params: ValType[], results: ValType[]): void => {
    if (ctx.funcMap.get(name) !== undefined) return;
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = {
      name,
      typeIdx,
      locals: [],
      // Placeholder; filled at FINALIZE. A bare `unreachable` is a valid stub for
      // any result type if the fill is ever skipped.
      body: [{ op: "unreachable" }],
      exported: false,
    };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
  };

  const externref: ValType = { kind: "externref" };
  reserve(IS_CLOSURE_INTERNAL, [externref], [{ kind: "i32" }]);
  reserve(CLOSURE_BAG_LOOKUP, [externref], [externref]);
  reserve(CLOSURE_BAG_ENSURE, [externref], [externref]);
  reserve(CLOSURE_PROP_GET, [externref, externref], [externref]);
  reserve(CLOSURE_PROP_SET, [externref, externref, externref], []);

  ctx.closurePropHelpersReserved = true;
}

/**
 * Fill the five reserved closure-own-property helper bodies at FINALIZE, after
 * every closure root is registered and `__extern_get`/`__extern_set`/
 * `__new_plain_object` are in `funcMap`. No-op when the helpers were never
 * reserved (gc/host mode). Mirrors `fillApplyClosure`.
 */
export function fillClosurePropHelpers(ctx: CodegenContext): void {
  if (!ctx.closurePropHelpersReserved) return;

  const entryTypeIdx = ctx.closurePropEntryTypeIdx;
  const headGlobalIdx = ctx.closurePropHeadGlobalIdx;
  if (entryTypeIdx === undefined || headGlobalIdx === undefined) return;

  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_INTERNAL);
  const bagLookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const bagEnsureIdx = ctx.funcMap.get(CLOSURE_BAG_ENSURE);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");

  const setBody = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };

  // The undefined-read sentinel, matching `__extern_get`'s `getMiss()` factory
  // (a fresh array each call — shared Instr objects get double-remapped by
  // finalize walks; see reference_shared_instr_object_dce_double_remap).
  const getMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];

  // ── __is_closure_internal(externref value) -> i32 ──
  // ref.test chain over the closure base-wrapper types (same shape as
  // emitIsClosureExport). Constant 0 when the module has no closures.
  {
    const baseTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 }, // __any
    ];
    for (const baseIdx of baseTypeIdxs) {
      body.push({ op: "local.get", index: 1 });
      body.push({ op: "ref.test", typeIdx: baseIdx });
      body.push({ op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] });
    }
    body.push({ op: "i32.const", value: 0 });
    setBody(IS_CLOSURE_INTERNAL, [{ name: "__any", type: { kind: "anyref" } }], body);
  }

  // ── __closure_bag_lookup(externref recv) -> externref ──
  // Walk the list; on `ref.eq(entry.key, recv-as-eqref)` return entry.bag; on
  // end-of-list return the undefined externref. Read-only (never creates).
  // Locals: 1 = recvEq (eqref), 2 = cur (ref null $ClosurePropEntry).
  const walkLocals: { name: string; type: ValType }[] = [
    { name: "__recvEq", type: { kind: "eqref" } },
    { name: "__cur", type: { kind: "ref_null", typeIdx: entryTypeIdx } },
  ];
  // Inside the loop body: depth 0 = the `loop`, depth 1 = the enclosing `block`.
  const walkLoop = (onHit: Instr[]): Instr => ({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: 2 },
          { op: "ref.is_null" },
          { op: "br_if", depth: 1 }, // cur == null → exit block
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_KEY },
          { op: "local.get", index: 1 }, // recvEq
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: onHit },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_NEXT },
          { op: "local.set", index: 2 },
          { op: "br", depth: 0 }, // continue loop
        ],
      },
    ],
  });
  const narrowRecvToEq: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: EQ_HEAP_TYPE }, // recv is a closure struct ⇒ safe
    { op: "local.set", index: 1 },
    { op: "global.get", index: headGlobalIdx },
    { op: "local.set", index: 2 },
  ];
  {
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    const body: Instr[] = [...narrowRecvToEq, walkLoop(onHit), { op: "ref.null.extern" }];
    setBody(CLOSURE_BAG_LOOKUP, walkLocals, body);
  }

  // ── __closure_bag_ensure(externref recv) -> externref ──
  // As lookup; on miss allocate a fresh `$Object` bag, prepend a new entry,
  // update the head, and return the bag. Locals: 1 = recvEq, 2 = cur, 3 = bag.
  if (newPlainObjectIdx !== undefined) {
    const ensureLocals: { name: string; type: ValType }[] = [
      ...walkLocals,
      { name: "__bag", type: { kind: "externref" } },
    ];
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    const body: Instr[] = [
      ...narrowRecvToEq,
      walkLoop(onHit),
      // miss: bag = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 3 },
      // head = struct.new $ClosurePropEntry { next: head, key: recvEq, bag: bag }
      { op: "global.get", index: headGlobalIdx }, // next
      { op: "local.get", index: 1 }, // key (recvEq)
      { op: "local.get", index: 3 }, // bag
      { op: "struct.new", typeIdx: entryTypeIdx },
      { op: "global.set", index: headGlobalIdx },
      { op: "local.get", index: 3 }, // return bag
    ];
    setBody(CLOSURE_BAG_ENSURE, ensureLocals, body);
  }

  // ── __closure_prop_get(externref obj, externref key) -> externref ──
  // if is_closure(obj) { bag = lookup(obj); if bag != null return __extern_get(bag,key) }
  // ; return getMiss()  (the same undefined-read sentinel __extern_get uses)
  if (isClosureIdx !== undefined && bagLookupIdx !== undefined && externGetIdx !== undefined) {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosureIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: bagLookupIdx },
          { op: "local.tee", index: 2 }, // bag
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 2 }, // bag
              { op: "local.get", index: 1 }, // key
              { op: "call", funcIdx: externGetIdx },
              { op: "return" },
            ],
          },
        ],
      },
      ...getMiss(),
    ];
    setBody(CLOSURE_PROP_GET, [{ name: "__bag", type: { kind: "externref" } }], body);
  } else {
    // Deps absent — keep a valid body: always return the undefined sentinel.
    setBody(CLOSURE_PROP_GET, [], [...getMiss()]);
  }

  // ── __closure_prop_set(externref obj, externref key, externref value) -> () ──
  // if is_closure(obj) { bag = ensure(obj); __extern_set(bag, key, value) }
  if (isClosureIdx !== undefined && bagEnsureIdx !== undefined && externSetIdx !== undefined) {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosureIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: bagEnsureIdx }, // -> bag externref
          { op: "local.get", index: 1 }, // key
          { op: "local.get", index: 2 }, // value
          { op: "call", funcIdx: externSetIdx }, // __extern_set(bag,key,value) -> ()
        ],
      },
    ];
    setBody(CLOSURE_PROP_SET, [], body);
  } else {
    // Deps absent — keep a valid empty body (void result).
    setBody(CLOSURE_PROP_SET, [], []);
  }
}
