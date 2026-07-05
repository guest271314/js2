// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2580 M0) Value-rep dynamic-read substrate — the runtime property-presence
// read primitives.
//
// The dense/typed WasmGC representation cannot model a *dynamic read*: reading a
// property (named or indexed) from a receiver whose true shape is only known at
// runtime — a plain `$Object`, an array-like object, a `$Vec`, a string, a boxed
// primitive, or `null`/`undefined`. The whole sprint-64 dynamic/sparse tail
// (#2001 S2/S3, #2573, #983d, the `Array.prototype.X.call(arrayLike, cb)` cluster)
// converges on this: each needs `HasProperty` / `Get` against an arbitrary heap
// value, which the typed `array.get` / vec-field-0 / static dispatch can't express.
//
// Two Wasm-native primitives, dispatched over the #1852 boxed `$AnyValue` family
// by its `tag` field (0 null · 1 undefined · 2 i32 · 3 f64 · 4 boolean ·
// 5 string/externref · 6 GC-ref → `$Object`/`$Vec`):
//
//   __dyn_has(recv: externref, key: externref) -> i32        (HasProperty, proto chain)
//   __dyn_get(recv: externref, key: externref) -> externref  (Get → externref / undefined)
//
// `.length` on an `any` receiver is just `__dyn_get(recv, "length")`; an absent
// index/property reads back as JS `undefined` (externref), NOT a numeric 0.
//
// **M0 is a 0-risk scaffold.** `ensureDynReadHelpers` is gated on
// `ctx.usesDynRead`, which **nothing sets in M0** (the first call site arrives in
// M1's `any`-receiver `.length`). So in M0 these helpers are never emitted and
// every module is byte-identical — the gate, not dead-elim, is what guarantees
// zero bytes / zero regression (an uncalled *defined* function is not
// import-pruned). M1 flips `ctx.usesDynRead` at its first call site and exercises
// the bodies; M2–M4 widen the call sites. The typed read path is forever
// untouched: only statically-`any`/dynamic receivers reach here.
//
// **Standalone parity.** Pure WasmGC + the existing `__extern_get` object-runtime
// helper (which already walks the prototype chain) + native-string indexing; the
// `undefined` result uses the existing `emitUndefined` convention (host
// `__get_undefined`, else `ref.null.extern`). No new host import.

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import {
  undefinedSingletonActive, // (#2106 S1)
  ensureAnyFromExternHelper, // (#3053 U0) settled honest classifier (CS1b)
  ensureAnyToExternHelper, // (#3053 U0) key marshalling
} from "./any-helpers.js";
import { ensureGetUndefined } from "./expressions/late-imports.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { allocLocal } from "./context/locals.js";
import { collectClosureBaseWrapperTypeIdxs as closureBaseWrapperTypeIdxs } from "./closure-classifier.js"; // (#2175 V2-S1) shared list

// `$AnyValue` tag constants (mirror any-helpers.ts box helpers).
const TAG_NULL = 0;
const TAG_UNDEFINED = 1;
// 2 = i32, 3 = f64, 4 = boolean — primitives, no own properties (besides length
// on strings, handled via tag 5). 5 = string/externref, 6 = GC ref.
const TAG_STRING = 5;
const TAG_REF = 6;
void TAG_NULL;
void TAG_UNDEFINED;
void TAG_STRING;

/**
 * Register the `__dyn_has` / `__dyn_get` runtime read primitives. Idempotent and
 * **gated on `ctx.usesDynRead`** — a no-op unless a call site (M1+) has flagged
 * that the module needs them, so M0 (no call sites) emits nothing.
 *
 * Call this in the finalize phase, after `ensureObjectRuntime`/`ensureAnyHelpers`
 * (the helpers reference `$AnyValue` + `__extern_get`). It must run before
 * dead-elim / late-import settle so the baked funcIdx values are stable.
 */
