// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2163) Native (host-free) storage for Symbol descriptions.
 *
 * Standalone / WASI modules have no JS host, so the `__symbol_register_desc` /
 * `__symbol_description` host imports (#1467) are unsatisfiable — every
 * `Symbol(desc)` / `sym.description` either failed to instantiate or leaked an
 * `env::*` import. The symbol value itself is a bare i32 counter id
 * (`compileSymbolCall`, literals.ts), so the description just needs an
 * id→string side table the module owns.
 *
 * Representation: a single mutable module global holding a growable
 * `(array (mut (ref null $AnyString)))`, indexed directly by the symbol id.
 * The array is lazily allocated on first store and grown ×2 (copying) when a
 * larger id arrives. A null slot (or id past the current length) reads back as
 * `undefined`, matching `Symbol().description === undefined`.
 *
 * Only used in `noJsHost` mode; JS-host mode keeps the spec-accurate host
 * accessor path unchanged.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { getOrRegisterArrayType } from "./registry/types.js";

/** Initial capacity of the description table (covers small symbol counts without
 *  a grow; ids start at 100 so the very first user symbol already forces one
 *  grow regardless — see emitSymbolDescStore). */
const INITIAL_CAP = 128;

/**
 * Ensure the symbol description table's array type and lazy global exist.
 * Idempotent. Sets `ctx.symbolDescArrTypeIdx` and `ctx.symbolDescGlobalIdx`.
 */
export function ensureSymbolDescTable(ctx: CodegenContext): void {
  if (ctx.symbolDescGlobalIdx >= 0) return;
  ensureNativeStringHelpers(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  // (array (mut (ref null $AnyString))) — same shape the native string runtime
  // already registers for its split/flatten worklists (keyed by `ref_<anyStr>`).
  const arrTypeIdx = getOrRegisterArrayType(ctx, `ref_${anyStrTypeIdx}`, {
    kind: "ref_null",
    typeIdx: anyStrTypeIdx,
  });
  ctx.symbolDescArrTypeIdx = arrTypeIdx;

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__symbol_desc_table",
    type: { kind: "ref_null", typeIdx: arrTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: arrTypeIdx } as Instr],
  });
  ctx.symbolDescGlobalIdx = globalIdx;
}

/**
 * Emit code that stores a description for a symbol id into the native table.
 *
 * Stack in:  `[i32 id, ref_null $AnyString desc]`  (desc on top)
 * Stack out: `[]`
 *
 * Allocates the table on first use and grows it (×2 until it fits, copying the
 * existing slots) when `id >= table.len`.
 */
export function emitSymbolDescStore(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureSymbolDescTable(ctx);
  const arrTypeIdx = ctx.symbolDescArrTypeIdx;
  const globalIdx = ctx.symbolDescGlobalIdx;
  const anyStrNull: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const arrNull: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };

  const idLocal = allocLocal(fctx, `__symdesc_id_${fctx.locals.length}`, { kind: "i32" });
  const descLocal = allocLocal(fctx, `__symdesc_val_${fctx.locals.length}`, anyStrNull);
  const tblLocal = allocLocal(fctx, `__symdesc_tbl_${fctx.locals.length}`, arrNull);
  const capLocal = allocLocal(fctx, `__symdesc_cap_${fctx.locals.length}`, { kind: "i32" });
  const growLocal = allocLocal(fctx, `__symdesc_grow_${fctx.locals.length}`, arrNull);

  // desc and id arrive on the stack (id pushed first, desc on top).
  fctx.body.push({ op: "local.set", index: descLocal });
  fctx.body.push({ op: "local.set", index: idLocal });

  // tbl = global; if null → allocate INITIAL_CAP (grown below if id is larger).
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "local.tee", index: tblLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: INITIAL_CAP },
      { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
      { op: "local.set", index: tblLocal },
      { op: "local.get", index: tblLocal },
      { op: "global.set", index: globalIdx },
    ],
    else: [],
  });

  // Grow loop: while (id >= tbl.len) { cap = tbl.len*2; grow = new[cap];
  //   array.copy grow[0..tbl.len] = tbl[0..tbl.len]; tbl = grow; global = tbl; }
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          // if (id < tbl.len) break
          { op: "local.get", index: idLocal },
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "i32.lt_s" },
          { op: "br_if", depth: 1 },
          // cap = tbl.len * 2
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "local.set", index: capLocal },
          // grow = new[cap]
          { op: "local.get", index: capLocal },
          { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
          { op: "local.set", index: growLocal },
          // array.copy grow[0 ..] = tbl[0 .. tbl.len]
          { op: "local.get", index: growLocal },
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
          // tbl = grow; global = tbl
          { op: "local.get", index: growLocal },
          { op: "local.set", index: tblLocal },
          { op: "local.get", index: tblLocal },
          { op: "global.set", index: globalIdx },
          { op: "br", depth: 0 },
        ],
      } as Instr,
    ],
  });

  // tbl[id] = desc
  fctx.body.push({ op: "local.get", index: tblLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "local.get", index: idLocal });
  fctx.body.push({ op: "local.get", index: descLocal });
  fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
}

/**
 * Emit code that loads the description for a symbol id from the native table.
 *
 * Stack in:  `[i32 id]`
 * Stack out: `[ref_null $AnyString]`  (null when the table is unallocated, the
 *            id is out of range, or the slot was never set — all of which the
 *            `.description` accessor treats as `undefined`).
 */
export function emitSymbolDescLoad(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureSymbolDescTable(ctx);
  const arrTypeIdx = ctx.symbolDescArrTypeIdx;
  const globalIdx = ctx.symbolDescGlobalIdx;
  const anyStrNull: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const arrNull: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };

  const idLocal = allocLocal(fctx, `__symdescr_id_${fctx.locals.length}`, { kind: "i32" });
  const tblLocal = allocLocal(fctx, `__symdescr_tbl_${fctx.locals.length}`, arrNull);

  fctx.body.push({ op: "local.set", index: idLocal });
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "local.tee", index: tblLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    // result: ref_null $AnyString
    blockType: { kind: "val", type: anyStrNull },
    // table unallocated → undefined
    then: [{ op: "ref.null", typeIdx: ctx.anyStrTypeIdx } as Instr],
    else: [
      // if (id >= 0 && id < tbl.len) return tbl[id]; else null
      { op: "local.get", index: idLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      { op: "local.get", index: idLocal },
      { op: "local.get", index: tblLocal },
      { op: "ref.as_non_null" },
      { op: "array.len" },
      { op: "i32.lt_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: anyStrNull },
        then: [
          { op: "local.get", index: tblLocal } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "local.get", index: idLocal } as Instr,
          { op: "array.get", typeIdx: arrTypeIdx } as Instr,
        ],
        else: [{ op: "ref.null", typeIdx: ctx.anyStrTypeIdx } as Instr],
      } as Instr,
    ],
  });
}
