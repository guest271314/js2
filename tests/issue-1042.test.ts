// #1042 PR1 — async-cps.ts module skeleton.
//
// Exercises the pure analysis surface (`analyzeAsyncBody`) that later PRs'
// state-machine lowering consumes. The emit surface is inert in PR1
// (ASYNC_CPS_ENABLED === false), so there is no codegen to test yet — these
// tests pin the analysis contract that must stay stable for #1373b.
import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { analyzeAsyncBody, ASYNC_CPS_ENABLED, type AsyncCpsPlan } from "../src/codegen/async-cps.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

// analyzeAsyncBody ignores its ctx argument (pure analysis). A cast is safe.
const FAKE_CTX = {} as CodegenContext;

function analyze(src: string): AsyncCpsPlan {
  const sf = ts.createSourceFile("_wrap.ts", src, ts.ScriptTarget.Latest, true);
  // Find the first function-like declaration at top level.
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("test setup: no function declaration");
  return analyzeAsyncBody(FAKE_CTX, fn);
}

describe("#1042 PR1 — async CPS analysis surface", () => {
  it("the gate is OFF (byte-identical guarantee for PR1)", () => {
    expect(ASYNC_CPS_ENABLED).toBe(false);
  });

  it("no await ⇒ zero await points (function-body hook keeps legacy path)", () => {
    const plan = analyze(`async function f(a: number) { return a + 1; }`);
    expect(plan.awaitPoints).toHaveLength(0);
    expect(plan.hasTryAcrossAwait).toBe(false);
  });

  it("single await ⇒ one await point", () => {
    const plan = analyze(`async function f(b: number) { const y = await foo(b); return y; }`);
    expect(plan.awaitPoints).toHaveLength(1);
  });

  it("multiple awaits ⇒ counted in pre-order", () => {
    const plan = analyze(`
      async function f() {
        const a = await one();
        const b = await two();
        const c = await three();
        return a + b + c;
      }
    `);
    expect(plan.awaitPoints).toHaveLength(3);
  });

  it("nested await ⇒ both outer and inner counted", () => {
    const plan = analyze(`async function f() { return await (await x()); }`);
    expect(plan.awaitPoints).toHaveLength(2);
  });

  it("awaits inside a nested async arrow are NOT counted (own state machine)", () => {
    const plan = analyze(`
      async function f() {
        const g = async () => { await inner(); };
        await outer();
        return g;
      }
    `);
    // Only the f-level `await outer()` — the arrow's `await inner()` belongs to
    // the arrow's own (separate) state machine.
    expect(plan.awaitPoints).toHaveLength(1);
  });

  it("live-after-await captures a local used after the await", () => {
    const plan = analyze(`
      async function f(a: number) {
        const x = a + 1;
        const y = await foo();
        return x + y;
      }
    `);
    expect(plan.awaitPoints).toHaveLength(1);
    const live = plan.liveAfterAwait.get(plan.awaitPoints[0]!)!;
    // `x` is declared before the await and read after ⇒ must be captured.
    expect(live.has("x")).toBe(true);
  });

  it("live-after-await excludes a local NOT used after the await", () => {
    const plan = analyze(`
      async function f(a: number) {
        const x = a + 1;
        sideEffect(x);
        const y = await foo();
        return y;
      }
    `);
    const live = plan.liveAfterAwait.get(plan.awaitPoints[0]!)!;
    // `x` is consumed entirely before the await ⇒ not live afterward.
    expect(live.has("x")).toBe(false);
  });

  it("live-after-await excludes globals/imports (only own locals captured)", () => {
    const plan = analyze(`
      async function f() {
        const y = await foo();
        return Math.max(y, globalThing);
      }
    `);
    const live = plan.liveAfterAwait.get(plan.awaitPoints[0]!)!;
    expect(live.has("Math")).toBe(false);
    expect(live.has("globalThing")).toBe(false);
  });

  it("try/catch spanning an await is flagged", () => {
    const plan = analyze(`
      async function f() {
        try { const y = await foo(); return y; }
        catch (e) { return 0; }
      }
    `);
    expect(plan.hasTryAcrossAwait).toBe(true);
  });

  it("try/catch NOT spanning an await is not flagged", () => {
    const plan = analyze(`
      async function f() {
        const y = await foo();
        try { return y; } catch (e) { return 0; }
      }
    `);
    expect(plan.hasTryAcrossAwait).toBe(false);
  });

  it("uncaught throw is flagged; throw inside try is not", () => {
    expect(analyze(`async function f() { await x(); throw new Error("boom"); }`).hasUncaughtThrow).toBe(true);
    expect(
      analyze(`async function f() { try { throw new Error("x"); } catch (e) {} await y(); }`).hasUncaughtThrow,
    ).toBe(false);
  });
});
