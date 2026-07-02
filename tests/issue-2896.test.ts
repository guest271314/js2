// (#2896) Standalone native function-object metadata: builtin function values
// answer their spec `name`/`length` own properties through the REFLECTIVE
// runtime paths (getOwnPropertyDescriptor / dynamic key read / hasOwnProperty /
// getOwnPropertyNames / delete), host-free.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports, "must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#2896 standalone builtin function-object metadata", () => {
  it("direct .length of a wired static method folds to its arity", async () => {
    expect(await runStandalone(`export function test(): number { return Array.isArray.length === 1 ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("getOwnPropertyDescriptor(fn, 'name') returns the spec data descriptor", async () => {
    const src = `export function test(): number {
      const d = Object.getOwnPropertyDescriptor(Array.isArray, "name");
      if (!d) return 0;
      if (d.value !== "isArray") return 2;
      if (d.writable !== false) return 3;
      if (d.enumerable !== false) return 4;
      if (d.configurable !== true) return 5;
      return 1;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("getOwnPropertyDescriptor(fn, 'length') returns the spec arity", async () => {
    const src = `export function test(): number {
      const d = Object.getOwnPropertyDescriptor(Array.isArray, "length");
      if (!d) return 0;
      return d.value === 1 && d.writable === false && d.configurable === true ? 1 : 2;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("reflective read works with RUNTIME receiver + key (the propertyHelper shape)", async () => {
    const src = `function probe(obj: any, key: any): any {
      return Object.getOwnPropertyDescriptor(obj, key);
    }
    export function test(): number {
      const d = probe(Array.isArray, "name");
      if (!d) return 0;
      return d.value === "isArray" ? 1 : 2;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("proto-method closures carry metadata too (String.prototype.charAt)", async () => {
    const src = `export function test(): number {
      const d = Object.getOwnPropertyDescriptor(String.prototype.charAt, "name");
      if (!d) return 0;
      return d.value === "charAt" ? 1 : 2;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("dynamic key read fn[k] resolves name host-free", async () => {
    const src = `export function test(): number {
      const k = "name";
      const fn: any = Array.isArray;
      return fn[k] === "isArray" ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("getOwnPropertyNames(fn) lists ['length','name'] in spec order", async () => {
    const src = `export function test(): number {
      const names = Object.getOwnPropertyNames(Array.isArray);
      if (names.length !== 2) return 2;
      return names[0] === "length" && names[1] === "name" ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("delete fn.name works (configurable) and only on that instance", async () => {
    const src = `export function test(): number {
      const fn: any = Array.isArray;
      const had = Object.getOwnPropertyDescriptor(fn, "name") !== undefined;
      const del = delete fn["name"];
      const gone = Object.getOwnPropertyDescriptor(fn, "name") === undefined;
      const lenKept = Object.getOwnPropertyDescriptor(fn, "length") !== undefined;
      return had && del && gone && lenKept ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("writes to fn.name do not stick (writable:false observable via read-back)", async () => {
    const src = `export function test(): number {
      const fn: any = Array.isArray;
      fn["name"] = "other";
      return fn["name"] === "isArray" ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("callback-passing a builtin method value still dispatches (meta subtype)", async () => {
    const src = `export function test(): number {
      const arr: any[] = [[1], 2];
      const out = arr.filter(Array.isArray);
      return out.length === 1 ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("gc (JS-host) mode is unaffected", async () => {
    const r = await compile(`export function test(): number { return Array.isArray([1]) ? 1 : 0; }`, {
      fileName: "test.ts",
    });
    expect(r.success).toBe(true);
  });
});
