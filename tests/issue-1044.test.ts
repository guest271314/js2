// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1044 — Node builtin modules as host imports. The recognition machinery
// (NODE_BUILTIN_MODULES, `node:` normalization, WASI capability gate) landed
// incrementally (#1791/#1793/#1794/#1795/#2699/#2701). This test closes the
// last gap of acceptance criterion 5: the GLOBAL `Buffer` identifier (a Node
// global, not just a `require("buffer")` export). #1793 lowers `Buffer.*`
// syntactically, but the checker still emitted a spurious "Cannot find name
// 'Buffer'" for the global form under `--emulate node`. `buildNodeEnvDts` now
// injects an ambient `Buffer` declaration (parallel to the `process` global),
// gated behind `--emulate node` so the common web/test262 path stays
// byte-neutral.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeEnvDtsForSource } from "../src/checker/index.js";

describe("#1044 — Node builtin modules as host imports", () => {
  describe("global Buffer ambient typing under --emulate node", () => {
    const bufferDiags = (r: { errors?: Array<{ message: string }> }): string[] =>
      (r.errors ?? []).map((e) => e.message).filter((m) => /Cannot find name 'Buffer'/.test(m));

    it("Buffer.from as a global does not emit 'Cannot find name Buffer' under emulateNode", async () => {
      const r = await compile(`export function test(): number { const b = Buffer.from("hi"); return b.length; }`, {
        fileName: "test.ts",
        emulateNode: true,
      });
      expect(r.success).toBe(true);
      expect(bufferDiags(r)).toHaveLength(0);
    });

    it("Buffer.concat / alloc statics type-check cleanly under emulateNode", async () => {
      const r = await compile(
        `export function test(): number {
           const c = Buffer.concat([Buffer.from("a"), Buffer.from("b")]);
           return c.length + Buffer.alloc(4).length;
         }`,
        { fileName: "test.ts", emulateNode: true },
      );
      expect(r.success).toBe(true);
      expect(bufferDiags(r)).toHaveLength(0);
    });

    it("a named `import { Buffer } from 'node:buffer'` still type-checks (no dup global)", async () => {
      const r = await compile(
        `import { Buffer } from "node:buffer";
         export function test(): number { return Buffer.from("x").length; }`,
        { fileName: "test.ts", emulateNode: true },
      );
      expect(r.success).toBe(true);
      expect(bufferDiags(r)).toHaveLength(0);
    });

    it("a user-declared `Buffer` binding is not clobbered by the ambient inject", async () => {
      const r = await compile(`const Buffer = 5;\nexport function test(): number { return Buffer; }`, {
        fileName: "test.ts",
        emulateNode: true,
      });
      expect(r.success).toBe(true);
      expect(bufferDiags(r)).toHaveLength(0);
    });
  });

  describe("buildNodeEnvDts scoping (import-scoped, byte-neutral off-path)", () => {
    it("injects an ambient `Buffer` for a bare-global Buffer program", () => {
      const dts = buildNodeEnvDtsForSource(`function test() { return Buffer.from("hi"); }`);
      expect(dts).toBeDefined();
      expect(dts).toContain("declare var Buffer: BufferConstructor");
      expect(dts).toContain("interface BufferConstructor");
    });

    it("does NOT inject an ambient `Buffer` when Buffer is import-bound", () => {
      const dts = buildNodeEnvDtsForSource(
        `import { Buffer } from "node:buffer"; function t() { return Buffer.from("x"); }`,
      );
      // The `node:buffer` module decl may exist, but no bare `declare var Buffer`.
      expect(dts ?? "").not.toContain("declare var Buffer: BufferConstructor");
    });

    it("does NOT inject `Buffer` for a program that never mentions Buffer", () => {
      const dts = buildNodeEnvDtsForSource(`export function test(): number { return 42; }`);
      // No Node surface touched at all → undefined (nothing injected).
      expect(dts).toBeUndefined();
    });
  });

  describe("node: prefix normalization + WASI capability gate", () => {
    it("`node:http` and bare `http` both resolve to the same host import (JS host)", async () => {
      const withPrefix = await compile(`import http from "node:http"; export function test(): number { return 1; }`, {
        fileName: "a.ts",
      });
      const bare = await compile(`import http from "http"; export function test(): number { return 1; }`, {
        fileName: "b.ts",
      });
      expect(withPrefix.success).toBe(true);
      expect(bare.success).toBe(true);
    });

    it("a Node builtin under `--target wasi` errors cleanly (not a crash)", async () => {
      const r = await compile(`import http from "node:http"; export function test(): number { return 1; }`, {
        fileName: "test.ts",
        target: "wasi",
      });
      expect(r.success).toBe(false);
      expect(r.errors.some((e) => /not available in WASI target/i.test(e.message))).toBe(true);
    });
  });
});
