// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3359 — Array.prototype callback methods must thread their `thisArg` (2nd arg)
// into the callback's `this`. Root cause: a TypeScript `this` parameter
// (`function (this: T, x) {…}`) is type-level only, but codegen emitted it as a
// REAL leading runtime param of the lifted closure, shifting every user param
// one slot right. The array-method call site supplies the spec `thisArg` via the
// `__current_this` global (not a positional arg), so the element landed in the
// `this` slot and `thisArg` was dropped — the predicate read `this.<prop>` as
// undefined. Fix: `runtimeParameters()` strips a leading TS `this` param from the
// closure's runtime signature, so `this` correctly resolves to `__current_this`.
//
// Scope: this covers the DIRECT array-receiver form (`a.filter(cb, thisArg)`) on
// both the host/gc and standalone lanes, for every thisArg-taking callback
// method. The borrowed array-like form
// (`Array.prototype.filter.call(arrayLike, cb, thisArg)`) has a SEPARATE residual
// in the array-like borrow dispatch and stays tracked in #3359 (see the skipped
// case in tests/issue-2036.test.ts).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runHost(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile failed: " + r.errors.map((e) => e.message).join("\n"));
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) throw new Error("compile failed: " + r.errors.map((e) => e.message).join("\n"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const CASES: { name: string; body: string; expected: number }[] = [
  {
    name: "filter threads thisArg (predicate reads this.t)",
    body: `export function test(): number {
      const a = [5, 15];
      const r: any = a.filter(function (this: any, x: number) { return x > this.t; }, { t: 10 });
      return r.length;
    }`,
    expected: 1,
  },
  {
    name: "map threads thisArg",
    body: `export function test(): number {
      const a = [1, 2];
      const r: any = a.map(function (this: any, x: number) { return x + this.t; }, { t: 10 });
      return (r[0] as number) + (r[1] as number);
    }`,
    expected: 23,
  },
  {
    name: "some threads thisArg",
    body: `export function test(): number {
      const a = [5, 15];
      return a.some(function (this: any, x: number) { return x > this.t; }, { t: 10 }) ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "every threads thisArg",
    body: `export function test(): number {
      const a = [11, 15];
      return a.every(function (this: any, x: number) { return x > this.t; }, { t: 10 }) ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "find threads thisArg",
    body: `export function test(): number {
      const a = [5, 15];
      const r: any = a.find(function (this: any, x: number) { return x > this.t; }, { t: 10 });
      return r as number;
    }`,
    expected: 15,
  },
  {
    name: "findIndex threads thisArg",
    body: `export function test(): number {
      const a = [5, 15];
      return a.findIndex(function (this: any, x: number) { return x > this.t; }, { t: 10 });
    }`,
    expected: 1,
  },
  {
    name: "forEach threads thisArg",
    body: `export function test(): number {
      const a = [5, 15];
      let seen = 0;
      a.forEach(function (this: any, x: number) { if (this.t === 10) seen++; }, { t: 10 });
      return seen;
    }`,
    expected: 2,
  },
  {
    name: "this-param strip preserves user params (index + array still read)",
    body: `export function test(): number {
      const a = [10, 20];
      let s = 0;
      a.forEach(function (this: any, v: number, i: number) { s += v + i + this.b; }, { b: 100 });
      return s; // (10+0+100) + (20+1+100) = 231
    }`,
    expected: 231,
  },
];

describe("#3359 — array-method callbacks thread thisArg into `this` (real-array form)", () => {
  for (const c of CASES) {
    it(`host: ${c.name}`, async () => {
      expect(await runHost(c.body)).toBe(c.expected);
    });
    it(`standalone: ${c.name}`, async () => {
      expect(await runStandalone(c.body)).toBe(c.expected);
    });
  }
});
