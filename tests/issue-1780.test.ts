import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Target = "standalone" | "wasi";

async function compileOk(src: string, target: Target, fileName: string) {
  const result = await compile(src, { fileName, target });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

function importNames(binary: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(binary)).map((i) => `${i.module}.${i.name}`);
}

function expectNoHostImports(binary: Uint8Array, wat: string): void {
  // No TextEncoder_* host imports, and `.read`/`.written` must resolve to
  // struct.get rather than the generic `__extern_get` host import (unavailable
  // standalone/WASI). Acceptance: works without adding host imports.
  expect(wat).not.toContain("TextEncoder_");
  expect(importNames(binary)).not.toContain("env.__extern_get");
}

function run(binary: Uint8Array): Record<string, (...args: number[]) => number> {
  return new WebAssembly.Instance(new WebAssembly.Module(binary), {}).exports as Record<
    string,
    (...args: number[]) => number
  >;
}

describe("#1780 TextEncoder.encodeInto under standalone and WASI", () => {
  for (const target of ["standalone", "wasi"] as const) {
    it(`encodes ASCII, reports read/written, writes bytes in place (${target})`, async () => {
      const r = await compileOk(
        `export function written(): number {
          const d = new Uint8Array(10);
          return new TextEncoder().encodeInto("ABC", d).written;
        }
        export function read(): number {
          const d = new Uint8Array(10);
          return new TextEncoder().encodeInto("ABC", d).read;
        }
        export function byteAt(i: number): number {
          const d = new Uint8Array(10);
          new TextEncoder().encodeInto("ABC", d);
          return d[i];
        }`,
        target,
        `issue-1780-ascii-${target}.ts`,
      );
      expectNoHostImports(r.binary, r.wat);
      const ex = run(r.binary);
      expect(ex.written!()).toBe(3);
      expect(ex.read!()).toBe(3);
      expect([ex.byteAt!(0), ex.byteAt!(1), ex.byteAt!(2)]).toEqual([0x41, 0x42, 0x43]);
    });

    it(`encodes multibyte BMP + surrogate pairs; read counts UTF-16 units (${target})`, async () => {
      // "Aé你😀": A=1B, é=2B, 你=3B, 😀=4B (surrogate pair) → written=10, read=5
      const r = await compileOk(
        `export function written(): number {
          const d = new Uint8Array(20);
          return new TextEncoder().encodeInto("Aé你😀", d).written;
        }
        export function read(): number {
          const d = new Uint8Array(20);
          return new TextEncoder().encodeInto("Aé你😀", d).read;
        }`,
        target,
        `issue-1780-multibyte-${target}.ts`,
      );
      expectNoHostImports(r.binary, r.wat);
      const ex = run(r.binary);
      const native = new TextEncoder().encodeInto("Aé你😀", new Uint8Array(20));
      expect(ex.written!()).toBe(native.written);
      expect(ex.read!()).toBe(native.read);
    });

    it(`maps a lone high surrogate to U+FFFD (3 bytes, 1 read) (${target})`, async () => {
      const r = await compileOk(
        `export function written(): number {
          const d = new Uint8Array(8);
          return new TextEncoder().encodeInto("\\uD800", d).written;
        }
        export function read(): number {
          const d = new Uint8Array(8);
          return new TextEncoder().encodeInto("\\uD800", d).read;
        }`,
        target,
        `issue-1780-lone-surrogate-${target}.ts`,
      );
      const ex = run(r.binary);
      expect(ex.written!()).toBe(3);
      expect(ex.read!()).toBe(1);
    });

    it(`handles an empty source string (${target})`, async () => {
      const r = await compileOk(
        `export function written(): number {
          const d = new Uint8Array(4);
          return new TextEncoder().encodeInto("", d).written;
        }
        export function read(): number {
          const d = new Uint8Array(4);
          return new TextEncoder().encodeInto("", d).read;
        }`,
        target,
        `issue-1780-empty-${target}.ts`,
      );
      const ex = run(r.binary);
      expect(ex.written!()).toBe(0);
      expect(ex.read!()).toBe(0);
    });

    it(`never splits a code point when the buffer is too small (${target})`, async () => {
      // "Aé" into 2 bytes: 'A' (1B) fits, 'é' (2B) does not → written=1, read=1,
      // and the trailing byte stays untouched (0).
      const r = await compileOk(
        `export function written(): number {
          const d = new Uint8Array(2);
          return new TextEncoder().encodeInto("Aé", d).written;
        }
        export function read(): number {
          const d = new Uint8Array(2);
          return new TextEncoder().encodeInto("Aé", d).read;
        }
        export function secondByte(): number {
          const d = new Uint8Array(2);
          new TextEncoder().encodeInto("Aé", d);
          return d[1];
        }`,
        target,
        `issue-1780-too-small-${target}.ts`,
      );
      const ex = run(r.binary);
      expect(ex.written!()).toBe(1);
      expect(ex.read!()).toBe(1);
      expect(ex.secondByte!()).toBe(0);
    });
  }
});
