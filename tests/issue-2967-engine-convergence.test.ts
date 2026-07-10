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

  it("an arrow closure of the same shape takes the host-drive frame engine (slice 2a — #2646 park lifted)", async () => {
    const wat = await watOf(`
      const g = async (x: number): Promise<number> => {
        const a = await Promise.resolve(x).then((y: number) => y + 1);
        return a * 2;
      };
      export function main(): number { g(20); return 1; }
    `);
    // Arrow resume fns are named __async_resume_fanon_<pos>.
    expect(wat).toContain("__async_resume_fanon");
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

describe("#2967 slice 2a — host-drive CLOSURES (the lifted #2646 park)", () => {
  it("multi-await function EXPRESSION callback (the exact #2646 asyncTest harness shape)", async () => {
    // The runner is typed `() => any` so the call takes the #1131 sig-dispatch
    // ladder (with the #2174 async-candidate externref widening). Two probed
    // PRE-EXISTING boundaries are deliberately avoided (both control-verified
    // broken on pristine main 32bae1f48f, where this closure was still legacy):
    //   - `(): Promise<number>` runner return → #3134 (Promise<T>→f64 unwrap
    //     mangles the real promise to NaN);
    //   - `cb: any` / untyped param → the general any-callee call gap (the
    //     body compiles to `return ref.null`; even a SYNC closure returns null
    //     through it — not async-scope).
    const exports = await compileToWasm(`
      function runTest(cb: () => any): any {
        return cb();
      }
      export function main(): any {
        return runTest(async function (): Promise<number> {
          const a = await Promise.resolve(9).then((x: number) => x + 1);
          const b = await Promise.resolve(30).then((x: number) => x + 2);
          return a + b;
        });
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("multi-await arrow reading a captured outer local across both awaits (__self materialization)", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const k: number = 20;
        const g = async (): Promise<number> => {
          const a = await Promise.resolve(1).then((x: number) => x + 0);
          const b = await Promise.resolve(1).then((x: number) => x + 0);
          return (a + b) * k + 2;
        };
        return g();
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("single-await arrow with capture (the slice-1 re-lane population, now framed)", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const base: number = 40;
        const g = async (x: number): Promise<number> => {
          const a = await Promise.resolve(x).then((y: number) => y + 1);
          return a + base;
        };
        return g(1);
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("discarded-tail bare `await P;` closure resolves (the 22-regression CPS-emit bug, correct on the frame)", async () => {
    const exports = await compileToWasm(`
      let acc: number = 0;
      export function main(): any {
        const g = async (): Promise<void> => {
          await Promise.resolve(0).then((x: number) => { acc = acc + 42; return x; });
        };
        return g().then(() => acc);
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("bare `await P; return Q` closure adopts the returned promise (the 23rd-regression CPS-emit bug)", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async (): Promise<number> => {
          await Promise.resolve(0).then((x: number) => x);
          return Promise.resolve(21).then((x: number) => x * 2) as any;
        };
        return g();
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a mutated capture CELL read after resume sees the pre-suspension write (boxedCaptures deref)", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        let n: number = 0;
        const bump = (): void => { n = n + 40; };
        const g = async (): Promise<number> => {
          n = n + 1;
          const a = await Promise.resolve(1).then((x: number) => x + 0);
          return n + a;
        };
        bump();
        return g();
      }
    `);
    // bump() → 40, closure pre-await → 41, +a(1) = 42.
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("rejected await inside a multi-await closure rejects the result promise", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async (): Promise<number> => {
          const a = await Promise.resolve(1).then((x: number) => x + 0);
          const b = await Promise.resolve(1).then((x: number): number => { throw new Error("boom-closure"); });
          return a + b;
        };
        return g();
      }
    `);
    await expect(settled(exports.main())).rejects.toBeTruthy();
  });
});

describe("#2967 slice 2b — concise arrow bodies on the frame engine", () => {
  it("`async x => await P` routes host-drive and resolves the awaited value", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async (x: number): Promise<number> => await Promise.resolve(x).then((y: number) => y * 2);
        return g(21);
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("concise body with a CAPTURE (`async x => await p.then(y => y + k)`)", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const k: number = 2;
        const g = async (x: number): Promise<number> => await Promise.resolve(x).then((y: number) => y * k);
        return g(21);
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("parenthesized concise body `async () => (await P)`", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async (): Promise<number> => (await Promise.resolve(21).then((x: number) => x * 2));
        return g();
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a RICHER concise body (`=> (await P) + 1`, await nested in an expression) keeps the legacy fallback", async () => {
    // Not linear-canonical (the await is nested in a binary expression), so it
    // must NOT mint a resume fn — it stays on the legacy path. Its VALUE is
    // wrong there (NaN — the legacy sync fakery adds 1 to the promise), which
    // is pre-existing and is exactly the nested/buried-await gap slice 3's
    // planLinearAwaits widening owns. This case pins only the routing.
    const wat = await watOf(`
      const g = async (): Promise<number> => (await Promise.resolve(41).then((x: number) => x + 0)) + 1;
      export function main(): number { g(); return 1; }
    `);
    expect(wat).not.toContain("__async_resume_fanon");
  });

  it("concise `=> await P` routing artifact: the arrow mints a resume fn", async () => {
    const wat = await watOf(`
      const g = async (x: number): Promise<number> => await Promise.resolve(x).then((y: number) => y + 1);
      export function main(): number { g(20); return 1; }
    `);
    expect(wat).toContain("__async_resume_fanon");
  });
});
