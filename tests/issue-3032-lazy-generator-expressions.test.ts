/**
 * #3032 — lazy-first-resume generator-expression thunks (#2141 S2 relying-site fix).
 *
 * The eager-buffer lowering ran a generator EXPRESSION's body AT CREATION
 * (spec §27.5: nothing may run until the first `next()`). The test262 dstr
 * fixture `var iter = function*() { iterations += 1; }();` therefore had
 * `iterations === 1` before any resume — a latent failure masked only by the
 * tag-5 comparator vacuity (see #2141 S2 / #2626). Zero-param non-async
 * generator expressions now return a LAZY thunk generator: the host
 * materializes the buffer on the first `next()` by re-invoking the closure
 * through `__call_fn_0` with the `__gen_set_eager` flag held.
 *
 * `return()`/`throw()` before the first `next()` complete the generator
 * WITHOUT running the body (§27.5.3.2 GeneratorResumeAbrupt, suspendedStart).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target?: "standalone"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...(target ? { target } : {}) });
  if (!r.success) throw new Error(r.errors[0]?.message ?? "compile error");
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // (#3032) Lazy thunks resume through __call_fn_0/__gen_set_eager exports.
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#3032 — lazy generator-expression thunks", () => {
  it("creation runs NOTHING (module-any target — the test262 dstr fixture shape)", async () => {
    // Pre-fix this returned 2 (whole body incl. past the yield ran at creation).
    const src = `
      let log: number = 0;
      let g: any;
      export function test(): number {
        g = function*() { log = 1; yield 5; log = 2; }();
        return log;
      }
    `;
    expect(await run(src, "standalone")).toBe(0);
  });

  it("creation runs NOTHING (const local target)", async () => {
    const src = `
      let log: number = 0;
      export function test(): number {
        const g = function*() { log = 1; yield 5; log = 2; }();
        return log;
      }
    `;
    expect(await run(src, "standalone")).toBe(0);
  });

  it("first next() suspends at the first yield (native state machine, #3164)", async () => {
    // (#3164) This shape now routes through the NATIVE generator state machine
    // (the fn-expr closure emits the state-struct factory), which is truly
    // lazy AND suspends at each yield: after the first next() the body has run
    // only up to `yield 5`, so `log === 1` — the spec §27.5 semantics. The
    // pre-#3164 host eager-buffer thunk ran the WHOLE body on the first
    // resume (`mid === 2`, "buffered semantics"); that approximation is gone
    // for admitted fn-exprs.
    const src = `
      let log: number = 0;
      let mid: number = -1;
      export function test(): number {
        const g = function*() { log = 1; yield 5; yield 7; log = 2; }();
        const before = log;                    // 0 (lazy)
        const a = g.next();                    // 5
        mid = log;                             // 1 (suspended at the first yield)
        const b = g.next();                    // 7
        const c = g.next();                    // done
        const d = g.next();                    // done
        return before * 100000 + (a.value as number) * 10000 + (b.value as number) * 1000
          + mid * 100 + (c.done ? 10 : 0) + (d.done ? 1 : 0);
      }
    `;
    expect(await run(src, "standalone")).toBe(57111);
  });

  it("return() before first next() never runs the body (§27.5.3.2)", async () => {
    const src = `
      let log: number = 0;
      export function test(): number {
        const g = function*() { log = 1; yield 5; }();
        g.return(42);
        return log; // must stay 0 — abrupt completion of suspendedStart runs nothing
      }
    `;
    expect(await run(src, "standalone")).toBe(0);
  });

  // NOTE: a matching `throw()`-before-first-`next()` pin is deferred to #3032
  // W5 — `Generator.prototype.throw` from wasm currently rethrows a host-side
  // value that the compiled `try/catch` cannot catch (pre-existing marshalling
  // wart, identical on main), so the post-throw `log` read is unreachable
  // in-wasm. The host-side thunk-drop on `throw` shares its code path with
  // `return()` (pinned above).

  it("pending-throw semantics preserved through the lazy hop (#928)", async () => {
    const src = `
      export function test(): number {
        var threw = false;
        var iter = function*() { throw new TypeError("gen error"); }();
        try { iter.next(); } catch (e) { threw = true; }
        return threw ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("empty array-binding-pattern default does not iterate (the dstr canary shape)", async () => {
    const src = `
      let iterations: number = 0;
      let iter: any;
      let callCount: number = 0;
      export function test(): number {
        iter = function*() { iterations += 1; }();
        class C {
          method([] = iter) { callCount = callCount + 1; }
        }
        new C().method();
        // [] = iter obtains the iterator but performs zero next() calls —
        // and the LAZY generator body must not have run at creation either.
        return iterations * 10 + callCount;
      }
    `;
    expect(await run(src, "standalone")).toBe(1);
  });

  it("named/declared generators keep their (already-correct) lazy semantics", async () => {
    const src = `
      let log: number = 0;
      function* gen() { log = 1; yield 5; log = 2; }
      export function test(): number {
        const g = gen();
        return log;
      }
    `;
    expect(await run(src, "standalone")).toBe(0);
  });
});
