// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2984 — boolean-typed DYNAMIC property reads must not narrow through the
// numeric unbox pipeline.
//
// Defect: a property access whose TS type is boolean-like (the lib shape
// `PropertyDescriptor.writable?: boolean` → `boolean | undefined`) and whose
// receiver resolves through the dynamic fallback (`__extern_get` host-MOP read)
// was narrowed to i32 via `__unbox_number` + `i32.trunc_sat_f64_s`. That
// pipeline is a ToNumber, not a boolean read: the standalone native
// `__unbox_number` yields NaN for a boxed boolean (→ i32 0), and an any-context
// consumer then RE-boxed the 0 as a NUMBER. Net effect:
//   assert.sameValue(Object.getOwnPropertyDescriptor(o, k).writable, true)
// failed for EVERY descriptor-attribute assertion in the standalone test262
// gOPD cluster (41 flips in built-ins/Object/getOwnPropertyDescriptor* alone,
// +32 in built-ins/Object/defineProperty). The host lane only "passed" the
// harness shape by a double coincidence (host ToNumber(true)=1, then a numeric
// compare) and still failed the local-bound shape (`var w = desc.writable;
// typeof w` was "undefined" on BOTH lanes).
//
// Fix: in `compilePropertyAccess`'s dynamic-fallback region, a boolean-like
// access type keeps the raw externref (preserving both the boolean box and
// `undefined` for an absent attribute) instead of narrowing to i32.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function runHost(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as { test(): number }).test();
}

// The test262 harness shape: descriptor attributes flow as `any`-typed
// function arguments into assert.sameValue-style strict comparisons.
const HARNESS_SHAPE_PLAIN = `
  var hits = 0;
  var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
  var desc = Object.getOwnPropertyDescriptor({ x: 5 }, "x");
  check(desc.writable, true);
  check(desc.enumerable, true);
  check(desc.configurable, true);
  check(desc.value, 5);
  return hits;
`;

const HARNESS_SHAPE_BUILTIN_PROTO = `
  var hits = 0;
  var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
  var desc = Object.getOwnPropertyDescriptor(Array.prototype, "concat");
  check(desc.writable, true);
  check(desc.enumerable, false);
  check(desc.configurable, true);
  return hits;
`;

// Local-bound shape: reading the attribute into an untyped local must keep the
// boolean (typeof was "undefined" on BOTH lanes before the fix).
const LOCAL_BOUND_TYPEOF = `
  var desc = Object.getOwnPropertyDescriptor({ x: 5 }, "x");
  var w = desc.writable;
  if (typeof w === "boolean") return 1;
  if (typeof w === "undefined") return 2;
  return 3;
`;

// Absent attribute: an accessor descriptor has NO writable key — the read must
// surface `undefined` (the old i32 narrowing erased it to `false`).
const ABSENT_ATTR_UNDEFINED = `
  var obj = { get x() { return 1; } };
  var desc = Object.getOwnPropertyDescriptor(obj, "x");
  var w = desc.writable;
  if (typeof w === "undefined") return 1;
  return 0;
`;

describe("#2984 — boolean-typed dynamic property reads (descriptor attributes)", () => {
  it("standalone: harness-shape attribute asserts on a plain-object descriptor", async () => {
    expect(await runStandalone(HARNESS_SHAPE_PLAIN)).toBe(4);
  });

  it("host: harness-shape attribute asserts on a plain-object descriptor", async () => {
    expect(await runHost(HARNESS_SHAPE_PLAIN)).toBe(4);
  });

  it("standalone: harness-shape attribute asserts on a builtin-proto descriptor", async () => {
    expect(await runStandalone(HARNESS_SHAPE_BUILTIN_PROTO)).toBe(3);
  });

  it("standalone: local-bound attribute read keeps typeof boolean", async () => {
    expect(await runStandalone(LOCAL_BOUND_TYPEOF)).toBe(1);
  });

  it("host: local-bound attribute read keeps typeof boolean", async () => {
    expect(await runHost(LOCAL_BOUND_TYPEOF)).toBe(1);
  });

  it("standalone: absent attribute (accessor descriptor .writable) stays undefined", async () => {
    expect(await runStandalone(ABSENT_ATTR_UNDEFINED)).toBe(1);
  });
});

// (#2984) gOPD(this, "NaN"|"Infinity"|"undefined") — the sloppy-mode global
// receiver folds to the spec §19.1.1–19.1.3 all-false value descriptor when
// `this` is nullish at runtime; a REAL receiver keeps the dynamic read.
// Pre-fix these were phantom passes riding the undefined→ToNumber coincidence
// the boolean-read fix retired (the merge_group park on PR #2845).
const GLOBAL_NAN_DESCRIPTOR = `
  var hits = 0;
  var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
  var desc = Object.getOwnPropertyDescriptor(this, "NaN");
  check(desc.writable, false);
  check(desc.enumerable, false);
  check(desc.configurable, false);
  return hits;
`;

// A host-dispatched object-literal method receives a REAL `this` (installed
// via __current_this) — the runtime guard must take the dynamic else-arm and
// find the receiver's OWN "NaN" prop, not the global fold.
const REAL_RECEIVER_KEEPS_DYNAMIC = `
  var o: any = {
    NaN: 42,
    m: function () {
      var d = Object.getOwnPropertyDescriptor(this, "NaN");
      if (d === undefined) return -1;
      return d.value === 42 ? 1 : 0;
    }
  };
  return o.m();
`;

describe("#2984 — gOPD(this, <global value prop>) fold", () => {
  it("standalone: gOPD(this, 'NaN') yields the all-false spec descriptor", async () => {
    expect(await runStandalone(GLOBAL_NAN_DESCRIPTOR)).toBe(3);
  });

  it("host: gOPD(this, 'NaN') yields the all-false spec descriptor", async () => {
    expect(await runHost(GLOBAL_NAN_DESCRIPTOR)).toBe(3);
  });

  it("host: a real receiver with an own 'NaN' prop keeps the dynamic read", async () => {
    expect(await runHost(REAL_RECEIVER_KEEPS_DYNAMIC)).toBe(1);
  });
});
