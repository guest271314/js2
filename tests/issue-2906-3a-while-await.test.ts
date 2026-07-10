// #2906 slice 3a — `while`-with-await on the host-free async drive machine.
//
// The multi-state CFG resume machine (#2906 slice 3, PR #2413) shipped the
// `goto`/`condGoto` terminators and back-edge br model but left them
// producer-unreachable (`linearPlanToCfg` never emits them). Slice 3a adds the
// FIRST loop producer — `planWhileLoopCfg` — lowering `while (cond) { …await… }`
// into: an entry state (pre-loop leads), a head state whose `condGoto` enters
// the body or the exit, body suspend states, and a continuation state whose
// `goto(head)` is the back-edge. It also fixes the off-by-one `br` depth the
// never-exercised `goto`/`condGoto` emitter shipped with (the re-dispatch loop
// is `loopDepth-1` from a state-body top level, `loopDepth` from inside an `if`
// arm — the latter matches the proven suspend fast-path advance br).
//
// Loop-liveness (the silent-miscompile trap): every own-local referenced
// anywhere in the loop is live across the loop-carried await (read before the
// await, read again after resume on the next iteration), so the whole set is
// spilled into the frame — proven by the genuinely-pending tests, where the
// accumulator survives real suspension across iterations.
//
// Native (wasi) drive lane only — host-free (no imports). The JS-host settle
// backend keeps the linear-only shape (loops there are an N-round follow-up).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile a host-free async program and instantiate it (imports must be empty). */
async function instantiateWasi(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // The drive layer is host-free: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports;
}

describe("#2906 slice 3a — while-with-await drive machine", () => {
  it("synchronously-settled loop runs to completion in one call (fast-path advance through the back-edge)", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function step(n: number): Promise<number> { return n + 10; }
      async function loop(): Promise<void> {
        let i: number = 0;
        let sum: number = 0;
        while (i < 3) { const v = await step(i); sum = sum + v; i = i + 1; }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number };
    expect(ex.kick()).toBe(33); // 10 + 11 + 12, no suspension needed
  });

  it("GENUINELY-PENDING loop suspends each iteration; the drain resumes and the accumulator survives (frame spill)", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        let i: number = 0;
        let sum: number = 0;
        while (i < 3) {
          const v = await Promise.resolve(i).then((x: number) => x + 10);
          sum = sum + v;
          i = i + 1;
        }
        cap = sum;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0); // suspended on the first iteration's pending await
    ex.__drain_microtasks(); // resumes each iteration in turn across the back-edge
    expect(ex.getCap()).toBe(33); // 10 + 11 + 12 — sum + i survived every suspension
  });

  it("zero-iteration loop (condition false first) runs the exit directly, never suspends", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function step(n: number): Promise<number> { return n + 1; }
      async function loop(): Promise<void> {
        let i: number = 5;
        while (i < 3) { const v = await step(i); i = i + 1; }
        cap = 99;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number };
    expect(ex.kick()).toBe(99); // condGoto false → straight to exit, cap set synchronously
  });

  it("a prefix local is carried across the back-edge and combined with each resumed value", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function loop(): Promise<void> {
        const base: number = 100;   // set once before the loop, read every iteration
        let i: number = 0;
        let acc: number = 0;
        while (i < 2) {
          const v = await Promise.resolve(i).then((x: number) => x + 1);
          acc = acc + base + v;
          i = i + 1;
        }
        cap = acc;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0);
    ex.__drain_microtasks();
    // i=0: base(100)+v(1)=101; i=1: base(100)+v(2)=102 → 203
    expect(ex.getCap()).toBe(203);
  });

  it("a bare `await P;` loop body (no resume binding) runs its side effects in order across iterations", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      let n: number = 0;
      async function loop(): Promise<void> {
        let i: number = 0;
        while (i < 4) {
          await Promise.resolve(i).then((x: number) => x);
          n = n + 1;
          i = i + 1;
        }
        cap = n;
      }
      export function kick(): number { loop() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0);
    ex.__drain_microtasks();
    expect(ex.getCap()).toBe(4);
  });

  it("unsupported loop control (break inside the loop) falls back to the legacy path and still compiles", async () => {
    // `break` targeting the loop is out of the bounded 3a slice — the drive gate
    // rejects it and the fn takes the legacy path (may not host-free-drive, but
    // must still compile without error).
    const r = await compile(
      `let cap: number = 0;
       async function loop(): Promise<void> {
         let i: number = 0;
         while (i < 5) { const v = await Promise.resolve(i); if (v > 2) { break; } i = i + 1; }
         cap = i;
       }
       export function kick(): number { loop() as any; return cap; }`,
      { fileName: "test.ts", target: "wasi" },
    );
    expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  });
});