export function ensureDynReadHelpers(ctx: CodegenContext): void {
  // (#2580 M0) `JS2WASM_FORCE_DYN_READ=1` force-emits the helpers even with no
  // call site — the M0 self-test that the bodies are VALID Wasm (host +
  // standalone) before M1 wires real call sites. Off by default; never set in
  // production, so it cannot affect any normal/CI compile.
  if (process.env.JS2WASM_FORCE_DYN_READ === "1") ctx.usesDynRead = true;
  if (!ctx.usesDynRead) return; // M0 / dynamic-read-free modules: byte-identical.
  if (ctx.dynReadHelpersEmitted) return;
  ctx.dynReadHelpersEmitted = true;

  // The object arm delegates to `__extern_get` (named/indexed property read with
  // prototype-chain walk; returns `ref.null.extern` when absent). It MUST already
  // be registered by the program's normal compilation — a call site that sets
  // `ctx.usesDynRead` (M1+: an `any`-receiver read) naturally pulls in the object
  // runtime. We do NOT call `ensureObjectRuntime` here: this runs in the finalize
  // phase, and registering new STRUCT types this late desyncs the type index
  // space (the #2043 late-shift class). Adding only FUNC types via `addFuncType`
  // below is safe. If `__extern_get` is somehow absent, bail without emitting —
  // the call site keeps its prior lowering, no regression.
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) {
    ctx.dynReadHelpersEmitted = false;
    ctx.usesDynRead = false;
    return;
  }

  // `undefined` as externref: host `__get_undefined` when present, else the
  // standalone `ref.null.extern` convention.
  const getUndefIdx = ensureGetUndefined(ctx);
  const undefInstrs: Instr[] =
    getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx } as Instr] : [{ op: "ref.null.extern" } as Instr];
  // (#2106 S1) Under the `undefinedSingleton` regime `__extern_get` ALREADY
  // returns the singleton for an absent property, and a null result means a
  // STORED JS null — so `__dyn_get` must NOT remap null → undefined (that
  // would read `obj.x = null` back as undefined), and `__dyn_has`'s
  // "present ⇔ non-null" flips to "present ⇔ non-nullish". This runs at
  // FINALIZE: only consult ALREADY-reserved indices (no ensureAnyValueType —
  // registering struct types this late is the #2043 late-shift class).
  const s1DynRegime = undefinedSingletonActive(ctx) && ctx.undefinedGlobalIdx !== undefined;
  const s1IsNullishIdx = s1DynRegime ? ctx.funcMap.get("__extern_is_nullish") : undefined;

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };

  function addHelper(
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): void {
    if (ctx.funcMap.has(name)) return;
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false } as never);
    ctx.funcMap.set(name, funcIdx);
  }

  // Shared tag read: convert the externref receiver to anyref, test the boxed
  // `$AnyValue`, and leave the tag (i32) on the stack — or fall through to the
  // "raw" (non-boxed) cases. A receiver reaches here either already boxed
  // (`$AnyValue`) or as a raw `$Object`/`$Vec`/string ref; `__extern_get` handles
  // the raw object/vec case directly (it `any.convert_extern`s + casts), so the
  // object arm does not need the tag — it just calls `__extern_get`.

  // __dyn_get(recv, key) -> externref
  //   Get(recv, key): the value, or `undefined` when absent.
  //   Tag 6 (GC ref) / raw object/vec → __extern_get (returns null when absent →
  //     map null to `undefined`). Tags 0/1 (null/undefined) and 2/3/4 (primitives)
  //     → `undefined` (no own properties; string `.length`/index handled by the
  //     object/extern path's string arm where present). String tag 5 also routes
  //     through __extern_get, which has the native-string indexed/`.length` arm.
  //   The result is a UNIFORM externref — numeric values arrive boxed.
  addHelper(
    "__dyn_get",
    [externref, externref],
    [externref],
    s1DynRegime
      ? [
          // (#2106 S1) plain pass-through: __extern_get already answers the
          // singleton for absent, and null means a stored JS null.
          { op: "local.get", index: 0 } as Instr,
          { op: "local.get", index: 1 } as Instr,
          { op: "call", funcIdx: externGetIdx } as Instr,
        ]
      : [
          // val = __extern_get(recv, key)
          { op: "local.get", index: 0 } as Instr,
          { op: "local.get", index: 1 } as Instr,
          { op: "call", funcIdx: externGetIdx } as Instr,
          { op: "local.tee", index: 2 } as Instr,
          // if (val is null) return undefined  — §Get of an absent property is undefined
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: externref },
            then: undefInstrs,
            else: [{ op: "local.get", index: 2 } as Instr],
          } as Instr,
        ],
    [{ name: "__dg_val", type: externref }],
  );

  // __dyn_has(recv, key) -> i32
  //   HasProperty(recv, key) INCLUDING the prototype chain. Tag 6 / raw object/vec
  //   / string → 1 iff __extern_get returns non-null (it walks own + proto).
  //   Tags 0/1/2/3/4 → 0 (a primitive/null/undefined has no own indexable props
  //   here; string length/index presence rides the __extern_get string arm).
  //   NOTE: this conflates "present with value undefined" vs "absent" for the
  //   rare `obj.x === undefined` own-property case — refined in M2/M3 where the
  //   distinction matters (HasProperty proper vs Get); for M1's `.length` and the
  //   array-like cluster, non-null-Get ⇔ present is correct.
  addHelper(
    "__dyn_has",
    [externref, externref],
    [i32],
    s1IsNullishIdx !== undefined
      ? [
          // (#2106 S1) present ⇔ NOT nullish (absent = the undefined singleton).
          { op: "local.get", index: 0 } as Instr,
          { op: "local.get", index: 1 } as Instr,
          { op: "call", funcIdx: externGetIdx } as Instr,
          { op: "call", funcIdx: s1IsNullishIdx } as Instr,
          { op: "i32.eqz" } as Instr,
        ]
      : [
          { op: "local.get", index: 0 } as Instr,
          { op: "local.get", index: 1 } as Instr,
          { op: "call", funcIdx: externGetIdx } as Instr,
          { op: "ref.is_null" } as Instr,
          { op: "i32.eqz" } as Instr, // present ⇔ NOT null
        ],
  );

  // Reference the tag constant so a future refined tag-dispatch (M2/M3) keeps it;
  // the M0 form delegates to `__extern_get`, which tag-dispatches internally.
  void TAG_REF;
}

/**
 * (#2580 M1) Call-site helper: emit a `__dyn_get(recv, "<keyName>")` at a property
 * read site. The RECEIVER externref must already be on the stack; this pushes the
 * key string (externref) and the `call __dyn_get`, leaving the value externref
 * (the property, or `undefined` when absent) on the stack.
 *
 * Runs during BODY compilation (not finalize): it eagerly `ensureObjectRuntime`
 * (so `__extern_get` exists — safe to register its struct types here, the normal
 * path) and eagerly emits the dyn-read helpers (so `__dyn_get`'s funcIdx is known
 * for the `call` below). Sets `ctx.usesDynRead` so the finalize pass is a no-op
 * (the latch is already set). Returns true on success; false (no-op, receiver
 * left on stack) if the runtime is unavailable — the caller then keeps its prior
 * lowering.
 */
