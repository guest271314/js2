// #2029 (global-index `-1` sentinel sub-bucket) — `SuppressedError` and the two
// Disposable-stack ERM constructors, read as VALUES or via `.prototype.*` under
// `--target standalone`, must NOT emit `global.get -1` ("global index out of
// range — -1") at serialize time. Two distinct producers, both rooted in the
// `-1` string-global sentinel that standalone/nativeStrings records for an
// un-materialized string constant:
//
//  1. `SuppressedError.prototype.<member>` fell through both the standalone
//     native-proto path and the host `__get_builtin` fallback into a generic
//     member path that pushed a raw `global.get <stringGlobalMap.get>` — fixed
//     by listing `SuppressedError` in `BUILTIN_CTOR_NAMES` (property-access.ts),
//     routing it to the dual-mode handler (clean located refusal standalone,
//     `__get_builtin` under gc/host) — same as the DisposableStack pair (#2029).
//  2. The ERM ctors read as bare VALUES (`Object.getPrototypeOf(SuppressedError)`,
//     `isConstructor(DisposableStack)`) took a HOST-ONLY fast path
//     (`__get_globalThis` + `__extern_get`, identifiers.ts) that both leaked two
//     host imports AND pushed the ctor-name key via the `-1` string-global
//     sentinel — fixed by gating that fast path to gc/host (`!standalone &&
//     !wasi`); standalone falls through to the clean path.
//
// Acceptance: NO `index out of range` / `Binary emit error` for these shapes
// standalone (the whole-file-lost encoder crash); gc/host mode unchanged.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return (await compile(src, { target: "standalone" })) as any;
}

function noEmitCrash(r: any): void {
  // The defining failure of this bucket is the encoder RangeError, surfaced as a
  // compile error whose message contains "index out of range" / "Binary emit
  // error". A clean located refusal (reportError) is acceptable — it is NOT an
  // emit crash. So we assert specifically that no emit-crash message is present.
  const msgs: string[] = (r.errors ?? []).map((e: any) => e.message);
  expect(msgs.some((m) => /index out of range|Binary emit error/.test(m))).toBe(false);
}

describe("#2029 — SuppressedError / ERM-ctor builtin global-index `-1` sentinel (standalone emit)", () => {
  it("`SuppressedError.prototype.name` no longer emits global.get -1 (clean refusal, not crash)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const n: any = SuppressedError.prototype.name; return n === "SuppressedError" ? 1 : 0; }`,
    );
    noEmitCrash(r);
  });

  it("`Object.getPrototypeOf(SuppressedError)` compiles standalone (was: global.get -1)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const p: any = Object.getPrototypeOf(SuppressedError); return p ? 1 : 0; }`,
    );
    expect(r.success).toBe(true);
    noEmitCrash(r);
  });

  it("`Object.getPrototypeOf(DisposableStack)` compiles standalone (already-listed ctor, bare-value path)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const p: any = Object.getPrototypeOf(DisposableStack); return p ? 1 : 0; }`,
    );
    expect(r.success).toBe(true);
    noEmitCrash(r);
  });

  it("`Object.getPrototypeOf(AsyncDisposableStack)` compiles standalone", async () => {
    const r = await compileStandalone(
      `export function test(): number { const p: any = Object.getPrototypeOf(AsyncDisposableStack); return p ? 1 : 0; }`,
    );
    expect(r.success).toBe(true);
    noEmitCrash(r);
  });

  it("`new SuppressedError()` still compiles standalone (unaffected by the value-path gate)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const e: any = new SuppressedError(); return e ? 1 : 0; }`,
    );
    expect(r.success).toBe(true);
    noEmitCrash(r);
  });

  it("gc/host mode unaffected — `Object.getPrototypeOf(SuppressedError)` still compiles", async () => {
    const r = (await compile(
      `export function test(): number { const p: any = Object.getPrototypeOf(SuppressedError); return p ? 1 : 0; }`,
    )) as any;
    expect(r.success).toBe(true);
  });
});
