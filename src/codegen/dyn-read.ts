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
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { ensureGetUndefined } from "./expressions/late-imports.js";

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
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false } as never);
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
    [
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
    [
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
