// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2959 — native `new Promise(executor)` for standalone / WASI mode.
//
// The executor pattern used to lower unconditionally to the `Promise_new`
// host import, leaving every executor-pattern promise host-bound even though
// the whole rest of the carrier ($Promise struct, resolve-value assimilation,
// reject, microtask ring, native .then/.catch) is already native.
//
// These tests prove:
//   1. LEAK-ELIM (load-bearing): a WASI executor program has ZERO `env`
//      imports — `Promise_new` is retired.
//   2. HOST-INERT: gc/host mode is byte-identical to before (still routes
//      `new Promise` through the `Promise_new` host import).
//   3. BEHAVIOUR: resolve-sync, reject, executor-throw→reject, double-settle,
//      resolve-with-a-promise (assimilation), and arity 0/1 executors all
//      behave to spec on `--target wasi`, host-free, and the GC binaries
//      validate + instantiate + run without trapping.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

function envImportNames(wat: string): string[] {
  const out: string[] = [];
  const re = /\(import\s+"env"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wat)) !== null) out.push(m[1]!);
  return out;
}

/** Compile a WASI program, instantiate the GC binary with empty import objects
 *  (the programs are host-free), run `_start`, and read back the exported
 *  `result()` i32. Returns { value, env } where `env` is the env-import list. */
async function runWasi(src: string): Promise<{ value: unknown; env: string[] }> {
  const r = await compile(src, { target: "wasi" });
  const errors = r.errors.filter((e) => e.severity === "error");
  expect(errors).toEqual([]);
  const env = envImportNames(r.wat);
  const mod = await WebAssembly.compile(r.binary);
  const importObject: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) (importObject[imp.module] ??= {})[imp.name] = () => {};
  const inst = await WebAssembly.instantiate(mod, importObject as WebAssembly.Imports);
  const exports = inst.exports as Record<string, CallableFunction>;
  if (typeof exports._start === "function") exports._start();
  const value = typeof exports.result === "function" ? exports.result() : undefined;
  return { value, env };
}

const reader = (executor: string, chain: string) => `
let captured = -1;
new Promise<number>(${executor})${chain};
export function result(): number { return captured; }
`;

describe("#2959 — native new Promise(executor) retires the Promise_new host import", () => {
  it("WASI executor program emits ZERO env imports (Promise_new retired)", async () => {
    const src = `const p = new Promise((resolve, reject) => { resolve(42); }); export function go(): number { return 1; }`;
    const r = await compile(src, { target: "wasi" });
    expect(r.success).toBe(true);
    expect(envImportNames(r.wat)).toEqual([]);
    // The binary must validate as WasmGC and instantiate host-free.
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("host (gc) mode is byte-inert — still routes new Promise through Promise_new", async () => {
    // The native path is gated on isStandalonePromiseActive (WASI only), so the
    // gc/host lane must be untouched: same host import, and a stable byte image
    // across repeat compiles (determinism proxy for the cross-tree sha check).
    const src = `const p = new Promise((resolve, reject) => { resolve(42); }); export function go(): number { return 1; }`;
    const a = await compile(src, {});
    const b = await compile(src, {});
    expect(envImportNames(a.wat)).toContain("Promise_new");
    expect(createHash("sha256").update(a.binary).digest("hex")).toBe(
      createHash("sha256").update(b.binary).digest("hex"),
    );
  });

  it("resolve-sync fulfils and the value reaches .then (host-free)", async () => {
    const { value, env } = await runWasi(
      reader(`(resolve) => { resolve(7); }`, `.then((v: number) => { captured = v; })`),
    );
    expect(value).toBe(7);
    expect(env).toEqual([]);
  });

  it("reject rejects and the reason reaches .catch (host-free)", async () => {
    const { value, env } = await runWasi(
      reader(
        `(resolve, reject) => { reject(9); }`,
        `.then((v: number) => { captured = 100; }, (e: number) => { captured = e; })`,
      ),
    );
    expect(value).toBe(9);
    expect(env).toEqual([]);
  });

  it("executor throw-before-settle rejects (throw→reject wiring); reason reaches .catch", async () => {
    // Inject-throw execution proof: if the native path were vacuous (executor
    // body not actually run), `captured` would stay -1. It becomes 42, proving
    // the executor body executes and its throw is routed to reject.
    const { value, env } = await runWasi(
      reader(
        `(resolve, reject) => { throw 42; }`,
        `.then((v: number) => { captured = 100; }, (e: number) => { captured = e; })`,
      ),
    );
    expect(value).toBe(42);
    expect(env).toEqual([]);
  });

  it("double-settle is ignored — first settle wins", async () => {
    const { value, env } = await runWasi(
      reader(
        `(resolve, reject) => { resolve(3); reject(99); }`,
        `.then((v: number) => { captured = v; }, (e: number) => { captured = -e; })`,
      ),
    );
    expect(value).toBe(3);
    expect(env).toEqual([]);
  });

  it("resolve-with-a-promise assimilates the inner promise's eventual value", async () => {
    const src = `
let captured = -1;
const inner = new Promise<number>((res) => { res(11); });
new Promise<number>((resolve) => { resolve(inner); }).then((v: number) => { captured = v; });
export function result(): number { return captured; }
`;
    const { value, env } = await runWasi(src);
    expect(value).toBe(11);
    expect(env).toEqual([]);
  });

  it("arity-0 and arity-1 executors compile host-free and validate", async () => {
    for (const executor of ["() => {}", "(resolve) => { resolve(1); }"]) {
      const src = `const p = new Promise(${executor}); export function go(): number { return 1; }`;
      const r = await compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      expect(envImportNames(r.wat)).toEqual([]);
      expect(WebAssembly.validate(r.binary)).toBe(true);
    }
  });

  it("a non-resolvable executor (identifier-bound) still compiles (host fallback, not a crash)", async () => {
    // A variable-bound executor whose ClosureInfo we can't recover must fall
    // through to the host path — never a partial native path / compile crash.
    const src = `
function mk(): (r: (v: number) => void) => void { return (r) => { r(1); }; }
const ex = mk();
const p = new Promise(ex);
export function go(): number { return 1; }
`;
    const r = await compile(src, { target: "wasi" });
    expect(r.success).toBe(true);
  });
});
