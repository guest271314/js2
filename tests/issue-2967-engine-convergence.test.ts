// #2967 slice 1 — async engine convergence: the JS-host lane's single-tail-await
// population moves from the legacy `.then`-chaining CPS lane
// (`emitAsyncStateMachine`/`splitBodyAtAwait`) onto the #2906 N-state
// `$AsyncFrame` resume machine with the host settle backend (#1042), so ONE
// engine drives every linear shape (single-await is the N=1 case).
//
// Deliberate carve-outs (this slice keeps them on the proven CPS lane):
//   - lifted closures (arrow / fn-expr): host-drive closures are the parked
//     #2646 33-regression class — `planAsyncClosureActivation` re-lanes the
//     CPS-shaped subset back to CPS, byte-stable across the flip;
//   - binding-pattern / rest params: the destructuring prologue derives locals
//     in the ENTRY fn that the fresh resume FunctionContext never sees (the
//     same reason `isAsyncGenDriveCandidate` rejects pattern params); the CPS
//     continuation snapshots them by value, so those shapes stay CPS.
//
// Structural assertions read the binaryen-emitted WAT for the
// `__async_resume_f<name>` resume function — the frame engine's signature
// artifact; the CPS lane never mints one.
import { describe, it, expect } from "vitest";
import binaryen from "binaryen";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

/** Await `p` with a timeout so a never-settling result promise fails fast. */
async function settled<T>(p: T | Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("result promise never settled")), ms)),
  ]);
}

async function watOf(src: string): Promise<string> {
  const r = await compile(src, { target: "gc" });
  expect(r.success, (r.errors ?? []).slice(0, 3).join("; ")).toBe(true);
  expect(WebAssembly.validate(r.binary!)).toBe(true);
  const mod = binaryen.readBinary(r.binary!);
  const wat = mod.emitText();
  mod.dispose();
  return wat;
}

describe("#2967 routing — one engine on the JS-host lane", () => {
  it("a single-tail-await function DECLARATION now takes the host-drive frame engine", async () => {
    const wat = await watOf(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(20).then((x: number) => x + 1);
        return a * 2;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    expect(wat).toContain("__async_resume_ff");
    expect(wat).toContain("__async_resume_fmain");
    expect(wat).toContain("Promise_new_pending");
  });

  it("an arrow closure of the same shape stays on the CPS lane (parked #2646 class)", async () => {
    const wat = await watOf(`
      const g = async (x: number): Promise<number> => {
        const a = await Promise.resolve(x).then((y: number) => y + 1);
        return a * 2;
      };
      export function main(): number { g(20); return 1; }
    `);
    // Arrow resume fns would be named __async_resume_fanon_<pos>.
    expect(wat).not.toContain("__async_resume_fanon");
  });

  it("a binding-pattern-param declaration stays on the CPS lane (derived prologue locals)", async () => {
    const wat = await watOf(`
      async function f({ a }: { a: number }): Promise<number> {
        const v = await Promise.resolve(a).then((y: number) => y + 1);
        return v * 2;
      }
      export async function main(): Promise<number> { return await f({ a: 20 }); }
    `);
    expect(wat).not.toContain("__async_resume_ff");
    // main has plain params — it flips to host-drive like any other decl.
    expect(wat).toContain("__async_resume_fmain");
  });

  it("the pre-#2967 host-drive population (multi-await) keeps its routing", async () => {
    const wat = await watOf(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(9).then((x: number) => x + 1);
        const b = await Promise.resolve(9).then((x: number) => x + 1);
        return a + b;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    expect(wat).toContain("__async_resume_ff");
  });
});

describe("#2967 behavior — flipped single-await shapes on the frame engine", () => {
  it("`return await P` (genuinely pending) resolves to the awaited value", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> { return await Promise.resolve(21).then((x: number) => x * 2); }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("prefix local + resume binding + suffix thread through the frame", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const k: number = 2;
        const a = await Promise.resolve(20).then((x: number) => x + 1);
        return a * k;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("bare `await P;` with a suffix, and a discarded-tail `await P;` (implicit undefined)", async () => {
    const exports = await compileToWasm(`
      let acc: number = 0;
      async function g(): Promise<void> {
        await Promise.resolve(0).then((x: number) => { acc = acc + 1; return x; });
      }
      async function f(): Promise<number> {
        await Promise.resolve(0).then((x: number) => { acc = acc + 41; return x; });
        return acc;
      }
      export async function main(): Promise<number> { await g(); return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a rejected awaited operand rejects the result promise (reject step adapter)", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(1).then((x: number): number => { throw new Error("boom"); });
        return a;
      }
      export function main(): any { return f(); }
    `);
    // The reason is a raw WebAssembly.Exception, not the original Error: the
    // COMPILED `.then` callback's wasm `throw` escapes the exported `__cb_N`
    // into the host `.then` machinery before any suspension engine sees it.
    // Probe-verified identical on the CPS lane (pre-existing boundary
    // behavior, engine-invariant — same assertion as the #1042 suite).
    await expect(settled(exports.main())).rejects.toBeTruthy();
  });

  it("a wasm-side throw AFTER resume settles the reason with full fidelity (improvement over CPS)", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(1).then((x: number) => x + 1);
        if (a === 2) { throw new Error("boom-suffix"); }
        return a;
      }
      export function main(): any { return f(); }
    `);
    // Measured delta of the flip: the frame engine's dispatch `try`/`catch
    // $exn` → `Promise_settle_reject(reason)` unwraps the exn PAYLOAD (the
    // original Error externref), so JS sees `instanceof Error` with the
    // message intact. The CPS lane leaked the raw wasm exception out of its
    // `__cb_N` continuation instead (probe-verified: `WebAssembly.Exception`,
    // message undefined). assert.throwsAsync-style consumers benefit.
    await expect(settled(exports.main())).rejects.toThrow("boom-suffix");
  });

  it("the result promise is a real thenable a JS host can chain off", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(40).then((x: number) => x + 1);
        return a + 1;
      }
      export function main(): any { return f(); }
    `);
    const p = exports.main();
    expect(typeof p?.then).toBe("function");
    await expect(settled(p.then((v: number) => v))).resolves.toBe(42);
  });
});
