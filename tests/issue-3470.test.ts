// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3470) extends #3318. test262's verifyProperty() (harness/
// propertyHelper.js:63-66 asserts __hasOwnProperty(obj, name); the
// destructive probe is isConfigurable() at line 140, `delete obj[name]`)
// probes configurable:true via `delete obj[name]` without a `restore`
// option for built-ins/**/name.js and length.js tests. When `obj` is a
// prototype METHOD (e.g. Date.prototype.getYear), the delete removes THAT
// FUNCTION's own "name"/"length" sub-property -- a mutation the pre-#3470
// restoreHostBuiltins() never caught (it restores method VALUES/identity,
// not a method's own sub-properties), and Date/TypedArray/DataView weren't
// even in its PROTOS list. The auto-generated strict-mode rerun (same
// process, same realm) then saw the missing sub-property and failed "obj
// should have an own property name"/"length".
//
// IMPORTANT (found during implementation, see #3471): the cited sample
// files do NOT reach a full "pass" after this fix, even in-process. Fixing
// the "own property" masking unblocks verifyProperty()'s NEXT destructive
// probe (isWritable(), which runs BEFORE isConfigurable() in
// propertyHelper.js) -- and that hits a SEPARATE, deeper, genuine COMPILER
// bug (#3471: a strict-mode assignment to a non-writable host property
// throws TypeError correctly, but the compiled try/catch doesn't catch it
// as `instanceof TypeError`). That bug is unconditional (fires on a fresh,
// never-mutated realm too), which is why it's already the DOMINANT
// observed failure on the real CI baseline for this whole test family --
// independent of this issue's fix. So these end-to-end tests assert the
// NARROWER, honest claim this fix actually delivers: the "own property"
// signature is gone (proving the sub-prop restore mechanism works
// end-to-end, not just at the unit level), not a full pass (blocked on
// #3471).
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

// Sample cited files from the host<->standalone parity investigation
// (Cluster C2 name/length sub-family).
const CITED_NAME_TESTS = [
  "annexB/built-ins/Date/prototype/getYear/name.js",
  "annexB/built-ins/RegExp/prototype/compile/name.js",
  "annexB/built-ins/String/prototype/substr/name.js",
] as const;

// Additional coverage: TypedArray/DataView, which the pre-fix PROTOS list
// omitted entirely (not just the name/length sub-prop gap).
const TYPED_ARRAY_DATAVIEW_TESTS = [
  "built-ins/TypedArray/prototype/forEach/name.js",
  "built-ins/DataView/prototype/getFloat64/name.js",
  "built-ins/DataView/name.js",
] as const;

const OWN_PROPERTY_SIGNATURE = /should have an own property/;

describe("#3470 host verifyProperty name/length realm-isolation restore", () => {
  /**
   * The fix's actual, verifiable claim: the strict rerun no longer fails on
   * the "obj should have an own property name/length" masking signature.
   * Does NOT assert `status: "pass"` -- see #3471 for the separate, deeper
   * compiler bug (isWritable()'s non-writable-assignment TypeError isn't
   * caught by compiled code) that these same files hit next, unblocked by
   * this fix but not fixed by it.
   */
  async function expectNoOwnPropertyMasking(path: string) {
    const result = await runTest262File(resolve("test262/test", path), path.split("/")[0]!);
    restoreHostBuiltins();
    expect(result.file).toBe(`test/${path}`);
    expect(String(result.error ?? ""), `${path} must not fail on the own-property masking signature`).not.toMatch(
      OWN_PROPERTY_SIGNATURE,
    );
  }

  it("cited annexB name.js tests no longer fail on 'own property' masking (unblocked, see #3471 for the next layer)", async () => {
    for (const path of CITED_NAME_TESTS) {
      await expectNoOwnPropertyMasking(path);
    }
  }, 120_000);

  it("TypedArray/DataView name.js tests no longer fail on 'own property' masking (previously-missing PROTOS entries)", async () => {
    for (const path of TYPED_ARRAY_DATAVIEW_TESTS) {
      await expectNoOwnPropertyMasking(path);
    }
  }, 120_000);

  it("running the same name.js test twice in one process: the second run does not re-see the masking either (cross-run restore, not just intra-run)", async () => {
    const path = CITED_NAME_TESTS[0];
    await expectNoOwnPropertyMasking(path);
    await expectNoOwnPropertyMasking(path);
  }, 120_000);

  it("restoreHostBuiltins() restores a deleted Date.prototype method's own .name", () => {
    const before = Object.getOwnPropertyDescriptor(Date.prototype.getYear, "name");
    expect(before?.value).toBe("getYear");
    // biome-ignore lint/performance/noDelete: must remove the own property (not set undefined) to model verifyProperty's isConfigurable() probe.
    delete (Date.prototype.getYear as unknown as Record<string, unknown>).name;
    expect(Object.getOwnPropertyDescriptor(Date.prototype.getYear, "name")).toBeUndefined();
    restoreHostBuiltins();
    expect(Object.getOwnPropertyDescriptor(Date.prototype.getYear, "name")).toEqual(before);
  });

  it("restoreHostBuiltins() restores a deleted TypedArray prototype method's own .length", () => {
    const fn = Int8Array.prototype.subarray;
    const before = Object.getOwnPropertyDescriptor(fn, "length");
    // biome-ignore lint/performance/noDelete: must remove the own property (not set undefined) to model verifyProperty's isConfigurable() probe.
    delete (fn as unknown as Record<string, unknown>).length;
    expect(Object.getOwnPropertyDescriptor(fn, "length")).toBeUndefined();
    restoreHostBuiltins();
    expect(Object.getOwnPropertyDescriptor(fn, "length")).toEqual(before);
  });

  it("restoreHostBuiltins() restores a deleted DataView prototype method's own .name", () => {
    const fn = DataView.prototype.getInt8;
    const before = Object.getOwnPropertyDescriptor(fn, "name");
    // biome-ignore lint/performance/noDelete: must remove the own property (not set undefined) to model verifyProperty's isConfigurable() probe.
    delete (fn as unknown as Record<string, unknown>).name;
    expect(Object.getOwnPropertyDescriptor(fn, "name")).toBeUndefined();
    restoreHostBuiltins();
    expect(Object.getOwnPropertyDescriptor(fn, "name")).toEqual(before);
  });

  it("restoreHostBuiltins() restores a deleted constructor's own .name (e.g. Date.name)", () => {
    const before = Object.getOwnPropertyDescriptor(Date, "name");
    expect(before?.value).toBe("Date");
    // biome-ignore lint/performance/noDelete: must remove the own property (not set undefined) to model verifyProperty's isConfigurable() probe.
    delete (Date as unknown as Record<string, unknown>).name;
    expect(Object.getOwnPropertyDescriptor(Date, "name")).toBeUndefined();
    restoreHostBuiltins();
    expect(Object.getOwnPropertyDescriptor(Date, "name")).toEqual(before);
  });
});
