import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// #2618 — Proxy (host) apply/construct call path, slice 1: START-timing + the
// callable-target [[ProxyTarget]] wrap.
//
// Two verified faults on current main (gc / JS-host mode):
//
//  (A) START-timing — a TOP-LEVEL `new Proxy(target, handler)` runs inside the
//      wasm module START function, BEFORE `setExports` wires `__is_closure` /
//      the `__sget_*` field getters. The eager bridge could neither read nor
//      classify the WasmGC-struct handler's trap fields, so EVERY user trap was
//      lost: the host fell back to its default internal methods and `p.x` /
//      `p has` / `p set` silently returned the wrong value (the proxy was built
//      at module scope but invoked later, post-`setExports`, from an exported
//      function). Fixed by deferring trap resolution to first invocation when
//      exports aren't yet wired (`_buildLazyProxyBridgeHandler`).
//
//  (B) callable-target — a Proxy whose target is a wasm closure was not
//      host-callable (V8 derives [[Call]] from [[ProxyTarget]]; a raw struct is
//      not callable), so `p(...)` / `p.call(...)` threw "call is not a
//      function". Fixed by using the target's JS-callable wrapper as
//      [[ProxyTarget]] and restoring the raw struct as the apply/construct
//      trap's `target` argument (so `assert.sameValue(t, target)` still holds).
//
// The dynamic-`new`-on-externref-Proxy construct-result routing (codegen
// `tryEmitDynamicNew`) and the externref-callee call dispatch are a deeper,
// separate slice — see the issue file's prerequisite ordering.

async function run(source: string): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as { test?: () => unknown }).test?.();
}

describe("#2618 — Proxy START-timing + callable-target wrap", () => {
  // ── (A) START-timing: a top-level proxy's traps must fire ──────────────────

  it("top-level proxy get trap fires (was dropped: returned target value)", async () => {
    // The proxy is built at MODULE SCOPE (before setExports) but read from the
    // exported function (after setExports). Before the fix this returned the
    // target's own value, not the trap result.
    const src = `
      const p: any = new Proxy({ a: 1 }, { get: function () { return 99; } });
      export function test(): number { return p.x; }
    `;
    expect(await run(src)).toBe(99);
  });

  it("top-level proxy has trap fires", async () => {
    const src = `
      const p: any = new Proxy({ a: 1 }, { has: function () { return true; } });
      export function test(): number { return ("zzz" in p) ? 1 : 0; }
    `;
    expect(await run(src)).toBe(1);
  });

  it("top-level proxy set trap fires", async () => {
    const src = `
      let captured = 0;
      const p: any = new Proxy({ a: 1 }, {
        set: function (t: any, k: any, v: any) { captured = v; return true; },
      });
      export function test(): number { p.a = 42; return captured; }
    `;
    expect(await run(src)).toBe(42);
  });

  it("top-level proxy apply trap fires and returns its result", async () => {
    // `built-ins/Proxy/apply/call-result.js` shape: top-level proxy of a
    // function, apply trap returns a value, invoked via the wrapped function.
    const src = `
      const result = { v: 7 };
      const p: any = new Proxy(function () { return -1; }, {
        apply: function (t: any, c: any, args: any) { return result; },
      });
      export function test(): number { return p.call().v; }
    `;
    expect(await run(src)).toBe(7);
  });

  it("top-level proxy with NO trap behaves like an inner-built one (regression guard)", async () => {
    // No-trap read-through of a closed-struct target is a separate, deferred
    // concern (#2615); the guard here is only that top-level and inner proxies
    // behave IDENTICALLY — the START-timing fix must not diverge them.
    const inner = await run(`
      export function test(): number {
        const p: any = new Proxy({ a: 5 }, {});
        return p.a;
      }
    `);
    const top = await run(`
      const p: any = new Proxy({ a: 5 }, {});
      export function test(): number { return p.a; }
    `);
    expect(top).toBe(inner);
  });

  // ── (B) callable-target wrap: the proxy of a function is host-callable ──────
  //
  // NOTE: the full externref-callee CALL dispatch (`p.call(a, b)` with args, the
  // dynamic `__call_function` routing in codegen `tryEmitInlineDynamicCall`) is
  // a deeper, separate slice — see the issue file's prerequisite ordering. This
  // slice only makes the proxy host-callable (so the host `apply` MOP runs) and
  // restores target identity, which is what `apply/call-parameters.js` (a test262
  // row flipped fail→pass by this slice) needs.

  it("apply trap on a function-targeted proxy returns its result via p.call()", async () => {
    // No-arg `p.call()` routes through the host apply MOP; the trap result is
    // returned. (Multi-arg externref-callee dispatch is the deferred slice.)
    const src = `
      const result = { v: 11 };
      const p: any = new Proxy(function () { return -1; }, {
        apply: function (t: any, c: any, args: any) { return result; },
      });
      export function test(): number { return p.call().v; }
    `;
    expect(await run(src)).toBe(11);
  });
});
