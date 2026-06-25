// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1355 Slice F — Proxy `defineProperty` (§10.5.6 [[DefineOwnProperty]]) trap,
// standalone.
//
// `Object.defineProperty(proxy, k, desc)` and `Reflect.defineProperty(proxy, k,
// desc)` both ultimately route to the native single-descriptor applier
// `__obj_define_from_desc(obj, key, desc)` standalone (the #2046-reused desc
// path). A `ref.test $Proxy` front-guard prepended to that helper diverts a proxy
// receiver to `__proxy_define_dispatch(target, key, desc)`, which reads the
// `defineProperty` trap closure off `$ProxyTraps` (field index 11, appended after
// ownKeys) and invokes it `(target, key, desc)` — the handler bound as `this`,
// the descriptor passed through UNCHANGED — through the `__apply_closure` bridge.
// An absent trap forwards to the ordinary `__obj_define_from_desc` on the target.
//
// The §10.5.6 step-9 trap is `Call(trap, handler, «target, P, descObj»)` and its
// boolean result is the [[DefineOwnProperty]] result. `Reflect.defineProperty`
// surfaces it via `__is_truthy` over the dispatch result (for a non-proxy
// receiver the applier returns the always-truthy obj, so the spec `true` is
// preserved unchanged).
//
// Inline object-literal descriptors (`{ value: 42, … }`) on a *dynamic* (`any`)
// receiver are routed through the desc-runtime applier here too (object-ops.ts)
// — otherwise the inline fast path would store the value directly on the proxy
// externref and never fire the trap. Non-proxy dynamic receivers are unaffected
// (the applier dispatches to the same `__defineProperty_value`/`_accessor` store).
//
// Spec: ECMA-262 §10.5.6 ([[DefineOwnProperty]]).
//
// DEFERRED to the dedicated descriptor-model invariant slice (G, needs
// #797/#1460/#1462) — NOT enforced here, mirroring slices A–E:
//   - present-but-non-callable trap → TypeError (§10.5.6 step 5 GetMethod);
//   - trap-thrown abrupt-completion propagation (shared closure-bridge gap,
//     RE-MEASURE bucket #2617);
//   - the §10.5.6 result-invariants (reject a non-configurable/non-extensible
//     redefine that disagrees with the target's existing descriptor).
//
// NOTE: as in #1100/Slice E, the proxy is bound to a `const p: any` local so the
// member access lowers to the dynamic boundary the untyped JS of test262 takes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1355 standalone Proxy — defineProperty trap (§10.5.6)", () => {
  it("defineProperty trap intercepts Object.defineProperty (inline literal descriptor)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({ a: 1 }, { defineProperty: (t: any, k: any, d: any) => { hit = 1; return true; } });
        Object.defineProperty(p, "x", { value: 42, writable: true, enumerable: true, configurable: true });
        return hit;
      }`),
    ).toBe(1);
  });

  it("defineProperty trap intercepts Object.defineProperty (variable descriptor)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({}, { defineProperty: (t: any, k: any, d: any) => { hit = 1; return true; } });
        const desc: any = { value: 1, configurable: true };
        Object.defineProperty(p, "x", desc);
        return hit;
      }`),
    ).toBe(1);
  });

  it("defineProperty trap intercepts Reflect.defineProperty (inline literal)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({}, { defineProperty: (t: any, k: any, d: any) => { hit = 1; return true; } });
        Reflect.defineProperty(p, "x", { value: 1 });
        return hit;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty surfaces the trap's boolean result — true", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { defineProperty: (t: any, k: any, d: any) => true });
        return Reflect.defineProperty(p, "x", { value: 1 }) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty surfaces the trap's boolean result — false", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { defineProperty: (t: any, k: any, d: any) => false });
        return Reflect.defineProperty(p, "x", { value: 1 }) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("the trap receives the property key", async () => {
    // The trap reads `k` and signals via a captured flag whether it matched.
    expect(
      await runStandalone(`export function test(): number {
        let sawKey = 0;
        const p: any = new Proxy({}, { defineProperty: (t: any, k: any, d: any) => { if (k === "attr") sawKey = 1; return true; } });
        Object.defineProperty(p, "attr", { value: 1 });
        return sawKey;
      }`),
    ).toBe(1);
  });

  it("the trap receives the descriptor object (reads desc.value)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let v = 0;
        const p: any = new Proxy({}, { defineProperty: (t: any, k: any, d: any) => { v = d.value; return true; } });
        Object.defineProperty(p, "x", { value: 7, configurable: true });
        return v;
      }`),
    ).toBe(7);
  });

  it("absent defineProperty trap forwards to the target (Reflect → true)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, {});
        return Reflect.defineProperty(p, "x", { value: 1, configurable: true }) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("absent defineProperty trap does NOT fire any other trap", async () => {
    // A handler with only a `get` trap: defineProperty must forward (no spurious
    // get-trap invocation during the define).
    expect(
      await runStandalone(`export function test(): number {
        let getHits = 0;
        const p: any = new Proxy({}, { get: (t: any, k: any) => { getHits = 1; return 0; } });
        Object.defineProperty(p, "x", { value: 1, configurable: true });
        return getHits;
      }`),
    ).toBe(0);
  });

  it("a non-proxy dynamic receiver is unaffected (define still works)", async () => {
    // Regression guard: the dynamic-receiver reroute must not break ordinary
    // standalone Object.defineProperty on a plain `any` object.
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "x", { value: 5, writable: true, enumerable: true, configurable: true });
        return o.x as number;
      }`),
    ).toBe(5);
  });
});
