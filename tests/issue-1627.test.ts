// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1627 — Set new methods (union, intersection, difference, symmetricDifference,
// isSubsetOf, isSupersetOf, isDisjointFrom) must accept any set-like argument
// (object with size + has(v) + keys()), not just Set instances. The native V8
// Set.prototype.union etc. already implement spec GetSetRecord — we just need
// to bridge wasmGC structs through `_wrapForHost` so their sidecar properties
// (`size`, `has`, `keys`) are visible to native JS access.

import { existsSync } from "fs";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runTest(source: string): Promise<number> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error("compile failed: " + r.errors.map((e) => e.message).join("\n"));
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  const fn = instance.exports.test as () => number;
  return fn();
}

describe("#1627 — Set methods accept set-like arguments", () => {
  it("union accepts set-like wasm struct (size + has + keys)", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 2,
          has: (v: number) => false,
          keys: function* () {
            yield 2;
            yield 3;
          },
        };
        const combined = s1.union(s2);
        // Expect {1, 2, 3}
        if (combined.size !== 3) return 1;
        if (!combined.has(1)) return 2;
        if (!combined.has(2)) return 3;
        if (!combined.has(3)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("intersection accepts set-like wasm struct (uses has)", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        s1.add(3);
        const s2 = {
          size: 5,
          has: (v: number) => v === 2 || v === 3 || v === 4,
          keys: function* () {
            yield 2;
            yield 3;
          },
        };
        // s1.size <= s2.size → iterate s1, keep those s2.has accepts
        const result = s1.intersection(s2);
        if (result.size !== 2) return 1;
        if (!result.has(2)) return 2;
        if (!result.has(3)) return 3;
        if (result.has(1)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("difference accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        s1.add(3);
        const s2 = {
          size: 2,
          has: (v: number) => v === 2 || v === 4,
          keys: function* () {
            yield 2;
            yield 4;
          },
        };
        const result = s1.difference(s2);
        // {1, 2, 3} - {2, 4} = {1, 3}
        if (result.size !== 2) return 1;
        if (!result.has(1)) return 2;
        if (!result.has(3)) return 3;
        if (result.has(2)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("isSubsetOf accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 4,
          has: (v: number) => v >= 1 && v <= 4,
          keys: function* () {
            yield 1;
            yield 2;
            yield 3;
            yield 4;
          },
        };
        // {1,2} ⊆ {1,2,3,4}
        if (!s1.isSubsetOf(s2)) return 1;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("isDisjointFrom accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 2,
          has: (v: number) => v === 3 || v === 4,
          keys: function* () {
            yield 3;
            yield 4;
          },
        };
        // {1,2} disjoint from {3,4}
        if (!s1.isDisjointFrom(s2)) return 1;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("symmetricDifference accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 2,
          has: (v: number) => v === 2 || v === 3,
          keys: function* () {
            yield 2;
            yield 3;
          },
        };
        // {1,2} ⊕ {2,3} = {1,3}
        const result = s1.symmetricDifference(s2);
        if (result.size !== 2) return 1;
        if (!result.has(1)) return 2;
        if (!result.has(3)) return 3;
        if (result.has(2)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });
});

// ── GetSetRecord argument-validation flips (the actual #1627 host-mode fix) ──
//
// The receiver crosses to the host as a real JS `Set`, so native V8's
// `Set.prototype[m]` runs the spec `GetSetRecord(other)` on the WasmGC-struct
// argument. The historical bridge wrapped the arg with the `_wrapForHost` proxy,
// whose generic `__call_fn_N` fallback masks EVERY struct field as a callable
// `closureBridge` — so a non-callable `has = {}` looked callable (no TypeError)
// and a `{valueOf(){…}}` size looked like a function (never ToNumber-coerced).
//
// The scoped `_setLikeRecordForHost` adapter (runtime.ts), used ONLY by the 7
// set-algebra methods, reads each GetSetRecord field RAW (via the extracted
// `_resolveHostField`) and presents non-closure structs as plain (non-callable)
// objects, so native GetSetRecord's `IsCallable(has)`/`IsCallable(keys)` throws
// and `ToNumber(size)` coercion fire per spec. These test262 files flip
// fail→pass with the adapter.
//
// Out of scope (documented follow-up — separate root cause): class-instance
// set-likes (`allows-set-like-class`, `set-like-class-{order,mutation}`), the
// array-with-props case (`set-like-array`), and `set-like-iter-return` — those
// need the host to resolve anonymous-class-instance prototype members / array
// dynamic props / iterator `return`, not this adapter.
const TEST262 = "/workspace/test262";
const SET_PROTO = `${TEST262}/test/built-ins/Set/prototype`;
const SET_METHODS = [
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
];
const VALIDATION_CASES = ["has-is-callable.js", "keys-is-callable.js", "size-is-a-number.js"];

const maybe = existsSync(TEST262) ? describe : describe.skip;

maybe("#1627 — GetSetRecord validation on object-literal set-like args (host mode)", () => {
  for (const meth of SET_METHODS) {
    for (const rel of VALIDATION_CASES) {
      const file = `${SET_PROTO}/${meth}/${rel}`;
      if (!existsSync(file)) continue; // not every method ships every case
      it(`${meth}/${rel}`, async () => {
        const r = await runTest262File(file, "built-ins/Set");
        expect(r.status, `reason: ${(r as { reason?: string }).reason ?? ""}`).toBe("pass");
      });
    }
  }
});

// ── #2761 sub-cause B: set-like ARRAY argument ──
//
// `const s2 = [5, 6]; s2.size = 3; s2.has = fn; s2.keys = fn;` — an array
// consumed as a set-like, not as an array. The vec crosses to the host as a
// materialized plain JS array (`__make_iterable`'s `convertToJS`), which copied
// only the ELEMENTS and dropped the dynamic `size`/`has`/`keys` sidecar props, so
// native GetSetRecord read `size = undefined → NaN` and rejected the set-like.
// `_copyVecSidecarOntoArray` now surfaces those props onto the materialized array.
maybe("#2761 B — set-like-array argument (host mode)", () => {
  for (const meth of SET_METHODS) {
    const file = `${SET_PROTO}/${meth}/set-like-array.js`;
    if (!existsSync(file)) continue;
    it(`${meth}/set-like-array`, async () => {
      const r = await runTest262File(file, "built-ins/Set");
      expect(r.status, `reason: ${(r as { reason?: string }).reason ?? ""}`).toBe("pass");
    });
  }
});

// ── #2761 sub-cause C: set-like keys() iterator with a `return()` close ──
//
// `keys()` returns a `{ next(){…}, return(){…} }` object literal (not a
// generator); native V8 drives it as a spec iterator record and closes it on
// early exit (IteratorClose → Get(iter, "return")). The compiled iterator's
// `next`/`return` are wasm-closure struct fields, opaque to the host ("string
// 'next' is not a function"). `_setLikeRecordForHost` now routes the keys()
// result through `_iteratorRecordForHost`, bridging next/return/throw callable.
maybe("#2761 C — set-like keys() iterator-return (host mode)", () => {
  for (const meth of ["isSupersetOf", "isDisjointFrom"]) {
    const file = `${SET_PROTO}/${meth}/set-like-iter-return.js`;
    if (!existsSync(file)) continue;
    it(`${meth}/set-like-iter-return`, async () => {
      const r = await runTest262File(file, "built-ins/Set");
      expect(r.status, `reason: ${(r as { reason?: string }).reason ?? ""}`).toBe("pass");
    });
  }
});
