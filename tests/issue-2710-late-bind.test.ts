// #2710 — late-bind module indices: regression tests for the live-regime
// index-shift class in the async resume machine + declaration handles.
//
// The encoded bug (found while landing the #1916 S3 flip of declarations.ts /
// async-frame.ts / promise-combinators.ts): the playground `js/async.ts`
// example compiled to INVALID Wasm on `--target gc` from PR #2483 (#1042 host
// async drive) until this fix. Two stacked live-regime failures:
//
//   1. `funcMap` still held LIVE indices for declaration-registered functions
//      (the injected `function setTimeout(...)` timer shim, user `delay`/
//      `fetchAllSequential`/...). A `call` immediate baked from one of those
//      entries inside a *detached* instruction array missed the late-import
//      shift and, after dead-import elimination's renumber, pointed at an
//      unrelated import (`__js_array_new` instead of the setTimeout stub;
//      `$delay` instead of `$fetchAllSequential`). stackBalance then "repaired"
//      the stack against the wrong callee signature (drop×3 vs drop×1), and the
//      module failed `WebAssembly.validate` ("not enough arguments on the
//      stack for call").
//   2. The N-state resume machine (`async-frame.ts` `buildStateArm`) builds
//      state segments depth-first into plain local arrays: while state s+1
//      compiles (and can register late imports — `__date_now`,
//      `__extern_to_string_default`, `__concat_5`...), state s's finished
//      array is reachable from NO shifter root, so its already-baked calls
//      went stale.
//
// The fix: (a) declarations.ts / async-frame.ts / promise-combinators.ts mint
// STABLE handles (`mintDefinedFunc`/`pushDefinedFunc`) — a stable handle never
// shifts, so those bakes are correct by construction; (b) detached segment
// arrays are tracked in `ctx.liveBodies` until assembly, covering calls to
// the remaining live-regime helpers (index.ts mints) until #1916 S3-final.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Await `p` with a timeout so a never-settling result promise fails fast. */
async function settled<T>(p: T | Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("result promise never settled")), ms)),
  ]);
}

// The minimized invalid-Wasm reproducer (distilled from the playground
// example): a setTimeout-closure Promise executor (bakes a call to the
// declaration-registered timer-shim stub), a multi-await host-driven `main`
// whose EARLY state segment calls a user function, and enough late-import
// churn in LATER segments (`Date.now`, a 5-part string concat) to shift the
// function index space after the early segment's calls were baked.
const REPRO = `
function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}
async function fetchUser(id: number): Promise<number> {
  const v = await delay(5, id * 10);
  return v;
}
async function fetchAllSequential(ids: number[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    total = total + (await fetchUser(ids[i]));
  }
  return total;
}
export async function main(): Promise<void> {
  const t0 = Date.now();
  const seq = await fetchAllSequential([1, 2, 3]);
  const t1 = Date.now();
  console.log("sequential sum = " + seq.toString() + " (took ~" + (t1 - t0).toString() + "ms)");
  const par = await fetchAllSequential([4, 5]);
  console.log("parallel sum = " + par.toString() + " done");
}
`;

describe("#2710 late-bind — async resume machine survives late-import churn", () => {
  it("multi-await host-driven main with early user-fn calls emits VALID Wasm (gc)", async () => {
    const r = await compile(REPRO, { target: "gc" });
    expect(r.success).toBe(true);
    expect(r.binary).toBeDefined();
    // On pre-fix main this failed: __async_resume_fmain's state-0
    // `call fetchAllSequential` was stale by the imports added while
    // compiling later states ("not enough arguments on the stack for call").
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });

  it("the playground async example emits VALID Wasm on every target", async () => {
    const src = readFileSync(join(__dirname, "../website/playground/examples/js/async.ts"), "utf-8");
    for (const target of ["gc", "standalone", "wasi"] as const) {
      const r = await compile(src, { target });
      expect(r.success, `${target} compile`).toBe(true);
      expect(WebAssembly.validate(r.binary!), `${target} validate`).toBe(true);
    }
  });

  it("end-to-end: stale-shift-prone calls resolve to the RIGHT functions", async () => {
    // Value-returning variant with HOST-DRIVE-ELIGIBLE shapes only (linear
    // multi-await bodies — await-in-loop still takes the legacy lane with its
    // documented wrong-value limitation, so it is exercised via the VALIDITY
    // tests above, not this run test). Same churn characteristics: user-fn
    // calls baked into EARLY resume segments, `Date.now` + a multi-part string
    // concat registering late imports while LATER segments compile.
    // compileToWasm validates the binary and runs it on the JS host, so a
    // wrong-callee bake fails loudly (either validation or a wrong sum).
    const exports = await compileToWasm(`
      async function fetchA(): Promise<number> {
        const a = await Promise.resolve(10).then((x: number) => x + 1);
        const b = await Promise.resolve(20).then((x: number) => x + 2);
        return a + b;
      }
      async function fetchB(): Promise<number> {
        const a = await Promise.resolve(40).then((x: number) => x + 3);
        const b = await Promise.resolve(50).then((x: number) => x + 4);
        return a + b;
      }
      export async function main(): Promise<number> {
        const t0 = Date.now();
        const seq = await fetchA();
        const par = await fetchB();
        console.log("took ~" + (Date.now() - t0).toString() + "ms " + seq.toString() + "+" + par.toString());
        return seq + par;
      }
    `);
    // (11+22) + (43+54) = 33 + 97 = 130.
    await expect(settled(exports.main!() as Promise<number>)).resolves.toBe(130);
  });
});
