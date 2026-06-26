// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1575 - Node.js builtin module gap survey guard.
//
// These tests do not claim new builtin support. They pin the current import
// routing surface that the survey depends on: recognized builtin specifiers,
// opaque whole-module host imports for default imports, the two typed-function
// exception families, and the sharper gap for unsupported named imports.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { isNodeBuiltin, NODE_BUILTIN_MODULES, preprocessImports } from "../src/import-resolver.js";

const SURVEYED_NODE_BUILTINS = [
  "http",
  "https",
  "http2",
  "url",
  "querystring",
  "stream",
  "stream/web",
  "events",
  "buffer",
  "zlib",
  "util",
  "path",
  "process",
  "net",
  "tls",
  "fs",
  "crypto",
  "os",
  "child_process",
  "assert",
  "dns",
  "dgram",
  "cluster",
  "readline",
  "string_decoder",
  "timers",
  "tty",
  "vm",
  "worker_threads",
  "perf_hooks",
  "async_hooks",
  "diagnostics_channel",
  "console",
] as const;

function expectSuccessfulCompile(result: CompileResult): void {
  expect(
    result.errors.filter((e) => e.severity === "error"),
    result.errors.map((e) => e.message).join("\n"),
  ).toEqual([]);
  expect(result.success).toBe(true);
}

describe("#1575 - Node.js builtin gap survey", () => {
  it("keeps the surveyed builtin matrix aligned with the resolver table", () => {
    expect(new Set(NODE_BUILTIN_MODULES)).toEqual(new Set(SURVEYED_NODE_BUILTINS));
    expect(NODE_BUILTIN_MODULES.size).toBe(33);

    for (const builtin of SURVEYED_NODE_BUILTINS) {
      expect(isNodeBuiltin(builtin), builtin).toBe(true);
      expect(isNodeBuiltin(`node:${builtin}`), `node:${builtin}`).toBe(true);
    }
  });

  it("preprocessImports records default, namespace, and named builtin imports", () => {
    const result = preprocessImports(`
      import path from "node:path";
      import * as http from "http";
      import { EventEmitter } from "node:events";
      export const marker = 1;
    `);

    // #1791 — `node:path` is now bound to the pure-TS posix shim (host +
    // standalone), so it is NOT recorded as an opaque `__node_path` builtin.
    // The remaining opaque builtins (http, events) are still recorded.
    expect(result.nodeBuiltins).toEqual([
      { localName: "http", moduleName: "http" },
      { localName: "EventEmitter", moduleName: "events", namedBindings: ["EventEmitter"] },
    ]);
    expect(result.source).not.toContain("import path");
    expect(result.source).not.toContain("import * as http");
    expect(result.source).not.toContain("import { EventEmitter }");
    // The path shim prelude is injected in place of the opaque import.
    expect(result.source).toContain("__js2wasm_path_");
  });

  it("routes unsupported default builtin imports through opaque __node_<module> imports", async () => {
    const result = await compile(
      `
        import http from "node:http";
        import events from "node:events";

        export function touch(): any {
          const h = http;
          const e = events;
          return h || e;
        }
      `,
      { fileName: "issue-1575-default-builtins.ts" },
    );

    expectSuccessfulCompile(result);

    const moduleImports = result.imports
      .filter((imp) => imp.intent.type === "node_builtin")
      .map((imp) => [imp.name, imp.intent.moduleName]);

    // #1791 — `node:path` is no longer opaque (it has a real shim); http/events
    // remain opaque `__node_<module>` host imports.
    expect(moduleImports).toEqual([
      ["__node_http", "http"],
      ["__node_events", "events"],
    ]);

    const typedImports = result.imports.filter(
      (imp) => imp.intent.type === "node_builtin_fn" && ["path", "http", "events"].includes(imp.intent.moduleName),
    );
    expect(typedImports).toEqual([]);
  });

  it("binds node:path (default import) to the pure-TS posix shim, not an opaque import (#1791)", async () => {
    const result = await compile(
      `
        import path from "node:path";
        export function touch(): string {
          return path.join("a", "b");
        }
      `,
      { fileName: "issue-1575-path-shim.ts" },
    );

    expectSuccessfulCompile(result);

    // No opaque __node_path import, and no node_builtin_fn for path.
    expect(result.imports.some((imp) => imp.intent.type === "node_builtin" && imp.intent.moduleName === "path")).toBe(
      false,
    );
    expect(
      result.imports.some((imp) => imp.intent.type === "node_builtin_fn" && imp.intent.moduleName === "path"),
    ).toBe(false);
  });

  it("keeps node:path on the legacy opaque path when an unsupported member is used (#1791)", async () => {
    // `path.parse` is out of the posix Tier-0 shim surface, so the default
    // import must stay on the legacy `__node_path` host route (no regression).
    const result = await compile(
      `
        import path from "node:path";
        export function touch(): any {
          return path.parse("/a/b.txt");
        }
      `,
      { fileName: "issue-1575-path-unsupported.ts" },
    );

    expectSuccessfulCompile(result);
    expect(result.imports.some((imp) => imp.intent.type === "node_builtin" && imp.intent.moduleName === "path")).toBe(
      true,
    );
  });

  it("keeps the current typed-function exceptions limited to fs and crypto", async () => {
    const cryptoResult = await compile(
      `
        import { randomBytes, randomUUID } from "node:crypto";

        export function main(): number {
          return randomBytes(4).length + randomUUID().length;
        }
      `,
      { fileName: "issue-1575-crypto.ts" },
    );
    expectSuccessfulCompile(cryptoResult);

    expect(
      cryptoResult.imports
        .filter((imp) => imp.intent.type === "node_builtin_fn")
        .map((imp) => [imp.name, imp.intent.moduleName, imp.intent.name]),
    ).toEqual([
      ["__nodefn__crypto__randomBytes", "crypto", "randomBytes"],
      ["__nodefn__crypto__randomUUID", "crypto", "randomUUID"],
    ]);

    const fsResult = await compile(
      `
        import { readFileSync } from "node:fs";

        export function read(path: string): any {
          return readFileSync(path, "utf-8");
        }
      `,
      { allowFs: true, fileName: "issue-1575-fs.ts" },
    );
    expectSuccessfulCompile(fsResult);

    expect(
      fsResult.imports
        .filter((imp) => imp.intent.type === "node_builtin_fn")
        .map((imp) => [imp.name, imp.intent.moduleName, imp.intent.name]),
    ).toEqual([["__node_fs_readFileSync", "fs", "readFileSync"]]);
  });

  it("resolves named node:path imports via the shim; other named builtins remain a gap", async () => {
    const result = await compile(
      `
        import { join } from "node:path";
        import { createHash } from "node:crypto";

        export function touch(): any {
          return join("a", "b") || createHash("sha256");
        }
      `,
      { fileName: "issue-1575-named-gap.ts" },
    );

    expectSuccessfulCompile(result);

    // #1791 — `join` is now a real shim function, so there is NO `join` import
    // at all (neither generic-builtin nor node_builtin_fn).
    expect(result.imports.find((imp) => imp.name === "join")).toBeUndefined();
    expect(
      result.imports.some((imp) => imp.intent.type === "node_builtin_fn" && imp.intent.moduleName === "path"),
    ).toBe(false);
    expect(result.imports.some((imp) => imp.intent.type === "node_builtin" && imp.intent.moduleName === "path")).toBe(
      false,
    );

    // `createHash` is still an unsupported named crypto import → generic stub.
    expect(result.imports.find((imp) => imp.name === "createHash")?.intent).toEqual({
      type: "builtin",
      name: "createHash",
    });
  });
});
