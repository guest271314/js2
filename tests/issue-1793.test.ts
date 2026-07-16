// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1793 — node:buffer + global Buffer as a host class (Tier 0, JS-host lane).
//
// `Buffer` is added to BUILTIN_CLASS_NAMES (calls.ts), so the global
// identifier resolves via the `__get_builtin` host import (globalThis.Buffer)
// and statics (from/alloc/concat/...) dispatch through the generic
// host-delegated `__extern_method_call` arm. Instances are plain externrefs;
// instance methods (`toString`, property `length`) ride the existing
// any-receiver host dispatch. The named-import form
// (`import { Buffer } from "node:buffer"`) binds the same identifier text and
// therefore resolves to the same host class. Standalone/WASI Buffer is out of
// scope (tracked alongside #1471/#1472).

import { describe, expect, it } from "vitest";
import { compileAndRunRuntimeDeps as compileAndRun } from "./helpers/compile.js";

describe("#1793 — global Buffer host class (Tier 0)", () => {
  it("Buffer.from(string, encoding).toString(encoding) round-trips", async () => {
    const exports = await compileAndRun(`
      export function test(): string {
        const b = Buffer.from("hi", "utf-8");
        return b.toString("utf-8");
      }
    `);
    expect(exports.test!()).toBe("hi");
  });

  it("Buffer.concat([a, b]).length — wasm array literal crosses as a real list", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        const c = Buffer.concat([Buffer.from("a"), Buffer.from("b")]);
        return c.length;
      }
    `);
    expect(exports.test!()).toBe(2);
  });

  it("Buffer.from(byte array).toString() decodes utf-8", async () => {
    const exports = await compileAndRun(`
      export function test(): string {
        return Buffer.from([104, 105]).toString();
      }
    `);
    expect(exports.test!()).toBe("hi");
  });

  it("Buffer.alloc(n).length === n", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        return Buffer.alloc(4).length;
      }
    `);
    expect(exports.test!()).toBe(4);
  });

  it("import { Buffer } from 'node:buffer' resolves to the same host class", async () => {
    const exports = await compileAndRun(`
      import { Buffer } from "node:buffer";
      export function test(): number {
        return Buffer.alloc(3).length;
      }
    `);
    expect(exports.test!()).toBe(3);
  });

  it("concat result round-trips content, not just length", async () => {
    const exports = await compileAndRun(`
      export function test(): string {
        return Buffer.concat([Buffer.from("he"), Buffer.from("llo")]).toString("utf-8");
      }
    `);
    expect(exports.test!()).toBe("hello");
  });

  it("a wasm-side Uint8Array crosses the host boundary value-faithfully (Buffer.from reads its bytes)", async () => {
    // TypedArrays are wasm-NATIVE structs in this compiler, so the host
    // boundary marshals them (Buffer.from(u) sees the right bytes). A true
    // ZERO-COPY Buffer view (mutations reflect back into the wasm-side u8)
    // needs the #983-style shared bridge and .buffer exposure on the host
    // mirror — deferred to the encoding-matrix follow-up (see issue file).
    const exports = await compileAndRun(`
      export function test(): string {
        const u = new Uint8Array(2);
        u[0] = 104; u[1] = 105;
        return Buffer.from(u).toString("utf-8");
      }
    `);
    expect(exports.test!()).toBe("hi");
  });
});
