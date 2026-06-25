// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2664 — deferred-fill member-WRITE dispatcher `__set_member_<name>`.
 *
 * The symmetric struct.set write dispatch (#2659, `emitAlternateStructSetDispatch`)
 * resolves an `any`/`externref` receiver that is actually a typed WasmGC struct
 * and writes the field SLOT (mirroring the member-READ fast path), falling
 * through to `__extern_set_strict` (the JS-side sidecar) for genuine host
 * externrefs / accessors / dynamic-only props.
 *
 * The original implementation enumerated the struct candidates and emitted the
 * `ref.test`/`struct.set` chain INLINE at each write site. That froze the
 * candidate set at the write's compile time: a field-writing CLOSURE (e.g.
 * acorn's `finishToken`, a lifted closure reading `this` from `__current_this`)
 * compiled BEFORE a later-registered struct type for the same logical object
 * (acorn's Parser gets TWO struct shapes — an anonymous `$__anon_5` and the
 * constructor `$__fnctor_Parser`, registered later) only got the earlier
 * candidate's arm. The real instance is the later type, so its `ref.test` failed
 * → the write leaked to the sidecar while reads used the slot →
 * `while (this.type !== eof)` never terminated (the 8th acorn dogfood wall).
 *
 * Fix: reserve a per-property dispatcher `__set_member_<name>(recv, val)` at the
 * write site (where `name` is a static string) with a placeholder body, and FILL
 * it at FINALIZE — when the FULL struct-type table is known, so it enumerates
 * EVERY mutable struct candidate that owns the field, regardless of which
 * function compiled first. Mirrors the reserve-then-fill discipline of
 * `fillClosedMethodDispatch` (#2151) / `fillExternGetIdxVecArms` (#2190).
 *
 *   __set_member_<name>(recv: externref, val: externref)
 *     any = any.convert_extern(recv)
 *     if ref.test S1: ref.cast S1; <coerce val externref->fieldType>; struct.set S1 <slot>
 *     elif ref.test S2: …
 *     else: __extern_set_strict(recv, "<name>", val)   ;; sidecar / accessor throw
 *
 * Applies to BOTH gc/host and standalone — the dual-struct-type compile-order
 * hazard is mode-independent (acorn dogfoods in gc/host mode).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { findAlternateStructsForField } from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, ensureLateImport } from "./shared.js";

/**
 * Mangle a property name + fallback strictness into the reserved dispatcher name.
 * STRICT (`__extern_set_strict`, throws on a getter-only accessor per the spec
 * [[Set]]) is used by plain `obj.x = v` writes (#2017); NON-strict
 * (`__extern_set`) by read-modify-write `obj.x += v` / `obj.x++` writes, where
 * the property was already read so the sidecar update never hits an accessor
 * throw. The two need DISTINCT dispatchers (different terminal else-arm), so the
 * variant is part of the key — mirrors `__call_m_<name>_<arity>` vs `_vararg`.
 */
function dispatcherName(propName: string, strict: boolean): string {
  return strict ? `__set_member_${propName}` : `__set_member_nonstrict_${propName}`;
}

/**
 * Reserve (or fetch) the member-set dispatcher `__set_member_<name>(recv, val)`
 * funcIdx with a placeholder body. The real body is built by
 * {@link fillMemberSetDispatch} at finalize. Idempotent; records the property
 * name in `ctx.memberSetDispatchNames`. Returns the reserved funcIdx.
 *
 * ALL of the fill body's dependencies are registered NOW (at reserve time) so
 * the fill only READS funcMap — registering imports/globals at FINALIZE would
 * shift baked call/global indices (the addUnionImports hazard the reserve-then-
 * fill pattern exists to avoid):
 *   - `__extern_set_strict` (the terminal sidecar/accessor-throw fallback),
 *   - the property-name string constant (the fallback's key),
 *   - `__box_number`/`__unbox_number` (union imports — the per-struct arms may
 *     unbox the externref value into an f64/i32 field via `coercionInstrs`).
 */
export function reserveMemberSetDispatch(ctx: CodegenContext, propName: string, strict: boolean): number | undefined {
  const name = dispatcherName(propName, strict);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // Terminal else-arm dependency: the sidecar/host write. STRICT throws on a
  // getter-only accessor (#2017 spec [[Set]]); NON-strict is the plain
  // read-modify-write sidecar update. Match the inline fallback each call site
  // used to build.
  const fallbackName = strict ? "__extern_set_strict" : "__extern_set";
  const setIdx = ensureLateImport(
    ctx,
    fallbackName,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  if (setIdx === undefined) return undefined;
  // The fallback's string key + the union box/unbox helpers the arm coercions need.
  addStringConstantGlobal(ctx, propName);
  addUnionImportsViaRegistry(ctx);

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [], "$member_set_dispatch_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: [],
    // Placeholder; filled by fillMemberSetDispatch. `unreachable` keeps the stub
    // valid (no results) if the fill is ever skipped (it never is — the fill
    // iterates the same name set this reserve populates).
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.memberSetDispatchNames ??= new Set<string>()).add(`${propName}\0${strict ? "S" : "N"}`);
  return funcIdx;
}

/**
 * Fill every reserved `__set_member_<name>` dispatcher body at FINALIZE, after
 * every struct type (incl. late-registered fnctor structs) is known. READ-ONLY
 * over funcMap (all deps registered at reserve time), so no funcIdx churn. Sets
 * the placeholder body to the full `ref.test`/`struct.set` chain. No-op when no
 * write site reserved a dispatcher.
 *
 * Body local layout: param 0 = recv (externref), param 1 = val (externref),
 * local 2 = `__any` (anyref, the converted receiver tested against each struct).
 */
export function fillMemberSetDispatch(ctx: CodegenContext): void {
  const mod = ctx.mod;

  for (const key of ctx.memberSetDispatchNames ?? []) {
    // key is `<propName>\0<S|N>` — strict (S) vs non-strict (N) fallback variant.
    const sep = key.lastIndexOf("\0");
    const propName = sep >= 0 ? key.slice(0, sep) : key;
    const strict = sep >= 0 ? key.slice(sep + 1) === "S" : true;
    const dispIdx = ctx.funcMap.get(dispatcherName(propName, strict));
    if (dispIdx === undefined) continue;
    const dispFn = mod.functions[dispIdx - ctx.numImportFuncs];
    if (!dispFn) continue;

    // Enumerate the COMPLETE candidate set now (full type table). Only mutable
    // fields can take a `struct.set` (an immutable field is a hard validator
    // error — the #2657 boxed-primitive-wrapper case); immutable-field structs
    // fall through to the sidecar, which is correct for `(new String("x")).value`.
    const candidates = findAlternateStructsForField(ctx, propName, -1).filter((c) => c.mutable);

    // Terminal else-arm: the host write (strict throws on a getter-only accessor;
    // non-strict is the plain sidecar update). Covers genuine host externrefs,
    // accessors (no struct candidate matches → strict-throw preserved), and
    // dynamic sidecar-only props.
    const fallbackIdx = ctx.funcMap.get(strict ? "__extern_set_strict" : "__extern_set");
    const fallback: Instr[] =
      fallbackIdx !== undefined
        ? [
            { op: "local.get", index: 0 } as Instr, // recv
            ...stringConstantExternrefInstrs(ctx, propName),
            { op: "local.get", index: 1 } as Instr, // val
            { op: "call", funcIdx: fallbackIdx } as Instr,
          ]
        : [];

    const buildSetDispatch = (idx: number): Instr[] => {
      if (idx >= candidates.length) return fallback;
      const cand = candidates[idx]!;
      // Coerce the boxed externref value into the candidate field's wasm type.
      // For an externref field (the common acorn `type`/`value` case) this is a
      // no-op; f64/i32 fields unbox via the reserve-time-registered __unbox_number.
      const coerce = coerceExternrefToFieldType(ctx, cand.fieldType);
      const setFieldInstrs: Instr[] = [
        { op: "local.get", index: 2 } as Instr, // __any
        { op: "ref.cast", typeIdx: cand.structTypeIdx } as Instr,
        { op: "local.get", index: 1 } as Instr, // val (externref)
        ...coerce,
        { op: "struct.set", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx } as Instr,
      ];
      return [
        { op: "local.get", index: 2 } as Instr, // __any
        { op: "ref.test", typeIdx: cand.structTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: setFieldInstrs,
          else: buildSetDispatch(idx + 1),
        } as Instr,
      ];
    };

    dispFn.locals = [{ name: "__any", type: { kind: "anyref" } }];
    dispFn.body = [
      { op: "local.get", index: 0 } as Instr, // recv (externref)
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 2 } as Instr, // __any
      ...buildSetDispatch(0),
    ];
  }
}