export function emitDynGet(ctx: CodegenContext, fctx: FunctionContext, keyName: string): boolean {
  if (ctx.standalone) {
    // STANDALONE: `__extern_get` is a DEFINED native helper inside the object
    // runtime (anyStrTypeIdx valid). Route through the `__dyn_get` wrapper so the
    // M0 helper's `$Vec`/`$Hole`/native-string arms apply (M2/M3 fill them in).
    // `usesDynRead` makes the finalize pass emit the wrapper helpers.
    ctx.usesDynRead = true;
    ensureObjectRuntime(ctx);
    ensureDynReadHelpers(ctx);
    addStringConstantGlobal(ctx, keyName);
    flushLateImportShifts(ctx, fctx);
    const dynGetIdx = ctx.funcMap.get("__dyn_get");
    if (dynGetIdx === undefined) return false;
    for (const instr of stringConstantExternrefInstrs(ctx, keyName)) fctx.body.push(instr);
    fctx.body.push({ op: "call", funcIdx: dynGetIdx } as Instr);
    return true;
  }
  // HOST mode: INLINE `__extern_get(recv, key)` directly — do NOT call the
  // defined `__dyn_get` wrapper. `__extern_get` is a JS host IMPORT (stable index
  // at the import section, kept in lockstep by the late-import shift), so baking
  // `call __extern_get` is shift-safe. The defined `__dyn_get`/`__dyn_has` helpers
  // are DEFINED functions whose indices FLOAT as later imports are added; baking
  // `call __dyn_get` mid-body and then having a value-consumer add an import
  // (`=== undefined` → `__extern_is_undefined`, arithmetic → `__unbox_number`)
  // shifts the defined-func index out from under the baked call, which then hits
  // the adjacent `__dyn_has` (the funcidx-ordering #2043 bug). Inlining the host
  // `__extern_get` sidesteps it entirely. In host mode `__extern_get(obj, key)`
  // already returns JS `undefined` for an absent property (the host `obj[key]`),
  // so no null→undefined remap is needed — the result is the spec `Get`.
  //
  // BUT: an `any`-typed receiver that holds a compiled ARRAY is an externref
  // wrapping a WasmGC vec struct. The host `__extern_get(vec, "length")` returns
  // `undefined` (V8 sees an opaque struct with no `.length` JS property), which
  // would WRONGLY shadow the real array length. So for the `.length` key we FIRST
  // dispatch on the runtime receiver kind via `ref.test` against the registered
  // vec types — a HIT reads vec struct field 0 (the length, i32) and boxes it to
  // an externref via `__box_number`; the MISS (genuine plain object / host value)
  // falls to `__extern_get`. `ref.test typeIdx` uses *type* indices, which are
  // append-only / dead-elim-stable (the rec-group), so unlike a `call __is_vec`
  // this carries NO funcidx-ordering hazard. Non-`length` keys skip the vec arm
  // (vec indexed reads are a later slice) and go straight to `__extern_get`.
  // Register BOTH imports up-front (before resolving any baked index): the
  // vec-aware `.length` arm boxes the i32 length to externref via `__box_number`,
  // and a late `__box_number` import added *after* `__extern_get`'s index was
  // baked would shift it. Ensure-then-flush-then-resolve keeps both stable.
  const externGetIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (externGetIdx === undefined) {
    flushLateImportShifts(ctx, fctx);
    return false;
  }
  // Only the `.length` key uses the vec arm; ensure `__box_number` for it, plus
  // `__extern_is_undefined` for the null/undefined-receiver guard (#2580 M2 s1).
  if (keyName === "length") {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    // (#2896) Builtin-fn metadata read for the closure arm (standalone only):
    // a builtin function value's `.length` is its spec arity, answered by the
    // finalize-filled `__builtinfn_get_meta` native instead of the flat 0.
    if (ctx.standalone) {
      ensureLateImport(
        ctx,
        "__builtinfn_get_meta",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
    }
  }
  addStringConstantGlobal(ctx, keyName);
  flushLateImportShifts(ctx, fctx);
  // Re-resolve by name AFTER all import shifts have settled.
  const finalExternGetIdx = ctx.funcMap.get("__extern_get") ?? externGetIdx;
  const boxNumIdx = keyName === "length" ? ctx.funcMap.get("__box_number") : undefined;
  const isUndefIdx = keyName === "length" ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  const vecEntries = Array.from(ctx.vecTypeMap.values());
  if (keyName === "length" && boxNumIdx !== undefined && vecEntries.length > 0) {
    // Stash the receiver externref (currently on the stack) so we can test it.
    const recvTmp = allocLocal(fctx, `__dg_recv_${fctx.locals.length}`, { kind: "externref" });
    const anyTmp = allocLocal(fctx, `__dg_any_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: recvTmp } as Instr);
    fctx.body.push({ op: "local.get", index: recvTmp } as Instr);
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "local.set", index: anyTmp } as Instr);

    // The MISS branch: __extern_get(recv, "length") → value-or-undefined externref.
    let chain: Instr[] = [
      { op: "local.get", index: recvTmp } as Instr,
      ...stringConstantExternrefInstrs(ctx, keyName),
      { op: "call", funcIdx: finalExternGetIdx } as Instr,
    ];
    // (#2580 M1a v2 — merge_group eject fix) CLOSURE arm, innermost so it is
    // tested LAST inside the vec chain's else. A function/closure `.length` is its
    // ARITY, not a vec length; routing a closure externref through `__extern_get`
    // returned `undefined` → NaN (the v1 Cluster-A regression: zero-arity built-in
    // method `.length` `verifyProperty({value:0})` tests flipped pass→fail because
    // origin's prior numeric path returned 0). The compiler does not statically
    // track an `any`-typed closure's arity here, and origin's prior path returned
    // a flat `0`, so match it: `ref.test` the registered closure base wrapper
    // types and, on a hit, return `box_number(0)`. Same `ref.test typeIdx`
    // discipline as the vec arm (type indices are rec-group / dead-elim stable —
    // no funcidx hazard). Closure base types are derived inline from
    // `ctx.closureInfoByTypeIdx` (walking each to its root struct) to avoid a
    // circular import on index.ts's private `collectClosureBaseWrapperTypeIdxs`.
    // (#2896) Standalone: a builtin function value carries its spec arity in
    // the finalize-filled `__builtinfn_get_meta` native — ask it first; a null
    // result (plain user closure, or a builtin fn whose `length` was deleted →
    // inherited Function.prototype.length === 0) keeps the prior flat 0.
    const bfnGetMetaIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_get_meta") : undefined;
    const closureArmThen = (): Instr[] => {
      if (bfnGetMetaIdx === undefined) {
        // arity fallback: box_number(0.0) — matches the prior numeric path.
        return [{ op: "f64.const", value: 0 } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      }
      const metaTmp = allocLocal(fctx, `__dg_bfnmeta_${fctx.locals.length}`, { kind: "externref" });
      return [
        { op: "local.get", index: recvTmp } as Instr,
        ...stringConstantExternrefInstrs(ctx, keyName),
        { op: "call", funcIdx: bfnGetMetaIdx } as Instr,
        { op: "local.tee", index: metaTmp } as Instr,
        { op: "ref.is_null" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr],
          else: [{ op: "local.get", index: metaTmp } as Instr],
        } as Instr,
      ];
    };
    for (const closureBaseTypeIdx of closureBaseWrapperTypeIdxs(ctx)) {
      chain = [
        { op: "local.get", index: anyTmp } as Instr,
        { op: "ref.test", typeIdx: closureBaseTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: closureArmThen(),
          else: chain,
        } as Instr,
      ];
    }
    // Wrap from the innermost (last) vec type outward: each layer is
    // `if ref.test $vec { box_number(f64(struct.get field0)) } else { <chain> }`.
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const vecTypeIdx = vecEntries[i]!;
      const def = ctx.mod.types[vecTypeIdx];
      if (def?.kind !== "struct" || def.fields[0]?.name !== "length" || def.fields[1]?.name !== "data") {
        continue; // not a length/data vec — skip
      }
      chain = [
        { op: "local.get", index: anyTmp } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "local.get", index: anyTmp } as Instr,
            { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "call", funcIdx: boxNumIdx } as Instr,
          ],
          else: chain,
        } as Instr,
      ];
    }
    // (#2580 M2 slice 1) NULL/UNDEFINED-RECEIVER guard, OUTERMOST (tested FIRST).
    // A receiver that is JS `null`/`undefined` at runtime — e.g. a Symbol-keyed
    // prototype walk that did not resolve (`IteratorProto[Symbol.iterator]` →
    // undefined; the Cluster-A class of the #1894 eject) — read its `.length` as
    // the prior numeric path's null-guarded `0`, NOT `__extern_get(undefined,
    // "length")` → undefined → NaN. `ref.is_null` does NOT catch this (a JS
    // `undefined` is a NON-null externref wrapping the host undefined sentinel —
    // why M1's `ref.is_null` guard left Cluster A at 0/13); the HOST
    // `__extern_is_undefined` does (`v === undefined`). On a hit return
    // `box_number(0)`, matching origin. The canary `{}` is a non-null object →
    // miss → reaches `__extern_get` → undefined (preserved).
    if (isUndefIdx !== undefined && boxNumIdx !== undefined) {
      chain = [
        { op: "local.get", index: recvTmp } as Instr,
        { op: "call", funcIdx: isUndefIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr],
          else: chain,
        } as Instr,
      ];
    }
    for (const instr of chain) fctx.body.push(instr);
    return true;
  }

  // receiver externref already on the stack → push key → call __extern_get.
  for (const instr of stringConstantExternrefInstrs(ctx, keyName)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: finalExternGetIdx } as Instr);
  return true;
}

/* (#2175 V2-S1) The deduped closure-base-wrapper list now lives in the leaf
 * `closure-classifier.ts` and is shared with index.ts's `__typeof*` natives —
 * one predicate, never two divergent arm lists. Imported (aliased to the prior
 * local name) at the top of this module. */

// ───────────────────────────────────────────────────────────────────────────
// (#3053 U0) Unified dynamic-reader carrier substrate.
//
// `__dyn_member_get(recv, key) -> carrier` is the ONE locals-free, carrier-
// uniform primitive that both #3037 CS3 (object-identity) and #2949 S5.4 (IR
// claim-rate) converge on. It reads a named/indexed member from a dynamic
// receiver and returns a tag-HONEST carrier — a `$AnyValue` in gc/standalone
// (externref in host) — instead of the identity-losing bare externref the
// legacy `emitDynGet`/`__extern_get` hand back (which downstream tag-5-boxes,
// losing BOTH object identity and the typed carrier).
//
// The whole design turns on ONE floor-safety rule that all three prior −299/
// −788 deaths violated: the externref↔carrier round-trip lives INSIDE this
// helper, never in a shared seam. Concretely the standalone body is:
//
//   recvExt = __carrier_recv_to_extern(recv)   ;; INTERNAL peel — see below
//   keyExt  = __any_to_extern(key)             ;; existing key marshalling
//   resExt  = __extern_get(recvExt, keyExt)    ;; existing proto-walk reader
//   return  __any_from_extern_honest(resExt)   ;; settled CS1b classifier
//
// The critical, DIFFERENT-from-`__any_to_extern` piece is
// `__carrier_recv_to_extern`: unlike the global `__any_to_extern` (which keeps
// a tag-6 payload WRAPPED so an `any` boundary round-trips through the generic
// classifier — the CS1a read-breaker), this PEELS the tag-6 payload to the RAW
// `$Object` ref so `__extern_get`'s `ref.test $Object` HITS. Because the peel
// lives INSIDE the substrate helper and its output feeds ONLY `__extern_get`
// (then is immediately re-boxed honest), the global `__any_to_extern` seam —
// and every other consumer of it — stays byte-identical, and re-reads compose:
// `__dyn_member_get(__dyn_member_get(o,"a"),"z")` never hits the `__any_to_extern`
// tag-6 breaker.
//
// This is U0: BUILD the helper only. NOTHING calls it yet (U1 wires it into the
// IR member-read). So it is byte-inert: `ensureDynMemberGet` is gated on the
// `ctx.usesDynMemberGet` latch, which nothing sets in U0, plus a
// `JS2WASM_FORCE_DYN_MEMBER_GET=1` self-test escape (mirrors #2580 M0's
// `ensureDynReadHelpers` / `JS2WASM_FORCE_DYN_READ`). The latch — NOT dead-elim —
// guarantees zero bytes for every module that never calls it (an uncalled
// DEFINED function is not import-pruned). Under FORCE the helper is emitted AND
// a family of exported `__dmg_*` self-test drivers exercise the carrier round-
// trip (object→tag-6 identity, string→tag-5 content, number→tag-3 value, the
// re-read composition) on host + standalone. Registered stable-handle
// (mintDefinedFunc) so a later dead-elim import shift can never desync a baked
// call (the #2043 late-shift class): live-import call immediates are remapped by
// `eliminateDeadImports`, stable handles are skipped.

// `$AnyValue` struct field layout (mirrors ensureAnyValueType):
//   0 tag(i32) · 1 i32val(i32) · 2 f64val(f64) · 3 refval(eqref) · 4 externval(externref)
const AV_TAG = 0;
const AV_I32 = 1;
const AV_F64 = 2;
const AV_REF = 3;
const AV_EXT = 4;

/**
 * (#3053 U0) Register the unified dynamic-reader carrier primitive
 * `__dyn_member_get` (+ the internal `__carrier_recv_to_extern` peel in gc/
 * standalone). Idempotent and **gated on `ctx.usesDynMemberGet`** — a no-op
 * unless a call site (U1+) has flagged the module needs it, so U0 (no call
 * sites) emits nothing and every module is byte-identical.
 *
 * `JS2WASM_FORCE_DYN_MEMBER_GET=1` force-emits the helper AND a set of exported
 * `__dmg_*` unit-test drivers (the U0 anti-vacuity self-test). Off by default;
 * never set in production, so it cannot affect any normal/CI compile.
 *
 * Call this in the finalize phase, right after `ensureDynReadHelpers`, BEFORE
 * dead-elim/freeze so the baked funcIdx values are stable. Like
 * `ensureDynReadHelpers`, it does NOT call `ensureObjectRuntime` (registering
 * struct types this late desyncs the type-index space — #2043); it looks the
 * required natives up by name and bails without emitting if any is absent (the
 * call site keeps its prior lowering — no regression).
 */
export function ensureDynMemberGet(ctx: CodegenContext): void {
  const forceSelfTest = process.env.JS2WASM_FORCE_DYN_MEMBER_GET === "1";
  if (forceSelfTest) ctx.usesDynMemberGet = true;
  if (!ctx.usesDynMemberGet) return; // U0 / member-get-free modules: byte-identical.
  if (ctx.dynMemberGetHelpersEmitted) return;
  ctx.dynMemberGetHelpersEmitted = true;

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };

  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) {
    ctx.dynMemberGetHelpersEmitted = false;
    ctx.usesDynMemberGet = false;
    return;
  }

  function addHelper(
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): number | undefined {
    const existing = ctx.funcMap.get(name);
    if (existing !== undefined) return existing;
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false } as never);
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  }

  if (ctx.standalone || ctx.wasi) {
    // ── gc/standalone carrier = (ref null $AnyValue) ──────────────────────
    const anyIdx = ctx.anyValueTypeIdx;
    if (anyIdx < 0) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }
    const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyIdx };

    // The settled #3037 CS1b honest classifier (tag-3/tag-4 peel BEFORE the eq
    // test, then tag-5 string / tag-6 object) and the key marshaller. Registering
    // these at finalize is safe: both only `addFuncType` + mint and reuse struct
    // types reserved during body compilation (`ensureAnyValueType` early-returns).
    const honestIdx = ensureAnyFromExternHelper(ctx, { forceHonest: true });
    const anyToExternIdx = ensureAnyToExternHelper(ctx);
    const boxNumberIdx = ctx.funcMap.get("__box_number");
    const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
    if (
      honestIdx === undefined ||
      anyToExternIdx === undefined ||
      boxNumberIdx === undefined ||
      boxBooleanIdx === undefined
    ) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }

    // __carrier_recv_to_extern(v: (ref null $AnyValue)) -> externref
    //   PEELS the carrier to the externref `__extern_get` needs — the load-bearing
    //   difference from `__any_to_extern` (which WRAPS tag-6). tag 6 → the RAW
    //   `$Object` ref (field 3) so `__extern_get`'s `ref.test $Object` hits;
    //   tag 5 → the string externref (field 4); tag 2/3 → __box_number;
    //   tag 4 → __box_boolean; tag 0/1/null → ref.null.extern (a null/undefined
    //   receiver → __extern_get miss → the singleton, no null-deref).
    const peelBody: Instr[] = [
      { op: "local.get", index: 0 } as Instr,
      { op: "ref.is_null" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" } as Instr, { op: "return" } as Instr],
      } as Instr,
      // tag = v.tag
      { op: "local.get", index: 0 } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG } as Instr,
      { op: "local.set", index: 1 } as Instr,
      // tag 6 → extern.convert_any(v.refval)  — the RAW $Object
      { op: "local.get", index: 1 } as Instr,
      { op: "i32.const", value: TAG_REF } as Instr,
      { op: "i32.eq" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_REF } as Instr,
          { op: "extern.convert_any" } as Instr,
          { op: "return" } as Instr,
        ],
      } as Instr,
      // tag 5 → v.externval (string externref)
      { op: "local.get", index: 1 } as Instr,
      { op: "i32.const", value: 5 } as Instr,
      { op: "i32.eq" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_EXT } as Instr,
          { op: "return" } as Instr,
        ],
      } as Instr,
      // tag 3 → __box_number(v.f64val)
      { op: "local.get", index: 1 } as Instr,
      { op: "i32.const", value: 3 } as Instr,
      { op: "i32.eq" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_F64 } as Instr,
          { op: "call", funcIdx: boxNumberIdx } as Instr,
          { op: "return" } as Instr,
        ],
      } as Instr,
      // tag 4 → __box_boolean(v.i32val)
      { op: "local.get", index: 1 } as Instr,
      { op: "i32.const", value: 4 } as Instr,
      { op: "i32.eq" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_I32 } as Instr,
          { op: "call", funcIdx: boxBooleanIdx } as Instr,
          { op: "return" } as Instr,
        ],
      } as Instr,
      // tag 2 → __box_number(f64.convert_i32_s(v.i32val))
      { op: "local.get", index: 1 } as Instr,
      { op: "i32.const", value: 2 } as Instr,
      { op: "i32.eq" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_I32 } as Instr,
          { op: "f64.convert_i32_s" } as Instr,
          { op: "call", funcIdx: boxNumberIdx } as Instr,
          { op: "return" } as Instr,
        ],
      } as Instr,
      // tag 0 (null) / 1 (undefined) receiver → null externref → __extern_get miss
      { op: "ref.null.extern" } as Instr,
    ];
    const peelIdx = addHelper("__carrier_recv_to_extern", [anyRefNull], [externref], peelBody, [
      { name: "tag", type: i32 },
    ]);
    if (peelIdx === undefined) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }

    // __dyn_member_get(recv, key) -> (ref null $AnyValue): the self-contained
    // round-trip. The result of `__any_from_extern_honest` is a (ref $AnyValue),
    // a subtype of the (ref null $AnyValue) result, so it flows unchanged.
    const dmgBody: Instr[] = [
      { op: "local.get", index: 0 } as Instr,
      { op: "call", funcIdx: peelIdx } as Instr,
      { op: "local.get", index: 1 } as Instr,
      { op: "call", funcIdx: anyToExternIdx } as Instr,
      { op: "call", funcIdx: externGetIdx } as Instr,
      { op: "call", funcIdx: honestIdx } as Instr,
    ];
    const dmgIdx = addHelper("__dyn_member_get", [anyRefNull, anyRefNull], [anyRefNull], dmgBody);
    if (dmgIdx === undefined) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }

    if (forceSelfTest) {
      emitDynMemberGetSelfTestStandalone(ctx, {
        anyIdx,
        dmgIdx,
        honestIdx,
        boxNumberIdx,
        boxBooleanIdx,
      });
    }
    return;
  }

  // ── host (gc) carrier = externref ───────────────────────────────────────
  // The host `__extern_get` import already returns the spec `Get` externref; the
  // carrier IS externref, so no box/peel. `externGetIdx` is a live import index;
  // a later dead-elim import shift remaps this baked call (stable-handle body,
  // scanned by `eliminateDeadImports`).
  const dmgHostBody: Instr[] = [
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "call", funcIdx: externGetIdx } as Instr,
  ];
  const dmgHostIdx = addHelper("__dyn_member_get", [externref, externref], [externref], dmgHostBody);
  if (dmgHostIdx === undefined) {
    ctx.dynMemberGetHelpersEmitted = false;
    ctx.usesDynMemberGet = false;
    return;
  }
  if (forceSelfTest) emitDynMemberGetSelfTestHost(ctx, dmgHostIdx);
}

