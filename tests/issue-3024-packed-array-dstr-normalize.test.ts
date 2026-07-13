// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3024 slice 5 — packed i8/i16 carrier arm in the array-destructuring source
 * normalizer emitted INVALID Wasm.
 *
 * Shape: an `any`/externref-typed array-destructuring SOURCE (a for-of loop var
 * `[ta, length]` over a heterogeneous `[TypedArray, number]` tuple array, or a
 * function param) is normalized to a uniform externref vec by
 * `destructureParamArray` (`src/codegen/destructuring-params.ts`). That
 * normalizer enumerates EVERY registered vec carrier (`ctx.vecTypeMap`) and, per
 * carrier, emits a `ref.test`/`if` runtime-dispatch arm that copies the source's
 * elements into a fresh externref array. When a PACKED (i8/i16) carrier is
 * registered — the byte store of a typed array / resizable ArrayBuffer, e.g.
 * `test262/harness/resizableArrayBufferUtils.js`'s `ctors` — its arm read the
 * element with a plain `array.get` and boxed with `extern.convert_any`. Both are
 * invalid on a packed array ("array.get: Array type N has packed type i8. Use
 * array.get_s or array.get_u instead."), so the WHOLE module failed validation
 * even though that arm is dead for a heterogeneous-tuple source.
 *
 * Fix: the packed carrier arm reads unsigned-extended (`array.get_u`) and boxes
 * the zero-extended i32 via `__box_number` (mirrors the R4 dynamic-dispatch
 * chokepoint `object-runtime.ts` `packedElemReadBox`). Non-packed carriers keep
 * the byte-identical `array.get` + boxing.
 *
 * These 8 real test262 files were `compile_error` (invalid Wasm) on main; the fix
 * eliminates the validation failure. They now run — and `fail` on a DISTINCT,
 * unimplemented resizable-ArrayBuffer semantic (`CreateResizableArrayBuffer` /
 * the RAB constructor), which is out of scope here. The regression guard is
 * therefore `status !== "compile_error"` (the invalid-Wasm is gone), not `pass`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.ts";

const T262 = join(process.cwd(), "test262");

// The 8 default-lane (gc) files whose `array.get` on a packed carrier failed
// validation before the fix.
const FILES: [rel: string, category: string][] = [
  ["test/built-ins/TypedArray/prototype/length/resized-out-of-bounds-1.js", "built-ins/TypedArray"],
  ["test/built-ins/TypedArray/prototype/length/resized-out-of-bounds-2.js", "built-ins/TypedArray"],
  ["test/built-ins/TypedArray/prototype/byteOffset/resized-out-of-bounds.js", "built-ins/TypedArray"],
  ["test/built-ins/TypedArray/prototype/byteLength/resized-out-of-bounds-1.js", "built-ins/TypedArray"],
  ["test/built-ins/TypedArray/prototype/byteLength/resized-out-of-bounds-2.js", "built-ins/TypedArray"],
  ["test/built-ins/TypedArray/prototype/entries/resizable-buffer.js", "built-ins/TypedArray"],
  ["test/built-ins/Array/prototype/entries/resizable-buffer.js", "built-ins/Array"],
  ["test/language/destructuring/binding/typedarray-backed-by-resizable-buffer.js", "language/destructuring"],
];

describe("#3024 slice 5 — packed carrier in array-destructuring normalizer", () => {
  it.runIf(existsSync(T262))(
    "8 resizable-ArrayBuffer test262 files no longer emit invalid Wasm (were compile_error)",
    async () => {
      for (const [rel, category] of FILES) {
        const abs = join(T262, rel);
        if (!existsSync(abs)) continue; // tolerate submodule pathing drift
        const r = await runTest262File(abs, category, 20000);
        // The regression is a *validation* failure surfacing as compile_error with
        // a packed-array `array.get` message. Assert that class of error is gone.
        const msg = String(r.error ?? r.reason ?? "");
        expect(r.status, `${rel}: ${r.status} — ${msg}`).not.toBe("compile_error");
        expect(msg).not.toMatch(/has packed type|array\.get_s or array\.get_u/);
      }
    },
    60000,
  );
});
