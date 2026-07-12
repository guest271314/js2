// (#3149) Standalone `Map.groupBy(...).get(k)` hands back a `$ObjVec` group
// value stored in the `$Map` as an anyref (unlike `Object.groupBy`, whose group
// is read via `__extern_get` → externref). When that anyref group flowed into an
// `any[]`-typed parameter — exactly what the test262 harness `compareArray(a:
// any[], …)` forces — the `anyref → ref/ref_null <vec>` coercion did a guarded
// `ref.test`/`ref.cast` and, on the miss (an `$ObjVec` is not the WasmGC `$vec`
// struct), dropped to `ref.null` + `ref.as_non_null`, NULL-DEREF-TRAPPING the
// moment `a.length` was read ("dereferencing a null pointer in
// assert_compareArray"). The `externref → ref` arm already materialized via
// `buildVecFromExternref`; the anyref arms did not.
//
// Fix (type-coercion.ts): when the coercion target is a VEC struct and the
// direct cast misses, materialize a real vec by reading the indexable source
// through `__extern_length`/`__extern_get_idx` (`buildVecFromExternref`, after
// `extern.convert_any`). Non-vec struct targets keep the null fallback.
//
// Driven through the real test262 harness (`runTest262File`, standalone lane) —
// the null-deref only reproduces under the harness's `any[]`-typed
// `assert_compareArray` shim, and standalone is the affected target.

import { describe, it, expect } from "vitest";
import { join } from "path";
import { runTest262File } from "./test262-runner.ts";

const ROOT = join(__dirname, "..", "test262");

async function expectStandalonePass(rel: string) {
  const r = await runTest262File(join(ROOT, rel), "built-ins", 20000, "standalone");
  expect(r.status, `${rel}: ${r.reason ?? r.error ?? ""}`).toBe("pass");
}

describe("#3149 Map.groupBy group value survives the harness any[] coercion (standalone)", () => {
  it("negativeZero.js — -0/+0 canonical key + compareArray on the group", async () => {
    await expectStandalonePass("test/built-ins/Map/groupBy/negativeZero.js");
  });

  it("evenOdd.js — number-element groups compared via compareArray", async () => {
    await expectStandalonePass("test/built-ins/Map/groupBy/evenOdd.js");
  });

  it("groupLength.js — grouped-by-length groups compared via compareArray", async () => {
    await expectStandalonePass("test/built-ins/Map/groupBy/groupLength.js");
  });
});
