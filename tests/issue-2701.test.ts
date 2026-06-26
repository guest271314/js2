// #2701 — node:fs/promises destructured function imports route through the
// `__nodefn__` host adapter. The `/` in the module name is encoded `/`→`$` in
// the host-import identifier (`__nodefn__fs$promises__readFile`) and decoded
// back to `fs/promises` in the import-manifest classifier so the runtime
// resolves `require("fs/promises")`. Follow-up to #2699.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { compile, buildImports } from "../src/index.js";

const require = createRequire(import.meta.url);
const deps = { "fs/promises": require("node:fs/promises") };

async function run(src: string) {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  // stringPool (3rd arg) is required for string-literal args to marshal at the
  // host boundary (e.g. readFile("/path")).
  const imports = buildImports(result.imports, deps, (result as { stringPool?: unknown }).stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return { result, instance };
}

describe("#2701 — node:fs/promises destructured-import host-glue", () => {
  it("encodes the slash in the host name and decodes the module back to fs/promises", async () => {
    const src = `
      const { readFile, stat } = require("node:fs/promises");
      export function ok(): number {
        return (typeof readFile) === "function" && (typeof stat) === "function" ? 1 : 0;
      }
    `;
    const { result, instance } = await run(src);
    const nodefn = result.imports.filter((i) => i.name.startsWith("__nodefn__"));
    // Host-import identifier carries the `$`-encoded module token.
    expect(nodefn.map((i) => i.name)).toContain("__nodefn__fs$promises__readFile");
    expect(nodefn.map((i) => i.name)).toContain("__nodefn__fs$promises__stat");
    // Classifier decodes `$` → `/` so the runtime resolves require("fs/promises").
    for (const imp of nodefn) {
      const intent = imp.intent as { type: string; moduleName: string };
      expect(intent.type).toBe("node_builtin_fn");
      expect(intent.moduleName).toBe("fs/promises");
    }
    expect((instance.exports.ok as () => number)()).toBe(1);
  });

  it("stat() resolves a real Promise through the host adapter", async () => {
    const src = `
      const { stat } = require("node:fs/promises");
      export async function isf(): Promise<number> {
        const s = await stat("/etc/hostname");
        return s.isFile() ? 1 : 0;
      }
    `;
    const { instance } = await run(src);
    await expect((instance.exports.isf as () => Promise<number>)()).resolves.toBe(1);
  });

  it("readFile() returns a non-empty string via the host adapter", async () => {
    const src = `
      const { readFile } = require("node:fs/promises");
      export async function rd(): Promise<number> {
        const b = await readFile("/etc/hostname", "utf8");
        return (typeof b === "string" && b.length > 0) ? 1 : 0;
      }
    `;
    const { instance } = await run(src);
    await expect((instance.exports.rd as () => Promise<number>)()).resolves.toBe(1);
  });
});
