import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// #3302 — standalone native lowering for CAPTURING generator FUNCTION
// EXPRESSIONS (#3178 slice S3). The lifted closure carries its captures as
// `__self` struct fields; the resume function re-materializes them from the
// rehydrated `__self` param (`NativeGeneratorInfo.selfCaptureRehydration`,
// mirroring the async drive lane's re-materialization, async-frame.ts #2865).
// This retires the eager-buffer HOST fallback for the dominant test262
// dstr-fixture IIFE (`var iter = function*(){ iterations += 1; }();`), which:
//   - leaked the `env::__gen_*` / `__get_caught_exception` import family into
//     standalone binaries (validate-but-can't-instantiate host-free), and
//   - ran the whole body at generator-object creation, violating ECMA-262
//     §27.5.3.1-3 (EvaluateGeneratorBody/GeneratorStart suspend at
//     start-of-body; nothing runs until the first next()) — the #3032 root.
//
// Also covered: the latent #3164 fill bug this exposed — a module whose ONLY
// step-driven carrier is a native sync generator hit `buildIteratorNextBody`'s
// vec-only early return (`sgDeps` missing from the guard), so `__iterator`
// wrapped the frame in a GENSTATE record but `__iterator_next` kept the
// vec-only body → `ref.as_non_null(null)` trap on the first for-of resume.

interface RunResult {
  value: unknown;
  genFamilyImports: string[];
  instantiatedHostFree: boolean;
}

async function run(source: string, opts: { standalone?: boolean } = {}): Promise<RunResult> {
  const result = await compile(source, {
    fileName: "test.ts",
    ...(opts.standalone ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  const genFamilyImports = WebAssembly.Module.imports(mod)
    .map((i) => `${i.module}::${i.name}`)
    .filter((n) => /__gen|__create_generator|__get_caught_exception|Promise_|__make_callback/.test(n));
  let instantiatedHostFree = false;
  if (opts.standalone) {
    try {
      await WebAssembly.instantiate(mod, {});
      instantiatedHostFree = true;
    } catch {
      instantiatedHostFree = false;
    }
  }
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return { value: (instance.exports as { test: () => unknown }).test(), genFamilyImports, instantiatedHostFree };
}

describe("#3302 — standalone native capturing generator fn-expressions", () => {
  it("the dstr-fixture IIFE is host-free, instantiates with {}, and is LAZY (§27.5)", async () => {
    const r = await run(
      `export function test(): number {
         var iterations = 0;
         var iter = function*() { iterations += 1; yield 1; }();
         return iterations * 100 + 1;
       }`,
      { standalone: true },
    );
    expect(r.genFamilyImports).toEqual([]);
    expect(r.instantiatedHostFree).toBe(true);
    expect(r.value).toBe(1); // creation ran NOTHING
  });

  it("for-of drain: values correct + mutable capture write-through (host-free)", async () => {
    const r = await run(
      `export function test(): number {
         let acc = 0;
         const n = 10;
         const g = function*() { acc += 1; yield n + 1; acc += 1; yield n + 2; acc += 1; };
         let sum = 0;
         for (const v of g()) sum += v;
         return sum * 10 + acc; // (11+12)*10 + 3 = 233
       }`,
      { standalone: true },
    );
    expect(r.genFamilyImports).toEqual([]);
    expect(r.instantiatedHostFree).toBe(true);
    expect(r.value).toBe(233);
  });

  it("minimal sgDeps-only module: for-of over an immutable-capture generator (the #3164 fill hole)", async () => {
    // This exact shape trapped (`dereferencing a null pointer` inside
    // __iterator_next) before the buildIteratorNextBody early-return fix:
    // no user/obj/host/asyncgen carrier exists, so the vec-only body dropped
    // the GENSTATE step while __iterator still wrapped the frame.
    const r = await run(
      `export function test(): number {
         const n = 10;
         const g = function*() { yield n + 1; yield n + 2; };
         let sum = 0;
         for (const v of g()) sum += v;
         return sum * 10; // (11+12)*10 = 230
       }`,
      { standalone: true },
    );
    expect(r.genFamilyImports).toEqual([]);
    expect(r.value).toBe(230);
  });

  it("first resume runs exactly to the first yield", async () => {
    const r = await run(
      `export function test(): number {
         let iterations = 0;
         var iter = function*() { iterations += 1; yield 5; }();
         const before = iterations;
         const r1 = iter.next();
         const after = iterations;
         return before * 100 + after * 10 + (r1.value === 5 ? 1 : 0);
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(11);
  });

  it("named capturing fn-expr (name unreferenced in body) drains correctly", async () => {
    const r = await run(
      `export function test(): number {
         let count = 0;
         const g = function* counter() { count += 1; yield count; count += 1; yield count; };
         let sum = 0;
         for (const v of g()) sum += v; // 1 + 2
         return sum * 10 + count; // 30 + 2
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(32);
  });

  it("TDZ-flagged capture reads back after initialization (flag box via __self field)", async () => {
    const r = await run(
      `export function test(): number {
         const g = function*() { yield x; };
         let x = 42;
         const it = g();
         return it.next().value as number;
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(42);
  });

  it("next(v) two-way communication reaches the suspended yield (impossible under the eager buffer)", async () => {
    const r = await run(
      `export function test(): number {
         let base = 100;
         const g: () => Generator<number, void, number> = function*() {
           const got = yield 1;
           yield base + got;
         };
         const it = g();
         it.next();
         return it.next(7).value as number;
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(107);
  });

  it("two instances share the capture cell (write-through identity)", async () => {
    const r = await run(
      `export function test(): number {
         let acc = 0;
         const g = function*() { acc += 1; yield acc; };
         const a = g();
         const b = g();
         const x = a.next().value as number; // acc 1
         const y = b.next().value as number; // acc 2
         return x * 10 + y + acc * 100; // 10 + 2 + 200
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(212);
  });

  // Host-lane control: the JS-host lowering (eager buffer + slice-1 lazy
  // thunk) is untouched by this change — behavior stays as on main.
  it("host lane: IIFE fixture stays lazy via the slice-1 thunk (control)", async () => {
    const r = await run(
      `export function test(): number {
         var iterations = 0;
         var iter = function*() { iterations += 1; yield 1; }();
         return iterations * 100 + 1;
       }`,
      {},
    );
    expect(r.value).toBe(1);
  });

  it("host lane: for-of drain + write-through (control)", async () => {
    const r = await run(
      `export function test(): number {
         let acc = 0;
         const n = 10;
         const g = function*() { acc += 1; yield n + 1; acc += 1; yield n + 2; acc += 1; };
         let sum = 0;
         for (const v of g()) sum += v;
         return sum * 10 + acc;
       }`,
      {},
    );
    expect(r.value).toBe(233);
  });
});
