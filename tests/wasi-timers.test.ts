// #1484 — WASI timer diagnostic + poll_oneoff helper.
//
// #2632 Phase 1 UPDATE: under `--target wasi`, setTimeout/setInterval/
// clearTimeout/clearInterval/queueMicrotask are now LOWERED onto the standalone
// event-loop reactor (timer heap + run loop driven by poll_oneoff /
// clock_time_get) — they COMPILE and RUN rather than being rejected. The
// `__wasi_sleep_ms` helper this diagnostic introduced (#1484) is the blocking
// sleep the reactor uses. Only `setImmediate` remains rejected (its Node
// check-phase ordering is a later-phase concern). End-to-end timer ordering is
// covered by `tests/issue-2632-event-loop.test.ts` (run under wasmtime).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

describe("WASI timers (#1484 → #2632 Phase 1) — now lowered, not rejected", () => {
  it("setTimeout under --target wasi compiles and emits the run loop", async () => {
    const src = `setTimeout(() => { console.log("late"); }, 100);`;
    const result = await compile(src, { target: "wasi", skipSemanticDiagnostics: true });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    expect(result.wat!).toContain("$__run_event_loop");
    expect(result.wat!).toContain("$__timer_add");
  });

  it("setInterval under --target wasi compiles", async () => {
    const src = `setInterval(() => {}, 50);`;
    const result = await compile(src, { target: "wasi", skipSemanticDiagnostics: true });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    expect(result.wat!).toContain("$__timer_add");
  });

  it("setImmediate under --target wasi remains rejected (out of Phase-1 scope)", async () => {
    const src = `setImmediate(() => {});`;
    const result = await compile(src, { target: "wasi" });
    expect(result.success).toBe(false);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/setImmediate/);
  });

  it("queueMicrotask under --target wasi compiles and enqueues onto the microtask queue", async () => {
    const src = `queueMicrotask(() => {});`;
    const result = await compile(src, { target: "wasi", skipSemanticDiagnostics: true });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    expect(result.wat!).toContain("$__microtask_enqueue");
  });

  it("does NOT reject when setTimeout appears as a member name (e.g. obj.setTimeout)", async () => {
    // Member-name positions must not false-positive (the rejection is for
    // bare-identifier global lookups only).
    const src = `
      class Scheduler { setTimeout(_fn: any, _ms: number): void {} }
      const s = new Scheduler();
      s.setTimeout(() => {}, 10);
    `;
    const result = await compile(src, { target: "wasi" });
    if (!result.success) {
      // If compile fails for other reasons (e.g. class support), at least
      // ensure the failure is NOT the WASI timer diagnostic.
      const msg = result.errors.map((e) => e.message).join("\n");
      expect(msg).not.toMatch(/'setTimeout' is not available under --target wasi/);
    } else {
      expect(result.success).toBe(true);
    }
  });

  it("does NOT reject setTimeout outside --target wasi", async () => {
    // In non-WASI mode, setTimeout falls through to the env-host import
    // path. We only assert the diagnostic does not fire — full lowering
    // behaviour is covered elsewhere.
    const src = `setTimeout(() => {}, 1);`;
    const result = await compile(src, {});
    if (!result.success) {
      const msg = result.errors.map((e) => e.message).join("\n");
      expect(msg).not.toMatch(/is not available under --target wasi/);
    }
  });
});

describe("WASI timers (#1484) — buildWasiPolyfill poll_oneoff", () => {
  it("provides poll_oneoff that writes nevents and returns 0", () => {
    const polyfill = buildWasiPolyfill();
    // Provide a small memory buffer so poll_oneoff has somewhere to write.
    const mem = new WebAssembly.Memory({ initial: 1 });
    polyfill.setMemory(mem);

    const view = new DataView(mem.buffer);
    const SUB_PTR = 64;
    const EVT_PTR = 112;
    const NEVENTS_PTR = 144;

    // Pre-fill nevents with a non-zero sentinel so we can confirm the shim wrote it.
    view.setUint32(NEVENTS_PTR, 0xdeadbeef, true);

    const errno = polyfill.poll_oneoff(SUB_PTR, EVT_PTR, 1, NEVENTS_PTR);
    expect(errno).toBe(0); // __WASI_ERRNO_SUCCESS

    const nevents = view.getUint32(NEVENTS_PTR, true);
    expect(nevents).toBe(1);
  });

  it("returns -1 when memory is not set", () => {
    const polyfill = buildWasiPolyfill();
    expect(polyfill.poll_oneoff(0, 0, 1, 0)).toBe(-1);
  });
});
