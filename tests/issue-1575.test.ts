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

    expect(result.nodeBuiltins).toEqual([
      { localName: "path", moduleName: "path" },
      { localName: "http", moduleName: "http" },
      { localName: "EventEmitter", moduleName: "events", namedBindings: ["EventEmitter"] },
    ]);
    expect(result.source).not.toContain("import path");
    expect(result.source).not.toContain("import * as http");
    expect(result.source).not.toContain("import { EventEmitter }");
  });

  it("routes unsupported default builtin imports through opaque __node_<module> imports", async () => {
    const result = await compile(
      `
        import path from "node:path";
        import http from "node:http";
        import events from "node:events";

        export function touch(): any {
          const h = http;
          const e = events;
          return path.join("a", "b") || h || e;
        }
      `,
      { fileName: "issue-1575-default-builtins.ts" },
    );

    expectSuccessfulCompile(result);

    const moduleImports = result.imports
      .filter((imp) => imp.intent.type === "node_builtin")
      .map((imp) => [imp.name, imp.intent.moduleName]);

    expect(moduleImports).toEqual([
      ["__node_path", "path"],
      ["__node_http", "http"],
      ["__node_events", "events"],
    ]);

    const typedImports = result.imports.filter(
      (imp) => imp.intent.type === "node_builtin_fn" && ["path", "http", "events"].includes(imp.intent.moduleName),
    );
    expect(typedImports).toEqual([]);
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

  it("documents the unsupported named-import gap for common npm builtins", async () => {
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

    expect(result.imports.find((imp) => imp.name === "join")?.intent).toEqual({ type: "builtin", name: "join" });
    expect(result.imports.find((imp) => imp.name === "createHash")?.intent).toEqual({
      type: "builtin",
      name: "createHash",
    });

    expect(result.imports.some((imp) => imp.intent.type === "node_builtin" && imp.intent.moduleName === "path")).toBe(
      false,
    );
    expect(
      result.imports.some(
        (imp) =>
          imp.intent.type === "node_builtin_fn" &&
          ((imp.intent.moduleName === "path" && imp.intent.name === "join") ||
            (imp.intent.moduleName === "crypto" && imp.intent.name === "createHash")),
      ),
    ).toBe(false);
  });
});