/**
 * Coerce the dispatcher's `val` (externref, already on the stack) into a struct
 * field's wasm type at FILL time (no fctx). Handles the field-type kinds that
 * appear on struct fields; box/unbox helpers were registered at reserve time so
 * these are pure funcMap reads (no funcIdx churn). externref→externref is a
 * no-op (the common acorn `type`/`value` case).
 */
function coerceExternrefToFieldType(ctx: CodegenContext, fieldType: ValType): Instr[] {
  switch (fieldType.kind) {
    case "externref":
      return [];
    case "f64": {
      const unbox = ctx.funcMap.get("__unbox_number");
      return unbox !== undefined ? [{ op: "call", funcIdx: unbox } as Instr] : [];
    }
    case "i32": {
      const unbox = ctx.funcMap.get("__unbox_number");
      return unbox !== undefined
        ? [{ op: "call", funcIdx: unbox } as Instr, { op: "i32.trunc_sat_f64_s" } as Instr]
        : [];
    }
    case "i64": {
      const unbox = ctx.funcMap.get("__unbox_number");
      return unbox !== undefined
        ? [{ op: "call", funcIdx: unbox } as Instr, { op: "i64.trunc_sat_f64_s" } as Instr]
        : [];
    }
    case "ref":
      // externref → (ref T): recover the GC ref and cast to the field type.
      return [
        { op: "any.convert_extern" } as Instr,
        { op: "ref.cast", typeIdx: (fieldType as { typeIdx: number }).typeIdx } as Instr,
      ];
    case "ref_null":
      return [
        { op: "any.convert_extern" } as Instr,
        { op: "ref.cast", typeIdx: (fieldType as { typeIdx: number }).typeIdx } as Instr,
      ];
    default:
      return [];
  }
}
