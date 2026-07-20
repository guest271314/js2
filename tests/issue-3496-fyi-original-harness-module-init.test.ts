// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { compileMulti } from "../src/index.js";

const PENDING_CYCLE_PATH = "language/module-code/top-level-await/pending-async-dep-from-cycle.js";

const fixtures = {
  "./setup.js": `globalThis.logs = [];`,
  "./cycle-leaf.js": `
    import "./cycle-root.js";
    globalThis.logs.push("cycle leaf start");
    await 1;
    globalThis.logs.push("cycle leaf end");
  `,
  "./cycle-root.js": `
    import "./cycle-leaf.js";
    globalThis.logs.push("cycle root start");
    await 1;
    globalThis.logs.push("cycle root end");
  `,
  "./import-cycle-leaf.js": `
    import "./cycle-leaf.js";
    globalThis.logs.push("importer of cycle leaf");
  `,
};

async function instantiateWithPrelude(prelude: string) {
  const result = await compileMulti(
    {
      ...fixtures,
      "./entry.js": `
        ${prelude}
        import "./setup.js";
        import "./cycle-root.js";
        import "./import-cycle-leaf.js";
        export function score() { return globalThis.logs.length; }
      `,
    },
    "./entry.js",
    { allowJs: true, skipSemanticDiagnostics: true, target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.score as () => number)();
}

async function instantiateSimple(prelude: string, writer: string) {
  const result = await compileMulti(
    {
      "./setup.js": `globalThis.logs = [];`,
      "./writer.js": `import "./setup.js"; ${writer}`,
      "./entry.js": `
        ${prelude}
        import "./writer.js";
        export function score() { return globalThis.logs.length; }
      `,
    },
    "./entry.js",
    { allowJs: true, skipSemanticDiagnostics: true, target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.score as () => number)();
}

describe("#3496 — FYI harness initialization with module fixtures", () => {
  it.each([
    ["setup only", "", 0],
    ["one push", `globalThis.logs.push("value");`, 1],
  ])("keeps a captured global through %s", async (_name, writer, length) => {
    await expect(instantiateSimple(`var $262 = { global: globalThis };`, writer)).resolves.toBe(length);
  });

  it.each([
    ["a local globalThis alias", `var captured = globalThis;`],
    ["an empty object", `var captured = {};`],
    ["an object with a null field", `var captured = { global: null };`],
  ])("keeps the fixture global alive with %s", async (_name, prelude) => {
    await expect(instantiateWithPrelude(prelude)).resolves.toBe(5);
  });

  it("keeps the fixture global alive when the harness captures globalThis", async () => {
    await expect(instantiateWithPrelude(`var $262 = { global: globalThis };`)).resolves.toBe(5);
  });

  it("keeps the fixture global alive with the literal FYI runtime shim", async () => {
    await expect(
      instantiateWithPrelude(`
        var print = function (value) { console.log(value); };
        var $262 = {
          global: globalThis,
          IsHTMLDDA: function () {},
          createRealm: function () { return $262; },
          evalScript: function (sourceText) { return eval(sourceText); },
          gc: function () {},
          detachArrayBuffer: function (buffer) {
            if (typeof structuredClone !== "function") {
              throw new Error("$262.detachArrayBuffer is unsupported by this host");
            }
            structuredClone(buffer, { transfer: [buffer] });
          },
        };
      `),
    ).resolves.toBe(5);
  });

  it("runs the unmodified FYI harness and official fixture graph through $DONE", { timeout: 60_000 }, async () => {
    const [test] = await loadOriginalHarnessTests([PENDING_CYCLE_PATH]);
    expect(test).toBeDefined();
    const result = await compileMulti({ ...test!.fixtureFiles, [test!.entryFile]: test!.contents }, test!.entryFile, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    const prepare = exports.__stdout_prepare as () => number;
    const char = exports.__stdout_char as (index: number) => number;
    const length = prepare();
    let output = "";
    for (let i = 0; i < length; i++) output += String.fromCharCode(char(i));
    expect(output).toContain("Test262:AsyncTestComplete");
  });
});
