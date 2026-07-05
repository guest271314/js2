// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3053 U0 — the unified dynamic-reader carrier substrate `__dyn_member_get`.
//
// U0 BUILDS the helper only; nothing in the compiler calls it yet (U1 wires it
// into the IR member-read). So the primitive is byte-inert in every normal
// compile — the `ctx.usesDynMemberGet` latch (which U0 never sets) guarantees
// zero emitted bytes. The `JS2WASM_FORCE_DYN_MEMBER_GET=1` escape force-emits
// the helper AND a family of exported `__dmg_*` drivers that exercise the
// carrier round-trip directly (the value can't cross to JS — a `(ref $AnyValue)`
// is an internal GC ref — so the drivers build the receiver, call the helper,
// and return an i32 verdict entirely inside Wasm).
//
// The drivers PROVE, on both standalone (the $AnyValue carrier) and gc/host (the
// externref carrier):
//   - object read → tag-6, identity-preserving (aliased reads ARE ===, distinct
//     objects are NOT — no coincidental pass);
//   - string read → tag-5, content-=== preserved;
//   - number read → tag-3, value-=== preserved;
//   - boolean read → tag-4;
//   - a RE-READ `__dyn_member_get(__dyn_member_get(o,"a"),"z")` returns the right
//     value + tag — proving the INTERNAL `__carrier_recv_to_extern` peel round-
//     trips (the CS1a `__any_to_extern` tag-6 breaker is NOT re-triggered).
//
// The shared source references every key ("a"/"b"/"s"/"n"/"bo"/"z") via a dynamic
// read so those string constants are pooled before finalize (the drivers reuse
// them; no finalize-time string-import addition), and pulls in the object runtime
// (`__new_plain_object`, the write path, `__box_*`) the drivers depend on. The
// drivers compare via direct carrier-field ref.eq / f64.eq (standalone) and a
// non-null probe (host), so no engine coercion helper is invoked from dyn-read.ts
// (keeps the #2108 coercion-drift gate at 0).

import { describe, it, expect, beforeAll } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Force-emit the U0 helper + self-test drivers ONLY for the duration of a single
// compile, then restore. Scoping the env this tightly (rather than for the whole
// file via beforeAll/afterAll) prevents any cross-test contamination if CI runs
// test files in a shared worker where `process.env` is process-global.
async function compileForced(source: string, opts?: Parameters<typeof compile>[1]) {
  const prev = process.env.JS2WASM_FORCE_DYN_MEMBER_GET;
  process.env.JS2WASM_FORCE_DYN_MEMBER_GET = "1";
  try {
    return await compile(source, opts);
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "JS2WASM_FORCE_DYN_MEMBER_GET");
    else process.env.JS2WASM_FORCE_DYN_MEMBER_GET = prev;
  }
}

// The source pools every driver key ("a"/"b"/"s"/"n"/"bo"/"z") via a dynamic
// read, and pulls in the natives the drivers use in EACH mode: the object
// runtime (`__new_plain_object`), the write path (`__extern_set` in standalone,
// `__extern_set_strict` in host — pulled by `o.b = o.a`), `__any_strict_eq` /
// `__host_eq` (via `===`), `__box_*`, and `__unbox_number` (via `o.n + 0`).
const SOURCE = `export function run(): number {
  const o: any = { a: {}, b: {}, s: "ab", n: 42, bo: true, z: 7 };
  o.b = o.a;
  let acc = 0;
  if (o.a === o.b) acc = acc + 1;
  if (o.s === o.s) acc = acc + 1;
  if (o.n === o.n) acc = acc + 1;
  if (o.bo === o.bo) acc = acc + 1;
  if (o.z === o.z) acc = acc + 1;
  acc = acc + (o.n + 0);
  return acc;
}`;

async function standaloneExports(): Promise<Record<string, () => number>> {
  // (#3053 U2) The gc `$AnyValue` `__dyn_member_get` body (and its `__dmg_st_*`
  // self-test drivers) is keyed on `ctx.fast` — matching the carrier decision in
  // `resolveDynamic`/`makeDynamicLowering`. `--target standalone` alone sets
  // `standalone:true` but leaves `fast:false`, which now (correctly) selects the
  // externref host-wrapper body; the gc carrier path needs `fast:true`.
  const r = await compileForced(SOURCE, { target: "standalone", fast: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Host-free: a leaked `env` import would mean the case ran on a JS host path.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "standalone module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

async function gcExports(): Promise<Record<string, () => number>> {
  const r = await compileForced(SOURCE); // default target: "gc" (host mode)
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "gc module must be valid Wasm").toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: Record<string, unknown>) => void }).setExports?.(
    instance.exports as Record<string, unknown>,
  );
  return instance.exports as Record<string, () => number>;
}

describe("#3053 U0 — __dyn_member_get carrier round-trip (standalone / $AnyValue)", () => {
  let exp: Record<string, () => number>;
  beforeAll(async () => {
    exp = await standaloneExports();
  });

  it("emits the helper under FORCE (drivers are exported)", () => {
    expect(typeof exp.__dmg_st_object_tag).toBe("function");
    expect(typeof exp.__dmg_st_reread).toBe("function");
  });

  it("object read → tag-6", () => {
    expect(exp.__dmg_st_object_tag!()).toBe(6);
  });

  it("object read is identity-preserving: aliased reads ARE ===", () => {
    expect(exp.__dmg_st_object_identity!()).toBe(1);
  });

  it("anti-vacuity: distinct objects are NOT === (assertions bite)", () => {
    expect(exp.__dmg_st_object_distinct!()).toBe(0);
  });

  it("string read → tag-5", () => {
    expect(exp.__dmg_st_string_tag!()).toBe(5);
  });

  it("string read is value-preserving (content ===)", () => {
    expect(exp.__dmg_st_string_value!()).toBe(1);
  });

  it("number read → tag-3", () => {
    expect(exp.__dmg_st_number_tag!()).toBe(3);
  });

  it("number read is value-preserving (===)", () => {
    expect(exp.__dmg_st_number_value!()).toBe(1);
  });

  it("boolean read → tag-4", () => {
    expect(exp.__dmg_st_boolean_tag!()).toBe(4);
  });

  it("RE-READ dmg(dmg(o,'a'),'z') composes: tag-3 value 7 (peel round-trips)", () => {
    // 3 * 1000 + 7 — the internal __carrier_recv_to_extern peel is NOT the
    // __any_to_extern tag-6 breaker, so the second read finds inner.z.
    expect(exp.__dmg_st_reread!()).toBe(3007);
  });
});

describe("#3053 U0 — __dyn_member_get carrier round-trip (gc / host externref)", () => {
  let exp: Record<string, () => number>;
  beforeAll(async () => {
    exp = await gcExports();
  });

  it("emits the host helper under FORCE", () => {
    expect(typeof exp.__dmg_gc_present).toBe("function");
  });

  it("host wrapper executes end-to-end: a present-key read is non-null (1)", () => {
    // Marshalling-independent: the driver reports ref.is_null==0 as an i32, so it
    // proves the host `__dyn_member_get` (a thin __extern_get wrapper) is emitted,
    // valid, and reads a set property without trapping.
    expect(exp.__dmg_gc_present!()).toBe(1);
  });
});
