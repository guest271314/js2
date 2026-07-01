// #2918 — native `.then` / `Promise.all`/`race` combinator funcIdx-shift desync.
//
// Root cause (two coupled holes, both in the late-import funcIdx-shift lockstep):
//
//  1. `shiftAsyncSideChannelFuncIdxs` (async-scheduler.ts) is the single source of
//     truth for shifting the async-substrate side-channel funcIdxs, called from
//     ALL THREE late-import shifters. The previous per-shifter inline lists were
//     inconsistent — `shiftLateImportIndices` omitted `promiseResolveValueFuncIdx`
//     (#2867 Gap 1) and every combinator idx, and `addStringImports` /
//     `addUnionImports` omitted the async keys entirely. A native `.then` handler
//     wrapper reads `promiseResolveValueFuncIdx` as its settle target; when a late
//     import landed between the settle helpers' registration and that bake, the
//     stale-low index called one function too early → "not enough arguments on the
//     stack for call" invalid Wasm (the −601 standalone-widen regression).
//
//  2. `compilePromiseThenReceiverBuffer` / `compileStandalonePromiseThenCallback`
//     (expressions/calls.ts) swapped `fctx.body` to a scratch buffer but stashed
//     the real body in a bare local — invisible to the shifter's `savedBodies`
//     walk. A late import fired while compiling the buffer (e.g. an object-runtime
//     helper for a `{}` that precedes the `.then`) then shifted every defined
//     function up but NOT the `call`/`ref.func` already emitted in the outer body,
//     so `call __new_plain_object` (baked at N) kept pointing at N while the helper
//     moved to N+1 (a 4-param `__key_equals`) → the same invalid Wasm.
//
// The fix is carrier-gated inert: the shift keys are all `-1` off-carrier and the
// buffer helpers are only reached under `isStandaloneThenChainNativeActive`
// (wasi-only today), so gc/host + standalone stay byte-identical.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { shiftAsyncSideChannelFuncIdxs } from "../src/codegen/async-scheduler.js";

describe("#2918 — async side-channel funcIdx shift completeness", () => {
  // Guards hole #1: the shift key list MUST include promiseResolveValueFuncIdx and
  // the combinator indices, or a late import silently desyncs the native `.then`
  // settle target / the combinator call site. This test fails if any key is
  // dropped from ASYNC_SCHEDULER_FUNC_IDX_KEYS / COMBINATOR_FUNC_IDX_KEYS.
  it("shifts every registered async + combinator funcIdx by the import delta", () => {
    const sched: Record<string, number> = {
      enqueueFuncIdx: 20,
      drainFuncIdx: 21,
      growFuncIdx: 22,
      promiseFulfillFuncIdx: 23,
      promiseRejectFuncIdx: 24,
      identityFulfillWrapperFuncIdx: 25,
      identityRejectWrapperFuncIdx: 26,
      promiseResolveValueFuncIdx: 27, // the historically-omitted key (#2867 Gap 1)
      timerAddFuncIdx: 28,
      timerCancelFuncIdx: 29,
      timerPeekDeadlineFuncIdx: 30,
      timerFireDueFuncIdx: 31,
      runLoopFuncIdx: 32,
      runLoopNowFuncIdx: 33,
      stdinDrainFuncIdx: 34,
      pollFd0OrClockFuncIdx: 35,
    };
    const comb: Record<string, number> = {
      subscribeFuncIdx: 40,
      allFulfillFuncIdx: 41,
      raceFulfillFuncIdx: 42,
      rejectFuncIdx: 43,
    };
    const ctx = { asyncScheduler: sched, __promiseCombinators: comb } as unknown as Parameters<
      typeof shiftAsyncSideChannelFuncIdxs
    >[0];
    // importsBefore=15, added=2 → every idx >= 15 moves up by 2.
    shiftAsyncSideChannelFuncIdxs(ctx, 15, 2);
    for (const k of Object.keys(sched)) expect(sched[k], k).toBeGreaterThanOrEqual(22);
    expect(sched.promiseResolveValueFuncIdx).toBe(29);
    expect(comb.subscribeFuncIdx).toBe(42);
    expect(comb.rejectFuncIdx).toBe(45);
  });

  it("leaves unregistered (-1) side channels untouched and no-ops on zero delta", () => {
    const sched: Record<string, number> = { promiseResolveValueFuncIdx: -1, enqueueFuncIdx: 5 };
    const ctx = { asyncScheduler: sched } as unknown as Parameters<typeof shiftAsyncSideChannelFuncIdxs>[0];
    shiftAsyncSideChannelFuncIdxs(ctx, 0, 0); // added=0 → no-op
    expect(sched.promiseResolveValueFuncIdx).toBe(-1);
    expect(sched.enqueueFuncIdx).toBe(5);
    shiftAsyncSideChannelFuncIdxs(ctx, 0, 3); // -1 stays -1 (never a valid defined-func idx)
    expect(sched.promiseResolveValueFuncIdx).toBe(-1);
    expect(sched.enqueueFuncIdx).toBe(8);
  });
});

describe("#2918 — native `.then`/combinator carrier path stays valid host-free (wasi)", () => {
  // Guards hole #2 on the live carrier lane: an object literal (a late-import
  // trigger) preceding a native `Promise.all([...]).then(...).then(...)` chain must
  // still compile to VALID, host-free Wasm. Regressing the buffer `savedBodies`
  // reachability would reintroduce the funcIdx desync here.
  async function expectValidHostFree(body: string): Promise<void> {
    const src = `function $DONE(e?: any): void {}\n${body}`;
    const r = await compile(src, { fileName: "t.ts", target: "wasi" });
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
    expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    await WebAssembly.compile(r.binary); // throws on invalid — the −601 guard
  }

  it("object literal before a nested Promise.all(...).then().then() chain", async () => {
    await expectValidHostFree(
      `export function test(): number {
         const o: any = {};
         Promise.all([Promise.resolve(1), Promise.resolve(2)])
           .then((a: any) => a, (e: any) => {})
           .then($DONE, $DONE);
         return 1;
       }`,
    );
  });

  it("object literal before a Promise.resolve().then().then() chain", async () => {
    await expectValidHostFree(
      `export function test(): number {
         const o: any = { x: 1 };
         Promise.resolve(1).then((v: any) => v, (e: any) => {}).then($DONE, $DONE);
         return 1;
       }`,
    );
  });
});
