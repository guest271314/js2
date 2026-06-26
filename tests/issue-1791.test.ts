// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1791 — `node:path` as a pure-TS posix shim compiled into the module.
//
// `path` is pure string compute (no I/O), so a single TS port serves BOTH the
// JS-host and standalone (WASI) targets — no host import, no standalone trap.
// This is the highest-leverage Node builtin (blocks ESLint/prettier/TS). The
// covered surface is exactly what ESLint + deps call
// (resolve/sep/join/dirname/relative/isAbsolute/extname/normalize) plus
// `basename` (Tier 0). win32 + `path.posix`/`path.win32`/`parse`/`format` are
// deferred; a default import that uses any of those stays on the legacy host
// `__node_path` path (no regression).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

/** Compile + instantiate in JS-host (gc) mode; call a numeric `test()`. */
async function runHost(src: string): Promise<number> {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => number>).test();
}

/** Compile + instantiate in standalone (--target wasi) mode; call `test()`. */
async function runWasi(src: string): Promise<number> {
  const result = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  // Pure-compute test functions don't call I/O, but the module may still import
  // wasi_snapshot_preview1 entries; supply no-op stubs for any imported name.
  const noop = () => 0;
  const stub = new Proxy({}, { get: () => noop });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {
    wasi_snapshot_preview1: stub,
    env: stub,
  });
  return (instance.exports.test as () => number)();
}

/** Run the same snippet in both modes; both must return 1. */
async function bothModes(src: string): Promise<{ host: number; wasi: number }> {
  return { host: await runHost(src), wasi: await runWasi(src) };
}

describe("#1791 node:path posix shim — Tier 0 (default import)", () => {
  it("covers join/basename/dirname/extname/resolve/sep/isAbsolute/normalize", async () => {
    const src = `
      import path from "node:path";
      export function test(): number {
        if (path.join("/a", "b", "../c") !== "/a/c") return 10;
        if (path.basename("/foo/bar.ts", ".ts") !== "bar") return 11;
        if (path.dirname("/foo/bar.ts") !== "/foo") return 12;
        if (path.extname("/foo/bar.ts") !== ".ts") return 13;
        if (path.resolve("/a", "b") !== "/a/b") return 14;
        if (path.sep !== "/") return 15;
        if (path.isAbsolute("/x")) {} else { return 16; }
        if (path.isAbsolute("x")) { return 17; }
        if (path.normalize("/a/./b/../c") !== "/a/c") return 18;
        if (path.basename("/foo/bar.ts") !== "bar.ts") return 19;
        return 1;
      }
    `;
    const { host, wasi } = await bothModes(src);
    expect(host).toBe(1);
    expect(wasi).toBe(1);
  });

  it("relative computes the posix relative path", async () => {
    const src = `
      import path from "node:path";
      export function test(): number {
        if (path.relative("/a/b/c", "/a/b/d") !== "../d") return 20;
        if (path.relative("/a/b", "/a/b/c/d") !== "c/d") return 21;
        return 1;
      }
    `;
    const { host, wasi } = await bothModes(src);
    expect(host).toBe(1);
    expect(wasi).toBe(1);
  });
});

describe("#1791 node:path posix shim — Tier 0 (named imports)", () => {
  it("named { join, basename, dirname, extname, resolve, isAbsolute, normalize }", async () => {
    const src = `
      import { join, basename, dirname, extname, resolve, isAbsolute, normalize } from "node:path";
      export function test(): number {
        if (join("/a", "b", "../c") !== "/a/c") return 30;
        if (basename("/foo/bar.ts", ".ts") !== "bar") return 31;
        if (dirname("/foo/bar.ts") !== "/foo") return 32;
        if (extname("/foo/bar.ts") !== ".ts") return 33;
        if (resolve("/a", "b") !== "/a/b") return 34;
        if (isAbsolute("/x")) {} else { return 35; }
        if (normalize("a/b/../c") !== "a/c") return 36;
        return 1;
      }
    `;
    const { host, wasi } = await bothModes(src);
    expect(host).toBe(1);
    expect(wasi).toBe(1);
  });

  it("default and named forms agree on the same input", async () => {
    const src = `
      import path from "node:path";
      import { join } from "node:path";
      export function test(): number {
        return path.join("/x", "y") === join("/x", "y") ? 1 : 40;
      }
    `;
    const { host, wasi } = await bothModes(src);
    expect(host).toBe(1);
    expect(wasi).toBe(1);
  });
});

describe("#1791 node:path posix shim — edge cases", () => {
  it("join collapses '.' and trailing slashes", async () => {
    const src = `
      import path from "node:path";
      export function test(): number {
        if (path.join("foo", ".", "bar") !== "foo/bar") return 50;
        if (path.join("/", "foo") !== "/foo") return 51;
        if (path.join("a", "") !== "a") return 52;
        return 1;
      }
    `;
    const { host, wasi } = await bothModes(src);
    expect(host).toBe(1);
    expect(wasi).toBe(1);
  });

  it("extname/dirname corner cases", async () => {
    const src = `
      import path from "node:path";
      export function test(): number {
        if (path.extname("index") !== "") return 60;
        if (path.extname(".gitignore") !== "") return 61;
        if (path.extname("a.b.c") !== ".c") return 62;
        if (path.dirname("foo") !== ".") return 63;
        if (path.dirname("/foo") !== "/") return 64;
        return 1;
      }
    `;
    const { host, wasi } = await bothModes(src);
    expect(host).toBe(1);
    expect(wasi).toBe(1);
  });
});
