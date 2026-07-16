import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// #3032 W3 — TDZ-flag capture boxes threaded through the native generator
// state machine (standalone lane), restoring §27.5 suspend-at-start:
// EvaluateGeneratorBody performs GeneratorStart, which SUSPENDS the generator
// at the start of its body — no body statement may run until the first
// `next()` (ES2026 §27.5.3.1-3; GeneratorResumeAbrupt on suspendedStart never
// runs the body at all). The eager-buffer lowering ran the WHOLE body at
// generator-object creation, which is the root of the tag-5 comparator
// vacuity (#2141 S2 / #2626): test262 dstr fixtures observe
// `iterations === 0` before the first resume.
//
// The dominant test262 shape is a nested capturing NAMED generator whose
// captures are `let`/`const` (TDZ-flagged) bindings of the `test()` wrapper.
// #3050's capturingNativeGen gated those out (`tdzFlaggedCaptures.length ===
// 0`) because the resume fn did not thread TDZ flag boxes; W3 threads them as
// additional leading `ref $cell<i32>` params (the #1205 Stage 3 layout
// [valueCaps, tdzFlagBoxes, userParams]) and relaxes the standalone-lane gate
// to candidate-only (matching the no-captures branch). The JS-host lane keeps
// the #3050 gate byte-identical (try-region shapes, tdz === 0).
//
// Also covered here: the speculative-rollback hole this exposed (#1847/#1919
// lineage) — `restoreLocals` did not restore `boxedTdzFlags`/`tdzFlagLocals`,
// so a rolled-back probe of a call with TDZ-flagged nested captures left both
// maps aimed at truncated local slots and the committed re-compile baked
// `local.get <stale slot>` → invalid wasm. That one bit BOTH lanes (the
// host-lane for-of shape below was `any.convert_extern`-invalid on main).

async function run(source: string, opts: { standalone?: boolean } = {}): Promise<unknown> {
  const result = await compile(source, {
    fileName: "test.ts",
    ...(opts.standalone ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

const MODES: Array<{ name: string; standalone?: boolean }> = [
  { name: "host" },
  { name: "standalone", standalone: true },
];

describe("#3032 W3 — nested capturing generator laziness (standalone) + TDZ threading", () => {
  // ── Lazy creation (§27.5): the body must NOT run at generator creation ──
  // Standalone-lane only: the JS-host lane deliberately keeps the #3050
  // eager path for non-try-region shapes (byte-identical; its laziness is a
  // separate wave — see the issue file).
  it("standalone: creation runs NOTHING (iterations === 0 before first next)", async () => {
    expect(
      await run(
        `export function test(): number {
           let iterations = 0;
           function* g() {
             iterations += 1;
             yield 1;
             iterations += 1;
           }
           const it = g();
           return iterations * 100 + 1;
         }`,
        { standalone: true },
      ),
    ).toBe(1);
  });

  it("standalone: first resume runs exactly to the first yield", async () => {
    expect(
      await run(
        `export function test(): number {
           let iterations = 0;
           function* g() {
             iterations += 1;
             yield 5;
           }
           const it = g();
           const before = iterations;      // 0 under §27.5
           const r1 = it.next();           // runs to yield 5 → iterations 1
           const after = iterations;       // 1
           return before * 100 + after * 10 + (r1.value === 5 ? 1 : 0);
         }`,
        { standalone: true },
      ),
    ).toBe(11);
  });

  // ── Drain + capture writes propagate (BOTH lanes) ──
  // This shape (for-of over a call of a nested generator with TDZ-flagged
  // captures) was INVALID WASM on main in BOTH lanes — the speculative
  // for-of probe leaked re-aimed `boxedTdzFlags`/`tdzFlagLocals` entries at
  // truncated local slots (restoreLocals didn't cover the TDZ maps). The
  // locals-snapshot fix repairs the host lane; the native threading makes the
  // standalone lane lazy as well.
  for (const mode of MODES) {
    it(`${mode.name}: drain yields correct values and mutable TDZ-flagged capture writes propagate`, async () => {
      expect(
        await run(
          `export function test(): number {
             let acc = 0;
             const n = 10;
             function* g() {
               acc += 1;
               yield n + 1;
               acc += 1;
               yield n + 2;
               acc += 1;
             }
             let sum = 0;
             for (const v of g()) sum += v;
             return sum * 10 + acc; // (11+12)*10 + 3 = 233
           }`,
          mode,
        ),
      ).toBe(233);
    });

    // ── No-capture control: byte-of-behavior identical ──
    it(`${mode.name}: no-capture nested generator control stays correct`, async () => {
      expect(
        await run(
          `export function test(): number {
             function* g() {
               yield 1;
               yield 2;
             }
             let sum = 0;
             for (const v of g()) sum += v;
             return sum;
           }`,
          mode,
        ),
      ).toBe(3);
    });

    // ── TDZ-flagged capture, initialized before drain (happy path) ──
    it(`${mode.name}: TDZ-flagged capture reads back after initialization`, async () => {
      expect(
        await run(
          `export function test(): number {
             function* probe() { yield x; }
             let x = 42;
             const it2 = probe();
             const r = it2.next();
             return (r.value as number) + (r.done ? 100 : 0);
           }`,
          mode,
        ),
      ).toBe(42);
    });
  }

  // ── try-region + TDZ-flagged captures (standalone) ──
  // #3050's try-region machinery with the previously-gated-out TDZ captures:
  // catch-across-yield with a mutable `let` capture must route native in
  // standalone AND stay lazy.
  it("standalone: try-region generator with TDZ-flagged capture is lazy and drains correctly", async () => {
    expect(
      await run(
        `export function test(): number {
           let log = 0;
           function* g() {
             try {
               log += 1;
               yield 1;
               log += 10;
               yield 2;
             } finally {
               log += 100;
             }
           }
           const it = g();
           const atCreation = log;          // 0 — nothing ran
           let sum = 0;
           for (const v of g()) sum += v;   // 1 + 2; log: +1 +10 +100
           return atCreation * 1000 + sum * 100 + log; // 0*1000 + 300 + 111
         }`,
        { standalone: true },
      ),
    ).toBe(411);
  });

  // ── Two-way communication (impossible under the eager buffer) ──
  // NOTE: the resume-binding must be the typed `const got = yield e` shape —
  // an `(yield e) as number` initializer does not match the plan builder's
  // resume-binding pattern (pre-existing, orthogonal gap; sent value reads 0).
  it("standalone: next(v) value reaches the suspended yield in a TDZ-capturing generator", async () => {
    expect(
      await run(
        `export function test(): number {
           let base = 100;
           function* g(): Generator<number, void, number> {
             const got = yield 1;
             yield base + got;
           }
           const it = g();
           it.next();                 // → 1, suspended at first yield
           const r = it.next(7);      // got = 7 → yields 107
           return r.value as number;
         }`,
        { standalone: true },
      ),
    ).toBe(107);
  });
});
