// #2967 slice 1 — async engine convergence: the JS-host lane's single-tail-await
// population moves from the legacy `.then`-chaining CPS lane
// (`emitAsyncStateMachine`/`splitBodyAtAwait`) onto the #2906 N-state
// `$AsyncFrame` resume machine with the host settle backend (#1042), so ONE
// engine drives every linear shape (single-await is the N=1 case).
//
// The slice-1 carve-outs are all retired: lifted closures (slice 2a, #2873
// park-fix), concise arrow bodies (2b-1), binding-pattern params (2b-2,
// live-initialized spills), cell-boxed spills (phase 3a, force-boxed cell
// fields), and the class-2 ref-typed spill guess (#3134's Promise<T>
// value-slot rep fix). Slice 2c then DELETED the CPS engine
// (`emitAsyncStateMachine`/`compileSyntheticAsyncContinuation`/the `cps`
// lane): the frame engine is the sole JS-host suspension engine.
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

  it("a binding-pattern-param declaration drives the frame engine (slice 2b-2 — derived locals ride as live-initialized spills)", async () => {
    // Slice 1 kept this shape on CPS (the resume fn never saw the prologue-
    // derived locals); slice 2b-2 captures them into the frame, so the
    // carve-out is retired and the decl mints a resume fn like any other.
    const wat = await watOf(`
      async function f({ a }: { a: number }): Promise<number> {
        const v = await Promise.resolve(a).then((y: number) => y + 1);
        return v * 2;
      }
      export async function main(): Promise<number> { return await f({ a: 20 }); }
    `);
    expect(wat).toContain("__async_resume_ff");
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

describe("#2967 slice 2a PARK FIX (PR #2873, merge_group 29120059791)", () => {
  it("async fn-expr through a VOID-typed param after an `() => any` wrapper minted first (the 32-file null_deref: wrapper-order RTT mismatch)", async () => {
    // `firstMint` (`() => any`) compiles BEFORE `runVoid` (`() => void`), so the
    // externref-result wrapper struct is the chain ROOT and the void wrapper a
    // `sub final` SIBLING. The activated async closure allocates under the
    // externref wrapper (its rewritten Promise signature); pre-fix, runVoid's
    // cast to the void wrapper nulled out and the funcref fetch trapped
    // ("dereferencing a null pointer" — the asyncTest() harness cluster).
    // Post-fix the cast targets the wrapper root and the funcref sig-dispatch
    // picks the externref arm (result dropped — fire-and-forget semantics).
    const exports = await compileToWasm(`
      function firstMint(cb: () => any): any {
        return cb();
      }
      function runVoid(cb: () => void): void {
        cb();
      }
      let acc: number = 0;
      export function main(): any {
        firstMint(function (): any { return 1; });
        runVoid(async function (): Promise<void> {
          const a = await Promise.resolve(20).then((x: number) => x + 1);
          const b = await Promise.resolve(20).then((x: number) => x + 1);
          acc = a + b;
        });
        return 1;
      }
      export function readAcc(): number { return acc; }
    `);
    expect(exports.main()).toBe(1); // pre-fix: wasm trap here
    await new Promise((r) => setTimeout(r, 50)); // drain the host microtasks
    expect(exports.readAcc()).toBe(42);
  });

  it("a body local mutably captured by a NESTED fn and live across the await now DRIVES via a force-boxed cell field (#2967 phase 3a — the class-1 decline is retired)", async () => {
    // `flag` is cell-boxed by `set`'s creation. Pre-3a the frame spill field
    // was typed from the declaration (the struct.set[1] wasm_compile class),
    // so this body was DECLINED to CPS. 3a types the field as the ref CELL,
    // creates the cell at the entry struct.new, and routes the declaration
    // init / reads / writes / capture aliasing through boxedCaptures — so the
    // shape drives, validates, and the nested write is visible after resume.
    const wat = await watOf(`
      export function main(): any {
        const g = async function (): Promise<number> {
          let flag: number = 0;
          const set = function (): void { flag = 40; };
          set();
          const a = await Promise.resolve(2).then((x: number) => x + 0);
          return flag + a;
        };
        return g();
      }
    `);
    expect(wat).toContain("__async_resume_fanon");
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async function (): Promise<number> {
          let flag: number = 0;
          const set = function (): void { flag = 40; };
          set();
          const a = await Promise.resolve(2).then((x: number) => x + 0);
          return flag + a;
        };
        return g();
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a ref-typed spill guess (array-literal local live across the await) re-lanes off host-drive (rep-divergence hazard class)", async () => {
    // `resolveSpillLocalValType` guesses a typed vec for `arr` before the body
    // compiles; the body's inferred element rep can lawfully differ (the
    // fromAsync `const expected = [prom]` file, where the #3134 Promise unwrap
    // types the vec element as the unwrapped struct). Conservatively declined.
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async function (): Promise<number> {
          const arr: number[] = [40, 2];
          const a = await Promise.resolve(0).then((x: number) => x + 0);
          return arr[0] + arr[1] + a;
        };
        return g();
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
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

describe("#2967 slice 2b-2 — pattern/rest params on the frame engine", () => {
  it("object-pattern param decl routes host-drive and the derived bindings survive the await", async () => {
    const wat = await watOf(`
      async function f({ a, b }: { a: number; b: number }): Promise<number> {
        const x = await Promise.resolve(a).then((v: number) => v + 0);
        return x + b;
      }
      export function main(): any { return f({ a: 40, b: 2 }); }
    `);
    expect(wat).toContain("__async_resume_ff");
    const exports = await compileToWasm(`
      async function f({ a, b }: { a: number; b: number }): Promise<number> {
        const x = await Promise.resolve(a).then((v: number) => v + 0);
        return x + b;
      }
      export function main(): any { return f({ a: 40, b: 2 }); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("array-pattern param decl: derived bindings read AFTER the await", async () => {
    const exports = await compileToWasm(`
      async function f([a, b]: number[]): Promise<number> {
        const x = await Promise.resolve(2).then((v: number) => v + 0);
        return a + b + x;
      }
      export function main(): any { return f([30, 10]); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a derived binding MUTATED before the await keeps the mutation after resume (the CPS snapshot semantics — spill store-back)", async () => {
    const exports = await compileToWasm(`
      async function m({ a }: { a: number }): Promise<number> {
        a = a + 1;
        const x = await Promise.resolve(40).then((v: number) => v + 0);
        return a + x;
      }
      export function main(): any { return m({ a: 1 }); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("an identifier REST param is a raw wasm param (caller-built vec) — captured by name, drives fine", async () => {
    const exports = await compileToWasm(`
      async function r(...xs: number[]): Promise<number> {
        const x = await Promise.resolve(2).then((v: number) => v + 0);
        return xs[0] + xs[1] + x;
      }
      export function main(): any { return r(30, 10); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("MULTI-await pattern-param body (the pre-2b-2 host-drive derived-local gap) now delivers the derived value", async () => {
    // Pre-2b-2 this shape already routed host-drive (it was never CPS-shaped),
    // but the derived binding `a` was a default-initialized externref spill the
    // resume fn never saw a real value for. Live-initialized capture fixes it.
    const exports = await compileToWasm(`
      async function g({ a }: { a: number }): Promise<number> {
        const x = await Promise.resolve(20).then((v: number) => v + 0);
        const y = await Promise.resolve(20).then((v: number) => v + 0);
        return a + x + y;
      }
      export function main(): any { return g({ a: 2 }); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("concise arrow WITH a pattern param (2b-1 × 2b-2)", async () => {
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async ({ a }: { a: number }): Promise<number> => await Promise.resolve(a).then((y: number) => y * 2);
        return g({ a: 21 });
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a derived binding mutably captured by a NESTED fn now DRIVES and the through-cell mutation is CORRECT (#2967 phase 3a — fixes the CPS cell quirk)", async () => {
    // Pre-3a this shape was declined to CPS (patternParamCellHazard), where
    // the through-cell mutation was LOST (returned 1, not 42 — a pre-existing
    // CPS quirk, same on main's old pattern carve-out). 3a force-boxes the
    // derived binding into a live cell field: `bump`'s write lands in the
    // cell the frame restores after resume — routing AND value both fixed.
    const wat = await watOf(`
      async function h({ a }: { a: number }): Promise<number> {
        const bump = function (): void { a = 41; };
        bump();
        const x = await Promise.resolve(1).then((v: number) => v + 0);
        return a + x;
      }
      export function main(): any { return h({ a: 0 }); }
    `);
    expect(wat).toContain("__async_resume_fh");
    const exports = await compileToWasm(`
      async function h({ a }: { a: number }): Promise<number> {
        const bump = function (): void { a = 41; };
        bump();
        const x = await Promise.resolve(1).then((v: number) => v + 0);
        return a + x;
      }
      export function main(): any { return h({ a: 0 }); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });
});

describe("#2967 phase 3a — cell-aware frame layout (force-boxed class-1 spills)", () => {
  it("cell IDENTITY survives the suspend: a nested closure's writes before AND after the await accumulate", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        let acc: number = 0;
        const add = function (n: number): void { acc = acc + n; };
        add(20);
        const x = await Promise.resolve(2).then((v: number) => v + 0);
        add(20);
        return acc + x;
      }
      export function main(): any { return f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a force-boxed RESUME BINDING is delivered THROUGH the cell (emitDeliver struct.set) and the nested write persists across the later await", async () => {
    const exports = await compileToWasm(`
      async function g(): Promise<number> {
        let x: number = await Promise.resolve(20).then((v: number) => v + 0);
        const bump = function (): void { x = x + 1; };
        bump();
        const y = await Promise.resolve(21).then((v: number) => v + 0);
        return x + y;
      }
      export function main(): any { return g(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("multi-await: the nested closure reads the POST-resume value written by a later state", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        let acc: number = 1;
        const read = function (): number { return acc; };
        const a = await Promise.resolve(20).then((v: number) => v + 0);
        acc = a + 1;
        const b = await Promise.resolve(20).then((v: number) => v + 0);
        return read() + b + 1;
      }
      export function main(): any { return f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });
});

describe("#2967 slice 2c — the CPS engine is DELETED; one frame engine", () => {
  it("a single-tail-await DECLARATION mints a resume fn + a pending result promise (no CPS fallback)", async () => {
    const wat = await watOf(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(20).then((x: number) => x + 1);
        return a * 2;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    expect(wat).toContain("__async_resume_ff");
    // The deleted CPS driver chained via Promise_then2 from an exported
    // continuation; the frame engine settles a pre-allocated pending promise.
    expect(wat).toContain("Promise_new_pending");
  });

  it("the former class-2 shape (a Promise<T> vec element live across the await) now DRIVES a closure and resolves (#3134 unblock)", async () => {
    const wat = await watOf(`
      export function main(): any {
        const g = async function (): Promise<number> {
          const p = Promise.resolve(40).then((x: number) => x + 0);
          const expected = [p];
          const first = await expected[0];
          const a = await Promise.resolve(2).then((x: number) => x + 0);
          return first + a;
        };
        return g();
      }
    `);
    expect(wat).toContain("__async_resume_fanon");
    const exports = await compileToWasm(`
      export function main(): any {
        const g = async function (): Promise<number> {
          const p = Promise.resolve(40).then((x: number) => x + 0);
          const expected = [p];
          const first = await expected[0];
          const a = await Promise.resolve(2).then((x: number) => x + 0);
          return first + a;
        };
        return g();
      }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a discarded-tail bare await in a CLOSURE (the former 2957 CPS-emit re-park) settles correctly on the frame engine", async () => {
    const exports = await compileToWasm(`
      let acc: number = 0;
      export function main(): any {
        const cb = async function (): Promise<void> {
          await Promise.resolve(0).then((x: number) => { acc = 42; return x; });
        };
        return cb();
      }
      export function readAcc(): number { return acc; }
    `);
    await settled(exports.main());
    await new Promise((r) => setTimeout(r, 30));
    expect(exports.readAcc()).toBe(42);
  });
});