/**
 * (#3053 U0) Register an EXPORTED self-test driver (FORCE mode only). Uses a
 * stable handle so a dead-elim import shift can't desync the exported index.
 */
function addDriverExport(
  ctx: CodegenContext,
  name: string,
  results: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): void {
  if (ctx.funcMap.has(name)) return;
  const typeIdx = addFuncType(ctx, [], results, name);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: true } as never);
  ctx.funcMap.set(name, funcIdx);
  ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
}

/**
 * (#3053 U0) Standalone/gc self-test drivers. Each builds a receiver with the
 * object runtime, boxes it to a tag-6 carrier via the honest classifier, calls
 * `__dyn_member_get`, and returns an i32 verdict the unit test asserts. The keys
 * ("a"/"b"/"s"/"n"/"bo"/"z") and value "ab" MUST already be pooled by the test
 * source (dynamic reads pool them) so `stringConstantExternrefInstrs` never adds
 * an import at finalize.
 */
function emitDynMemberGetSelfTestStandalone(
  ctx: CodegenContext,
  ids: { anyIdx: number; dmgIdx: number; honestIdx: number; boxNumberIdx: number; boxBooleanIdx: number },
): void {
  const { anyIdx, dmgIdx, honestIdx, boxNumberIdx, boxBooleanIdx } = ids;
  const i32: ValType = { kind: "i32" };
  const externref: ValType = { kind: "externref" };
  const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyIdx };
  const newObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const strictEqIdx = ctx.funcMap.get("__any_strict_eq");
  if (
    newObjIdx === undefined ||
    externSetIdx === undefined ||
    strictEqIdx === undefined ||
    !ctx.stringGlobalMap.has("a") ||
    !ctx.stringGlobalMap.has("b") ||
    !ctx.stringGlobalMap.has("s") ||
    !ctx.stringGlobalMap.has("n") ||
    !ctx.stringGlobalMap.has("bo") ||
    !ctx.stringGlobalMap.has("z") ||
    !ctx.stringGlobalMap.has("ab")
  ) {
    return; // dependency missing → skip drivers (self-test will surface it)
  }
  const key = (s: string): Instr[] => stringConstantExternrefInstrs(ctx, s) as Instr[];
  const newObj = (): Instr[] => [{ op: "call", funcIdx: newObjIdx } as Instr];
  const call = (fn: number): Instr => ({ op: "call", funcIdx: fn }) as Instr;
  const box = (carrier: number): Instr => call(carrier); // honest classifier / box helper
  // carrierOf(objLocal): honest($AnyValue tag-6) of the object externref in a local
  const carrierOf = (objLocal: number): Instr[] => [{ op: "local.get", index: objLocal } as Instr, call(honestIdx)];
  const keyCarrier = (s: string): Instr[] => [...key(s), call(honestIdx)];
  const readTag = (): Instr[] => [
    { op: "ref.as_non_null" } as Instr,
    { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG } as Instr,
  ];

  // Driver 1 — object read → tag 6.
  addDriverExport(
    ctx,
    "__dmg_st_object_tag",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
    ],
    [
      ...newObj(),
      { op: "local.set", index: 1 } as Instr, // inner
      ...newObj(),
      { op: "local.set", index: 0 } as Instr, // o
      { op: "local.get", index: 0 } as Instr,
      ...key("a"),
      { op: "local.get", index: 1 } as Instr,
      call(externSetIdx),
      ...carrierOf(0),
      ...keyCarrier("a"),
      call(dmgIdx),
      ...readTag(),
    ],
  );

  // Driver 2 — aliased object reads ARE === (identity via tag-6 ref.eq → 1).
  const aliasedIdentity = (k1: string, k2: string, distinct: boolean): Instr[] => [
    ...newObj(),
    { op: "local.set", index: 1 } as Instr, // inner
    ...(distinct ? [...newObj(), { op: "local.set", index: 2 } as Instr] : []), // inner2 (distinct only)
    ...newObj(),
    { op: "local.set", index: 0 } as Instr, // o
    { op: "local.get", index: 0 } as Instr,
    ...key(k1),
    { op: "local.get", index: 1 } as Instr,
    call(externSetIdx),
    { op: "local.get", index: 0 } as Instr,
    ...key(k2),
    { op: "local.get", index: distinct ? 2 : 1 } as Instr,
    call(externSetIdx),
    ...carrierOf(0),
    ...keyCarrier(k1),
    call(dmgIdx),
    ...carrierOf(0),
    ...keyCarrier(k2),
    call(dmgIdx),
    call(strictEqIdx),
  ];
  addDriverExport(
    ctx,
    "__dmg_st_object_identity",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "inner2", type: externref },
    ],
    aliasedIdentity("a", "b", false),
  );
  // Driver 3 — distinct objects are NOT === (anti-vacuity → 0).
  addDriverExport(
    ctx,
    "__dmg_st_object_distinct",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "inner2", type: externref },
    ],
    aliasedIdentity("a", "b", true),
  );

  // Driver 4/5 — string read → tag 5, content-=== → 1.
  const buildStringObj: Instr[] = [
    ...newObj(),
    { op: "local.set", index: 0 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    ...key("s"),
    ...key("ab"),
    call(externSetIdx),
  ];
  addDriverExport(
    ctx,
    "__dmg_st_string_tag",
    [i32],
    [{ name: "o", type: externref }],
    [...buildStringObj, ...carrierOf(0), ...keyCarrier("s"), call(dmgIdx), ...readTag()],
  );
  addDriverExport(
    ctx,
    "__dmg_st_string_value",
    [i32],
    [{ name: "o", type: externref }],
    [
      ...buildStringObj,
      ...carrierOf(0),
      ...keyCarrier("s"),
      call(dmgIdx),
      ...carrierOf(0),
      ...keyCarrier("s"),
      call(dmgIdx),
      call(strictEqIdx),
    ],
  );

  // Driver 6/7 — number read → tag 3, value-=== → 1.
  const buildNumberObj: Instr[] = [
    ...newObj(),
    { op: "local.set", index: 0 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    ...key("n"),
    { op: "f64.const", value: 42 } as Instr,
    box(boxNumberIdx),
    call(externSetIdx),
  ];
  addDriverExport(
    ctx,
    "__dmg_st_number_tag",
    [i32],
    [{ name: "o", type: externref }],
    [...buildNumberObj, ...carrierOf(0), ...keyCarrier("n"), call(dmgIdx), ...readTag()],
  );
  addDriverExport(
    ctx,
    "__dmg_st_number_value",
    [i32],
    [{ name: "o", type: externref }],
    [
      ...buildNumberObj,
      ...carrierOf(0),
      ...keyCarrier("n"),
      call(dmgIdx),
      ...carrierOf(0),
      ...keyCarrier("n"),
      call(dmgIdx),
      call(strictEqIdx),
    ],
  );

  // Driver 8 — boolean read → tag 4.
  addDriverExport(
    ctx,
    "__dmg_st_boolean_tag",
    [i32],
    [{ name: "o", type: externref }],
    [
      ...newObj(),
      { op: "local.set", index: 0 } as Instr,
      { op: "local.get", index: 0 } as Instr,
      ...key("bo"),
      { op: "i32.const", value: 1 } as Instr,
      box(boxBooleanIdx),
      call(externSetIdx),
      ...carrierOf(0),
      ...keyCarrier("bo"),
      call(dmgIdx),
      ...readTag(),
    ],
  );

  // Driver 9 — RE-READ composition `dmg(dmg(o,"a"),"z")`. Proves the internal
  // peel round-trips (the CS1a `__any_to_extern` breaker is NOT re-triggered):
  // inner.z = 7, o.a = inner; reading o.a yields a tag-6 carrier for inner, then
  // reading .z off THAT carrier yields tag-3 value 7. Returns tag*1000 + value.
  addDriverExport(
    ctx,
    "__dmg_st_reread",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "r", type: anyRefNull },
    ],
    [
      ...newObj(),
      { op: "local.set", index: 1 } as Instr, // inner
      { op: "local.get", index: 1 } as Instr,
      ...key("z"),
      { op: "f64.const", value: 7 } as Instr,
      box(boxNumberIdx),
      call(externSetIdx),
      ...newObj(),
      { op: "local.set", index: 0 } as Instr, // o
      { op: "local.get", index: 0 } as Instr,
      ...key("a"),
      { op: "local.get", index: 1 } as Instr,
      call(externSetIdx),
      // r = dmg(dmg(carrier(o), "a"), "z")
      ...carrierOf(0),
      ...keyCarrier("a"),
      call(dmgIdx),
      ...keyCarrier("z"),
      call(dmgIdx),
      { op: "local.set", index: 2 } as Instr,
      // tag*1000
      { op: "local.get", index: 2 } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG } as Instr,
      { op: "i32.const", value: 1000 } as Instr,
      { op: "i32.mul" } as Instr,
      // + trunc(f64val)
      { op: "local.get", index: 2 } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_F64 } as Instr,
      { op: "i32.trunc_f64_s" } as Instr,
      { op: "i32.add" } as Instr,
    ],
  );
}

