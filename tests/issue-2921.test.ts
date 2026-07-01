// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2921 — Bank the `__drain_microtasks()` compiler intrinsic (extracted from the
// closed #2367/#2867 PR-B). The funcIdx-shift half of that PR already landed via
// #2918 (`fctx.savedBodies` push/pop), so only the drain intrinsic remained.
//
// The intrinsic lets a standalone/WASI embedder (and, once the carrier is
// activated for `--target standalone` — blocked on #2864 — the test262 harness
// verdict-read) flush pending native `$Promise` reactions before observing
// module state. Native `.then` reactions are QUEUED on the carrier microtask
// ring, not run synchronously, so assertions inside them only take effect after
// `__drain_microtasks()` runs.
//
// It is fully INERT until something calls it:
//   - it emits the native drain ONLY when a microtask queue is already
//     registered (a `.then`/Promise was lowered on a carrier target);
//   - it emits NOTHING (a silent VOID no-op) on every JS-host/gc/linear compile
//     and on any carrier module with no Promise, so it never leaks an import,
//     forces queue infra into Promise-free modules, or perturbs non-carrier
//     codegen. The interceptor is guarded purely by the callee identifier, so a
//     module that never writes `__drain_microtasks()` is byte-identical.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** Stub import object so a leaked host import never blocks instantiation — we are
 *  checking codegen behaviour, not host linkage. */
function stubImports(): WebAssembly.Imports {
  const env = new Proxy({}, { get: () => () => {}, has: () => true });
  return new Proxy({}, { get: () => env, has: () => true }) as WebAssembly.Imports;
}

async function instantiate(src: string, target: "wasi" | "gc") {
  const r = await compile(src, { fileName: "test.ts", target, skipSemanticDiagnostics: true });
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  expect(r.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, stubImports());
  return { r, instance };
}

describe("#2921 — __drain_microtasks() intrinsic (banked carrier infra)", () => {
  it("drains a queued native .then fulfil reaction on the WASI carrier before the verdict read", async () => {
    // The reaction writes `ran = v`. On the WASI carrier the reaction is QUEUED,
    // so `ran` is still 0 at the point after `.then(...)`; `__drain_microtasks()`
    // runs the queued reaction, so `test()` observes the fulfilled value 5.
    const { instance } = await instantiate(
      `
      let ran = 0;
      export function test(): number {
        Promise.resolve(5).then(function (v) { ran = v; });
        __drain_microtasks();
        return ran;
      }
    `,
      "wasi",
    );
    expect((instance.exports as { test(): number }).test()).toBe(5);
  });

  it("without the drain call the reaction stays queued (proves the intrinsic, not eager .then, is what fires it)", async () => {
    const { instance } = await instantiate(
      `
      let ran = 0;
      export function test(): number {
        Promise.resolve(5).then(function (v) { ran = v; });
        return ran;
      }
    `,
      "wasi",
    );
    expect((instance.exports as { test(): number }).test()).toBe(0);
  });

  it("is a silent no-op on the gc/host target (no trap, no import leak)", async () => {
    const { r, instance } = await instantiate(
      `
      export function test(): number {
        __drain_microtasks();
        return 7;
      }
    `,
      "gc",
    );
    expect((instance.exports as { test(): number }).test()).toBe(7);
    expect((r.imports ?? []).map((i) => i.name)).not.toContain("__drain_microtasks");
  });

  it("is a silent no-op on a WASI module that registered no microtask queue", async () => {
    const { instance } = await instantiate(
      `
      export function test(): number {
        __drain_microtasks();
        return 7;
      }
    `,
      "wasi",
    );
    expect((instance.exports as { test(): number }).test()).toBe(7);
  });
});
