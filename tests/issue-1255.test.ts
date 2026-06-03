import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/index.js";

// #1255 — reference platform scenario: a Node-oriented program (node:fs +
// console) compiles to standalone WASI WebAssembly that runs on a WASI host
// with no JS engine. These tests guard that the example keeps compiling to a
// self-contained WASI binary that imports only wasi_snapshot_preview1.

const here = dirname(fileURLToPath(import.meta.url));
const exampleSrc = readFileSync(join(here, "..", "examples", "edge-platform", "generate-artifacts.ts"), "utf-8");

describe("#1255 reference platform scenario (node:fs on WASI)", () => {
  it("the edge-platform example compiles under --target wasi", async () => {
    const result = await compile(exampleSrc, { fileName: "generate-artifacts.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
  });

  it("imports only from wasi_snapshot_preview1 — no JS engine, no env host", async () => {
    const result = await compile(exampleSrc, { fileName: "generate-artifacts.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    const imports = WebAssembly.Module.imports(module);
    for (const imp of imports) {
      expect(imp.module).toBe("wasi_snapshot_preview1");
    }
    const importModules = new Set(imports.map((i) => i.module));
    expect(importModules.has("env")).toBe(false);
    expect(importModules.has("wasm:js-string")).toBe(false);
  });

  it("lowers node:fs writeFileSync to WASI path_open + fd_write", async () => {
    const result = await compile(exampleSrc, { fileName: "generate-artifacts.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const importNames = new Set(
      WebAssembly.Module.imports(await WebAssembly.compile(result.binary)).map((i) => i.name),
    );
    expect(importNames.has("path_open")).toBe(true);
    expect(importNames.has("fd_write")).toBe(true);
  });
});