/**
 * (#3053 U0) Host (gc) self-test drivers. In host mode the carrier IS externref
 * and `__dyn_member_get` is a thin `__extern_get` wrapper; objects from the host
 * `__new_plain_object` are plain JS objects, so writes go through the host
 * `__extern_set_strict` import and identity through the host `__host_eq` (JS
 * `===`) import — NOT the WasmGC `__extern_set`/`ref.eq` (the standalone path).
 * Verifies value (number readback) + object identity + distinctness end-to-end
 * through the host runtime. Keys "a"/"b"/"n" pooled by the test source.
 */
function emitDynMemberGetSelfTestHost(ctx: CodegenContext, dmgIdx: number): void {
  const i32: ValType = { kind: "i32" };
  const externref: ValType = { kind: "externref" };
  const newObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set_strict");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
  const hostEqIdx = ctx.funcMap.get("__host_eq");
  if (
    newObjIdx === undefined ||
    externSetIdx === undefined ||
    boxNumberIdx === undefined ||
    unboxNumberIdx === undefined ||
    hostEqIdx === undefined ||
    !ctx.stringGlobalMap.has("a") ||
    !ctx.stringGlobalMap.has("b") ||
    !ctx.stringGlobalMap.has("n")
  ) {
    return;
  }
  const key = (s: string): Instr[] => stringConstantExternrefInstrs(ctx, s) as Instr[];
  const call = (fn: number): Instr => ({ op: "call", funcIdx: fn }) as Instr;

  // Value: o.n = 7; return trunc(unbox(dmg(o, "n"))).
  addDriverExport(
    ctx,
    "__dmg_gc_value",
    [i32],
    [{ name: "o", type: externref }],
    [
      { op: "call", funcIdx: newObjIdx } as Instr,
      { op: "local.set", index: 0 } as Instr,
      { op: "local.get", index: 0 } as Instr,
      ...key("n"),
      { op: "f64.const", value: 7 } as Instr,
      call(boxNumberIdx),
      call(externSetIdx),
      { op: "local.get", index: 0 } as Instr,
      ...key("n"),
      call(dmgIdx),
      call(unboxNumberIdx),
      { op: "i32.trunc_f64_s" } as Instr,
    ],
  );

  // Identity: inner aliased at o.a & o.b; __host_eq(dmg(o,"a"), dmg(o,"b")).
  const identity = (distinct: boolean): Instr[] => [
    { op: "call", funcIdx: newObjIdx } as Instr,
    { op: "local.set", index: 1 } as Instr, // inner
    ...(distinct ? [{ op: "call", funcIdx: newObjIdx } as Instr, { op: "local.set", index: 2 } as Instr] : []),
    { op: "call", funcIdx: newObjIdx } as Instr,
    { op: "local.set", index: 0 } as Instr, // o
    { op: "local.get", index: 0 } as Instr,
    ...key("a"),
    { op: "local.get", index: 1 } as Instr,
    call(externSetIdx),
    { op: "local.get", index: 0 } as Instr,
    ...key("b"),
    { op: "local.get", index: distinct ? 2 : 1 } as Instr,
    call(externSetIdx),
    { op: "local.get", index: 0 } as Instr,
    ...key("a"),
    call(dmgIdx),
    { op: "local.get", index: 0 } as Instr,
    ...key("b"),
    call(dmgIdx),
    call(hostEqIdx),
  ];
  addDriverExport(
    ctx,
    "__dmg_gc_identity",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "inner2", type: externref },
    ],
    identity(false),
  );
  addDriverExport(
    ctx,
    "__dmg_gc_distinct",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "inner2", type: externref },
    ],
    identity(true),
  );
}
