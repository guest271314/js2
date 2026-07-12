// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted Timsort kernels (#3159 — array family slice 1 of the porffor
 * model, following the #3141 Math pilot).
 *
 * Each kernel is ORDINARY TypeScript source in the IR-claimable subset,
 * instantiated per element kind (`f64` for `number[]` vecs, `i32` for
 * boolean-element vecs) from ONE template. The compiler compiles these
 * through its OWN pipeline at compile time (`src/codegen/stdlib-selfhost.ts`)
 * and registers the results exactly where the hand-emitted `Instr[]`
 * versions used to live (`src/codegen/timsort.ts`, 922 → ~230 lines).
 *
 * WHY ONE TEMPLATE COVERS BOTH ELEMENT KINDS: element values are only ever
 * loaded, compared, and stored — never mixed into index arithmetic. The
 * element accessors (`__arri_get_<k>` …) are typed intrinsic callees whose
 * return/param types carry the element kind, so unannotated locals like
 * `let key = __arri_get_i32(data, i)` infer i32, and from-ast's magnitude
 * compares are polymorphic over f64 AND i32 (#1126 Stage 3) — `>` emits
 * `f64.gt` or `i32.gt_s` per operand type, exactly the ops the hand bodies
 * hard-coded.
 *
 * DIALECT RULES (beyond the #3141 header):
 *   - Element access goes through the `__arri_*` intrinsics (raw-array
 *     get/set/new/copy is not expressible in the IR subset, and call args
 *     require EXACT IrType match — hence f64 index params, truncated inside
 *     the intrinsic). See `ensureArrayIntrinsics` in timsort.ts.
 *   - Index/length arithmetic stays f64 (`number`): array indices are
 *     < 2^31, exact in f64. Internal kernel signatures therefore differ
 *     from the deleted hand versions (i32 index params) — sound, and only
 *     observable inside the kernel family; the external `__timsort_<k>(vec)`
 *     ABI is preserved by a small hand thunk.
 *   - The run stack (`sBase`/`sLen`) uses f64 arrays (hand version: i32
 *     arrays). Values are run bases/lengths — exact in f64, observationally
 *     equivalent.
 *
 * NUMERIC EQUIVALENCE: each body mirrors the deleted hand `Instr[]`
 * op-for-op — same compare directions (`>` in the isort inner loop, `<=` in
 * the merge pick and the collapse invariants, `<` in run detection and the
 * merge-index tie-breaks), so NaN behavior is identical (every f64 compare
 * with NaN is false in both versions), stability is identical, and sorted
 * output is bit-exact against the hand kernels.
 */

/** Element kinds the numeric Timsort instantiates (see #2502 guards). */
export type SortElemKind = "f64" | "i32";

export interface TimsortKernelDef {
  /** funcMap registration name (also the function name in `source`). */
  readonly name: string;
  /** Ordinary TS source, IR-claimable subset. */
  readonly source: string;
  /**
   * Positional param specs, mapped to concrete IrTypes by the caller
   * (timsort.ts knows the ctx's array typeIdx values):
   *   "data"  — `(ref null $arr_<k>)` element data array
   *   "stack" — `(ref null $arr_f64)` run-stack array
   *   "num"   — f64
   */
  readonly params: readonly ("data" | "stack" | "num")[];
  /** Return spec: "num" (f64) or null (void). */
  readonly ret: "num" | null;
  /**
   * Callee names (siblings + intrinsics), in-source call targets. All must
   * be registered in ctx.funcMap before this kernel is emitted.
   */
  readonly callees: readonly string[];
}

/**
 * Insertion sort a range [lo, hi). Mirrors the hand `__isort_<k>`:
 * inner loop shifts while `data[j] > key` (strict — stability), re-loading
 * `data[j]` for the shift store exactly like the hand body did.
 */
function isortSource(k: SortElemKind): string {
  return `
export function __sh_isort_${k}(data, lo: number, hi: number): void {
  let i: number = lo + 1;
  while (i < hi) {
    let key = __arri_get_${k}(data, i);
    let j: number = i - 1;
    while (j >= lo && __arri_get_${k}(data, j) > key) {
      __arri_set_${k}(data, j + 1, __arri_get_${k}(data, j));
      j = j - 1;
    }
    __arri_set_${k}(data, j + 1, key);
    i = i + 1;
  }
  return;
}
`;
}

/**
 * Stable merge of [lo, mid) and [mid, hi) using scratch `tmp` for the left
 * half. Mirrors the hand `__merge_<k>`: pick from left while
 * `tmp[i] <= data[j]` (ties take left — stability), tail-copy the remaining
 * left elements (right remainder is already in place).
 */
function mergeSource(k: SortElemKind): string {
  return `
export function __sh_merge_${k}(data, tmp, lo: number, mid: number, hi: number): void {
  let leftLen: number = mid - lo;
  if (leftLen <= 0) return;
  __arri_copy_${k}(tmp, 0, data, lo, leftLen);
  let i: number = 0;
  let j: number = mid;
  let kk: number = lo;
  while (i < leftLen && j < hi) {
    if (__arri_get_${k}(tmp, i) <= __arri_get_${k}(data, j)) {
      __arri_set_${k}(data, kk, __arri_get_${k}(tmp, i));
      i = i + 1;
    } else {
      __arri_set_${k}(data, kk, __arri_get_${k}(data, j));
      j = j + 1;
    }
    kk = kk + 1;
  }
  if (i < leftLen) {
    __arri_copy_${k}(data, kk, tmp, i, leftLen - i);
  }
  return;
}
`;
}

/**
 * Merge the runs at stack[idx] and stack[idx+1], shift the stack left,
 * return the new stack size. Mirrors the hand `__merge_run_<k>` (the stack
 * shift copies from idx+2.. to idx+1.. with count stackSize-idx-2 — the
 * same overlap-safe `array.copy` the hand body used).
 */
function mergeRunSource(k: SortElemKind): string {
  return `
export function __sh_merge_run_${k}(data, tmp, sBase, sLen, stackSize: number, idx: number): number {
  let base1: number = __arri_get_f64(sBase, idx);
  let len1: number = __arri_get_f64(sLen, idx);
  let len2: number = __arri_get_f64(sLen, idx + 1);
  __sh_merge_${k}(data, tmp, base1, base1 + len1, base1 + len1 + len2);
  __arri_set_f64(sLen, idx, len1 + len2);
  __arri_copy_f64(sBase, idx + 1, sBase, idx + 2, stackSize - idx - 2);
  __arri_copy_f64(sLen, idx + 1, sLen, idx + 2, stackSize - idx - 2);
  return stackSize - 1;
}
`;
}

/**
 * Main Timsort driver over (data, len). Mirrors the hand `__timsort_<k>`
 * section-for-section: early return, small-array isort (< 64), minRun
 * computation (bitwise, same `|=` / `>>>` ops the hand loop used), buffer
 * allocation (85-deep run stack), run detection with descending-run
 * reversal, short-run extension via isort, stack push, invariant-driven
 * merge collapse, and the final force collapse.
 *
 * NaN note (f64): run detection continues an ascending run while
 * `!(data[runEnd] < data[runEnd-1])` — the exact negated-`<` the hand body
 * expressed as `ltOp; eqz; br_if`, so NaN (all compares false) extends
 * ascending runs and stops descending runs identically.
 */
function timsortMainSource(k: SortElemKind): string {
  return `
export function __sh_timsort_${k}(data, len: number): void {
  if (len < 2) return;
  if (len < 64) {
    __sh_isort_${k}(data, 0, len);
    return;
  }
  let nmr: number = len;
  let rmr: number = 0;
  while (nmr >= 64) {
    rmr = rmr | (nmr & 1);
    nmr = nmr >>> 1;
  }
  let minRun: number = nmr + rmr;
  let tmp = __arri_new_${k}(len);
  let sBase = __arri_new_f64(85);
  let sLen = __arri_new_f64(85);
  let stackSize: number = 0;
  let lo: number = 0;
  while (lo < len) {
    let runEnd: number = lo + 1;
    let runLen: number = 0;
    if (runEnd >= len) {
      runLen = 1;
    } else {
      if (__arri_get_${k}(data, runEnd) < __arri_get_${k}(data, lo)) {
        runEnd = runEnd + 1;
        while (runEnd < len && __arri_get_${k}(data, runEnd) < __arri_get_${k}(data, runEnd - 1)) {
          runEnd = runEnd + 1;
        }
        let iRev: number = lo;
        let jRev: number = runEnd - 1;
        while (iRev < jRev) {
          let tSwap = __arri_get_${k}(data, iRev);
          __arri_set_${k}(data, iRev, __arri_get_${k}(data, jRev));
          __arri_set_${k}(data, jRev, tSwap);
          iRev = iRev + 1;
          jRev = jRev - 1;
        }
      } else {
        runEnd = runEnd + 1;
        while (runEnd < len && !(__arri_get_${k}(data, runEnd) < __arri_get_${k}(data, runEnd - 1))) {
          runEnd = runEnd + 1;
        }
      }
      runLen = runEnd - lo;
    }
    let force: number = minRun;
    if (len - lo < force) {
      force = len - lo;
    }
    if (runLen < force) {
      __sh_isort_${k}(data, lo, lo + force);
      runLen = force;
    }
    __arri_set_f64(sBase, stackSize, lo);
    __arri_set_f64(sLen, stackSize, runLen);
    stackSize = stackSize + 1;
    while (stackSize >= 2) {
      let sn: number = stackSize - 2;
      let should: number = 0;
      let mergeIdx: number = sn;
      if (sn > 0) {
        if (__arri_get_f64(sLen, sn - 1) <= __arri_get_f64(sLen, sn) + __arri_get_f64(sLen, sn + 1)) {
          should = 1;
          if (__arri_get_f64(sLen, sn - 1) < __arri_get_f64(sLen, sn + 1)) {
            mergeIdx = sn - 1;
          }
        } else {
          if (__arri_get_f64(sLen, sn) <= __arri_get_f64(sLen, sn + 1)) {
            should = 1;
          }
        }
      } else {
        if (__arri_get_f64(sLen, sn) <= __arri_get_f64(sLen, sn + 1)) {
          should = 1;
        }
      }
      if (should === 0) {
        break;
      }
      stackSize = __sh_merge_run_${k}(data, tmp, sBase, sLen, stackSize, mergeIdx);
    }
    lo = lo + runLen;
  }
  while (stackSize >= 2) {
    let sn: number = stackSize - 2;
    let mergeIdx: number = sn;
    if (sn > 0) {
      if (__arri_get_f64(sLen, sn - 1) < __arri_get_f64(sLen, sn + 1)) {
        mergeIdx = sn - 1;
      }
    }
    stackSize = __sh_merge_run_${k}(data, tmp, sBase, sLen, stackSize, mergeIdx);
  }
  return;
}
`;
}

/**
 * The four kernels for one element kind, in leaf-first emission order
 * (each kernel's `callees` are registered before it is emitted).
 */
export function timsortKernelDefs(k: SortElemKind): readonly TimsortKernelDef[] {
  const get = `__arri_get_${k}`;
  const set = `__arri_set_${k}`;
  const alloc = `__arri_new_${k}`;
  const copy = `__arri_copy_${k}`;
  // f64-array intrinsics serve the run stack; for k === "f64" they coincide
  // with the element intrinsics (same canonical f64 array type).
  const stackOps = k === "f64" ? [] : ["__arri_get_f64", "__arri_set_f64", "__arri_new_f64", "__arri_copy_f64"];
  return [
    {
      name: `__sh_isort_${k}`,
      source: isortSource(k),
      params: ["data", "num", "num"],
      ret: null,
      callees: [get, set],
    },
    {
      name: `__sh_merge_${k}`,
      source: mergeSource(k),
      params: ["data", "data", "num", "num", "num"],
      ret: null,
      callees: [get, set, copy],
    },
    {
      name: `__sh_merge_run_${k}`,
      source: mergeRunSource(k),
      params: ["data", "data", "stack", "stack", "num", "num"],
      ret: "num",
      callees: [
        `__sh_merge_${k}`,
        ...(k === "f64" ? [get, set, copy] : ["__arri_get_f64", "__arri_set_f64", "__arri_copy_f64"]),
      ],
    },
    {
      name: `__sh_timsort_${k}`,
      source: timsortMainSource(k),
      params: ["data", "num"],
      ret: null,
      callees: [`__sh_isort_${k}`, `__sh_merge_run_${k}`, get, set, alloc, copy, ...stackOps],
    },
  ];
}
