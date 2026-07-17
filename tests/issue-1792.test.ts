// #1792 — node:url: URL / URLSearchParams as host constructors.
//
// `new URL(...)` / `new URLSearchParams(...)` (and the `node:url` named-import
// form) previously did not lower to the host WHATWG constructors — the opaque
// `__node_url` externref path only reached the `require("url").fn(...)` method
// forms, so `new URL(...)` produced an empty/null object (`.pathname`
// undefined; `new URLSearchParams(...)` returned null).
//
// Fix wires both as extern-class host constructors (registerBuiltinExternClasses
// + builtinCtors for the global form; NODE_BUILTIN_CLASS_TYPED_STUBS for the
// `node:url` named-import form). Property/method reads flow through the generic
// __extern_get / __extern_method_call host imports in JS-host mode.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", skipSemanticDiagnostics: true });
  expect(r.success, `Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports.test as () => unknown)();
}

describe("#1792 — node:url URL / URLSearchParams host constructors", () => {
  it("new URL(relative, base).pathname resolves against the base", async () => {
    // Node: new URL("./b", "file:///a/").pathname === "/a/b"
    expect(await run(`export function test(): string { return new URL("./b", "file:///a/").pathname; }`)).toBe("/a/b");
  });

  it("URL.searchParams.get reads a query param", async () => {
    expect(
      await run(
        `export function test(): string { return new URL("https://x.com/p?q=1").searchParams.get("q") as string; }`,
      ),
    ).toBe("1");
  });

  it("URL string getters (href / hostname / search)", async () => {
    expect(await run(`export function test(): string { return new URL("https://x.com/p?q=1").href; }`)).toBe(
      "https://x.com/p?q=1",
    );
    expect(await run(`export function test(): string { return new URL("https://x.com/p").hostname; }`)).toBe("x.com");
    expect(await run(`export function test(): string { return new URL("https://x.com/p?q=1&r=2").search; }`)).toBe(
      "?q=1&r=2",
    );
  });

  it("new URLSearchParams(str).getAll returns repeated values", async () => {
    expect(
      await run(`export function test(): string { return new URLSearchParams("a=1&a=2").getAll("a").join(","); }`),
    ).toBe("1,2");
  });

  it("URLSearchParams append + toString + has", async () => {
    expect(
      await run(
        `export function test(): string { const p = new URLSearchParams(); p.append("a","1"); p.append("b","2"); return p.toString(); }`,
      ),
    ).toBe("a=1&b=2");
    expect(
      await run(`export function test(): string { return new URLSearchParams("a=1").has("a") ? "yes" : "no"; }`),
    ).toBe("yes");
  });

  it("the node:url import form resolves to the same host constructor (AC6)", async () => {
    expect(
      await run(
        `import { URL } from "node:url";\nexport function test(): string { return new URL("https://i.com/").hostname; }`,
      ),
    ).toBe("i.com");
    expect(
      await run(
        `import { URLSearchParams } from "node:url";\nexport function test(): string { return new URLSearchParams("k=v").get("k") as string; }`,
      ),
    ).toBe("v");
  });

  it("node:url fileURLToPath named-function import still works (AC4)", async () => {
    expect(
      await run(
        `import { fileURLToPath } from "node:url";\nexport function test(): string { return fileURLToPath("file:///a/b.js"); }`,
      ),
    ).toBe("/a/b.js");
  });
});
