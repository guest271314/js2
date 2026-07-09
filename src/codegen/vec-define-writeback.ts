// (#3116) __vec_set_elem / __vec_set_len — array-exotic [[DefineOwnProperty]]
// write-back exports for the JS-host runtime.
//
// Root cause these fix: `Object.defineProperty(arr, "0", {value: v})` (and the
// plural `defineProperties`) on a STATICALLY-typed array receiver reaches the
// runtime's opaque-struct arm, which could only store `v` in the host-side
// sidecar — but element/length READS compile to direct WasmGC vec accesses
// (struct.get / array.get / __vec_get), which never consult the sidecar. So the
// define was invisible to every subsequent read (the `15.2.3.6-4-*` /
// `15.2.3.7-6-a-*` test262 cluster). These exports let the runtime write the
// VALUE into the vec itself (attributes stay in the sidecar), restoring
// read/write path consistency for both the static and dynamic read lanes.
//
// Mirrors the __vec_push/__vec_pop per-vec-type ref.test dispatch and grow
// discipline (newCap = max((idx+1)*2, 4), array.new_default + array.copy +
// struct.set). Unsupported element kinds return the -1 sentinel so the runtime
// falls back to its previous sidecar-only behaviour. Emission is gated (by the
// caller in `_emitVecAccessExportsInner`) on a defineProperty import being
// present so modules that never define properties stay byte-identical.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";

/**
 * Emit the two write-back exports. `mutEntries` is the caller's filtered
 * (elem-kind-supported) vec-type list; `unboxNumIdx` the `__unbox_number`
 * funcIdx (defined whenever a non-externref elem kind is in `mutEntries`).
 */
export function emitVecDefineWritebackExports(
  ctx: CodegenContext,
  mutEntries: Array<[string, number]>,
  unboxNumIdx: number | undefined,
): void {
  const mod = ctx.mod;

  // __vec_set_elem(externref vec, i32 idx, externref value) -> i32 (1 = ok, -1 = unsupported)
  {
    const setElemTypeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }, { kind: "externref" }],
      [{ kind: "i32" }],
      "$__vec_set_elem_type",
    );
    const setElemFuncIdx = ctx.numImportFuncs + mod.functions.length;
    // params: 0 = vec (externref), 1 = idx (i32), 2 = value (externref)
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 3 } as Instr,
    ];
    let current: Instr[] = [{ op: "i32.const", value: -1 } as Instr, { op: "return" } as Instr];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 3 + locals.length; // 3 params + locals so far
      const vecL = base;
      const dataL = base + 1;
      const lenL = base + 2;
      const ncapL = base + 3;
      const ndataL = base + 4;
      locals.push(
        { name: `__vse_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vse_data_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
        { name: `__vse_len_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vse_ncap_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vse_ndata_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      );
      // value unboxing per element kind (value param is local 2)
      const valueInstrs: Instr[] =
        elemKey === "externref"
          ? [{ op: "local.get", index: 2 } as Instr]
          : elemKey === "f64"
            ? [{ op: "local.get", index: 2 } as Instr, { op: "call", funcIdx: unboxNumIdx! } as Instr]
            : [
                { op: "local.get", index: 2 } as Instr,
                { op: "call", funcIdx: unboxNumIdx! } as Instr,
                { op: "i32.trunc_sat_f64_s" } as Instr,
              ];
      const thenBranch: Instr[] = [
        { op: "local.get", index: 3 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "local.set", index: vecL } as Instr,
        // len
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "local.set", index: lenL } as Instr,
        // data + capacity check: cap < idx+1 ?
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.tee", index: dataL } as Instr,
        { op: "array.len" } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // ncap = max((idx+1)*2, 4)
            { op: "local.get", index: 1 } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.shl" } as Instr,
            { op: "i32.const", value: 4 } as Instr,
            { op: "local.get", index: 1 } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.shl" } as Instr,
            { op: "i32.const", value: 4 } as Instr,
            { op: "i32.gt_s" } as Instr,
            { op: "select" } as Instr,
            { op: "local.set", index: ncapL } as Instr,
            // ndata = array.new_default(ncap); copy old len; vec.data = ndata
            { op: "local.get", index: ncapL } as Instr,
            { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
            { op: "local.set", index: ndataL } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.get", index: dataL } as Instr,
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.get", index: lenL } as Instr,
            { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
            { op: "local.get", index: vecL } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "ref.as_non_null" } as Instr,
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "local.set", index: dataL } as Instr,
          ],
        } as Instr,
        // data[idx] = value
        { op: "local.get", index: dataL } as Instr,
        { op: "local.get", index: 1 } as Instr,
        ...valueInstrs,
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
        // vec.length = max(len, idx+1)
        { op: "local.get", index: lenL } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: vecL } as Instr,
            { op: "local.get", index: 1 } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
          ],
        } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 3 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);
    mod.functions.push({
      name: "__vec_set_elem",
      typeIdx: setElemTypeIdx,
      locals,
      body,
      exported: true,
    } as never);
    mod.exports.push({ name: "__vec_set_elem", desc: { kind: "func", index: setElemFuncIdx } });
    ctx.funcMap.set("__vec_set_elem", setElemFuncIdx);
  }

  // __vec_set_len(externref vec, i32 newLen) -> i32 (1 = ok, -1 = unsupported)
  {
    const setLenTypeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$__vec_set_len_type",
    );
    const setLenFuncIdx = ctx.numImportFuncs + mod.functions.length;
    // params: 0 = vec (externref), 1 = newLen (i32)
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 2 } as Instr,
    ];
    let current: Instr[] = [{ op: "i32.const", value: -1 } as Instr, { op: "return" } as Instr];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 2 + locals.length; // 2 params + locals so far
      const vecL = base;
      const dataL = base + 1;
      const lenL = base + 2;
      const ndataL = base + 3;
      locals.push(
        { name: `__vsl_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vsl_data_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
        { name: `__vsl_len_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vsl_ndata_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      );
      const thenBranch: Instr[] = [
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "local.set", index: vecL } as Instr,
        // old len
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "local.set", index: lenL } as Instr,
        // grow data when cap < newLen (allocation bound is enforced host-side)
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.tee", index: dataL } as Instr,
        { op: "array.len" } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 } as Instr,
            { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
            { op: "local.set", index: ndataL } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.get", index: dataL } as Instr,
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.get", index: lenL } as Instr,
            { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
            { op: "local.get", index: vecL } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "ref.as_non_null" } as Instr,
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
          ],
        } as Instr,
        // vec.length = newLen
        { op: "local.get", index: vecL } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);
    mod.functions.push({
      name: "__vec_set_len",
      typeIdx: setLenTypeIdx,
      locals,
      body,
      exported: true,
    } as never);
    mod.exports.push({ name: "__vec_set_len", desc: { kind: "func", index: setLenFuncIdx } });
    ctx.funcMap.set("__vec_set_len", setLenFuncIdx);
  }
}
