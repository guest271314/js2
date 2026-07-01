// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2907 — Standalone well-known-global bare-value carriers.
 *
 * A well-known global referenced as a FIRST-CLASS VALUE (not a method call or a
 * `new` callee) — `expectedError = TypeError`, `[TypeError, RangeError]`,
 * `Object.isFrozen(Math)`, `Object.getPrototypeOf(Reflect)` — used to leak an
 * `env.global_<Name>` host import under `--target standalone`, which has no JS
 * host to satisfy it. Root cause: the two `global_<Name>` emission loops in
 * codegen/index.ts guarded only on `strictNoHostImports` (auto-on for `wasi`,
 * NOT `standalone`), so standalone leaked the import.
 *
 * Fix:
 *  1. extend both loops' guard to `ctx.strictNoHostImports || ctx.standalone`
 *     so standalone stops importing the host constructor object; and
 *  2. materialize a native extensible `$Object` singleton carrier for the
 *     namespace globals `Math`/`JSON`/`Reflect` used as bare VALUES (via the
 *     existing #1888 `emitBuiltinNamespaceObject` infra), so value-used-as-object
 *     cases answer correctly host-free.
 *
 * Method/value bodies (`Math.*`, `JSON.*`, `Reflect.*`, native throw/catch,
 * `instanceof <Error>` static-tag resolution) already exist; this only wires the
 * bare-value binding. gc/host mode is untouched (all changes gated
 * `ctx.standalone`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<{ imports: number; globalImports: string[]; ret: unknown }> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error("CE: " + (r.errors?.[0]?.message ?? "unknown"));
  }
  const globalImports = (r.imports ?? [])
    .filter((i) => i.name.startsWith("global_"))
    .map((i) => `${i.module}::${i.name}`);
  // Instantiate with EMPTY imports — the standalone floor requires host-free.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ret = (instance.exports.test as (() => unknown) | undefined)?.();
  return { imports: (r.imports ?? []).length, globalImports, ret };
}

describe("#2907 standalone well-known-global bare-value carriers", () => {
  it("does not leak global_TypeError for a bare-value (indirect) TypeError reference", async () => {
    const src = `export function test(): number {
      const expectedError: any = TypeError;
      return expectedError ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.imports).toBe(0);
    expect(r.ret).toBe(1);
  });

  it("does not leak global_<Name> for an Error-family array literal", async () => {
    const src = `export function test(): number {
      const errs: any[] = [TypeError, RangeError, SyntaxError, ReferenceError, Error];
      return errs.length === 5 ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("bare TypeError is a truthy extensible carrier (Object.isFrozen(TypeError) === false)", async () => {
    const src = `export function test(): number {
      return (TypeError as any) && Object.isFrozen(TypeError as any) === false ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("keeps native throw/catch + static instanceof for the Error family host-free", async () => {
    const src = `export function test(): number {
      try {
        throw new RangeError("bad");
      } catch (e: any) {
        return e instanceof RangeError && e instanceof Error && e.message === "bad" ? 1 : 0;
      }
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("resolves bare Math to an extensible native singleton (Object.isFrozen(Math) === false)", async () => {
    const src = `export function test(): number {
      return Object.isFrozen(Math as any) === false ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("resolves bare Math to an extensible native singleton (Object.isSealed(Math) === false)", async () => {
    const src = `export function test(): number {
      return Object.isSealed(Math as any) === false ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("typeof Math === 'object' host-free", async () => {
    const src = `export function test(): number { return typeof Math === "object" ? 1 : 0; }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("does not hijack Math.* method/const fast paths", async () => {
    const src = `export function test(): number {
      return Math.PI > 3.14 && Math.PI < 3.15 && Math.max(2, 7, 3) === 7 && Math.floor(2.9) === 2 ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("does not hijack JSON.* method fast paths", async () => {
    const src = `export function test(): number {
      const o: any = JSON.parse('{"x":5}');
      return JSON.stringify([1, 2]) === "[1,2]" && o.x === 5 ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });

  it("does not hijack Reflect.* method fast paths", async () => {
    const src = `export function test(): number {
      const o: any = { a: 1, b: 2 };
      return Reflect.ownKeys(o).length === 2 && Reflect.has(o, "a") ? 1 : 0;
    }`;
    const r = await runStandalone(src);
    expect(r.globalImports).toEqual([]);
    expect(r.ret).toBe(1);
  });
});
