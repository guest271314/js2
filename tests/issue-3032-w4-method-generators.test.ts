import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// #3032 W4 — capturing METHOD generators (class + object-literal) lower
// natively in the standalone lane.
//
// Pre-W4, `isNativeGeneratorCandidate` bailed any method generator whose body
// captures an enclosing-function binding (`generatorCapturesOuterScope`) to
// the eager-buffer host path — which ran the WHOLE body at generator-object
// creation (ECMA-262 §27.5.3.1-3: EvaluateGeneratorBody/GeneratorStart
// suspend at start-of-body; nothing runs until the first `next()`) and
// dragged the `env::__gen_*` import family into standalone binaries.
//
// The key insight (verified before relaxing the gate): a method body never
// receives captures as params — it resolves them through the #2029/#3039
// promotion machinery (`ctx.capturedBoxGlobals`/`capturedGlobals` MODULE
// GLOBALS), which is fctx-independent. The resume function compiles the same
// body statements with the same global reads/writes, so no capture threading
// was needed at all — only the standalone-lane gate term. The JS-host lane is
// byte-identical (method generators are never candidates under a JS host —
// the host-lane candidate block admits only FunctionDeclarations).

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
    .filter((n) => /__gen|__create_generator|__get_caught_exception/.test(n));
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

describe("#3032 W4 — capturing method generators native in standalone", () => {
  it("class method: creation runs NOTHING (§27.5), host-free, instantiates with {}", async () => {
    const r = await run(
      `export function test(): number {
         let iterations = 0;
         class C {
           *m() { iterations += 1; yield 1; }
         }
         const it = new C().m();
         return iterations * 100 + 1;
       }`,
      { standalone: true },
    );
    expect(r.genFamilyImports).toEqual([]);
    expect(r.instantiatedHostFree).toBe(true);
    expect(r.value).toBe(1);
  });

  it("object-literal method: lazy, host-free, instantiates with {}", async () => {
    const r = await run(
      `export function test(): number {
         let iterations = 0;
         const obj = { *m() { iterations += 1; yield 1; } };
         const it = obj.m();
         return iterations * 100 + 1;
       }`,
      { standalone: true },
    );
    expect(r.genFamilyImports).toEqual([]);
    expect(r.instantiatedHostFree).toBe(true);
    expect(r.value).toBe(1);
  });

  it("object-literal method drain: values + capture write-through (was NaN on main)", async () => {
    const r = await run(
      `export function test(): number {
         let acc = 0;
         const n = 10;
         const obj = { *m() { acc += 1; yield n + 1; acc += 1; yield n + 2; acc += 1; } };
         let sum = 0;
         for (const v of obj.m()) sum += v;
         return sum * 10 + acc; // (11+12)*10 + 3
       }`,
      { standalone: true },
    );
    expect(r.genFamilyImports).toEqual([]);
    expect(r.value).toBe(233);
  });

  it("capture + this coexist (receiver via synthesizedThis, capture via promotion global)", async () => {
    const r = await run(
      `export function test(): number {
         let bonus = 5;
         class C {
           x = 10;
           *m() { yield this.x + bonus; bonus += 1; yield this.x + bonus; }
         }
         const c = new C();
         let sum = 0;
         for (const v of c.m()) sum += v; // 15 + 16
         return sum * 10 + bonus; // 310 + 6
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(316);
  });

  it("capture + user param", async () => {
    const r = await run(
      `export function test(): number {
         let base = 100;
         class C { *m(k: number) { yield base + k; } }
         return new C().m(7).next().value as number;
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(107);
  });

  it("static method generator with mutable capture", async () => {
    const r = await run(
      `export function test(): number {
         let n = 3;
         class C { static *m() { yield n; n += 1; yield n; } }
         let sum = 0;
         for (const v of C.m()) sum += v; // 3 + 4
         return sum * 10 + n; // 70 + 4
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(74);
  });

  it("write-through visibility at each suspension", async () => {
    const r = await run(
      `export function test(): number {
         let acc = 0;
         const o = { *m() { acc += 1; yield 1; acc += 10; } };
         const it = o.m();
         it.next();
         const mid = acc;        // 1 — only the pre-yield statement ran
         it.next();              // acc += 10 → 11
         return mid * 100 + acc; // 111
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(111);
  });

  it("next(v) two-way communication on a capturing method", async () => {
    const r = await run(
      `export function test(): number {
         let base = 100;
         class C {
           *m(): Generator<number, void, number> {
             const got = yield 1;
             yield base + got;
           }
         }
         const it = new C().m();
         it.next();
         return it.next(7).value as number;
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(107);
  });

  it("try/finally across yield with capture (the #3050 machinery on methods)", async () => {
    const r = await run(
      `export function test(): number {
         let log = 0;
         const o = { *m() { try { log += 1; yield 1; log += 10; } finally { log += 100; } } };
         let sum = 0;
         for (const v of o.m()) sum += v;
         return sum * 1000 + log; // 1000 + 111
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(1111);
  });

  it("two capturing generator methods in one class", async () => {
    const r = await run(
      `export function test(): number {
         let a = 1;
         let b = 2;
         class C { *m1() { yield a; } *m2() { yield b; } }
         const c = new C();
         return (c.m1().next().value as number) * 10 + (c.m2().next().value as number);
       }`,
      { standalone: true },
    );
    expect(r.value).toBe(12);
  });

  // Host-lane control: method generators are never native candidates under a
  // JS host (the host-lane candidate block admits only FunctionDeclarations),
  // so the eager path is byte-identical — this pins the drain behavior.
  it("host lane: capturing method drain unchanged (control)", async () => {
    const r = await run(
      `export function test(): number {
         let acc = 0;
         const n = 10;
         const obj = { *m() { acc += 1; yield n + 1; acc += 1; yield n + 2; acc += 1; } };
         let sum = 0;
         for (const v of obj.m()) sum += v;
         return sum * 10 + acc;
       }`,
      {},
    );
    expect(r.value).toBe(233);
  });
});
