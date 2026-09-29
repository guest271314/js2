// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6735 — `import()` inside an async function under --target standalone. #3494
// made every import() compile to a native Promise (resolved with an in-graph
// namespace, else REJECTED with a TypeError). The async bodies the frame engine
// does not claim — arrows, function expressions, methods — run the synchronous
// pass-through, whose `await` read the promise's `value` field whatever its
// state: `await import("ts-node")` continued with `undefined` and the async
// function FULFILLED. An awaited already-rejected promise now throws its
// reason, so `catch` runs and an uncaught one rejects the returned promise.
// A throwing ToString(specifier) rejects with the thrown value (§13.3.10.1).
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function run(main: string): Promise<number> {
  const result = await compileMulti({ "./main.js": main }, "./main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `${error.line} ${error.message}`).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  exports.__drain_microtasks?.();
  return exports.result!();
}

// 1 = fulfilled, 3 = rejected with a TypeError, 4 = rejected with anything else,
// -1 = the call threw synchronously instead of returning a promise.
const OBSERVE = `let out = 0;
  export function result() { return out; }
  try { call().then(() => { out = 1; }, (e) => { out = e instanceof TypeError ? 3 : 4; }); } catch (e) { out = -1; }`;

describe("#6735 standalone import() inside async functions", () => {
  it.each([
    [
      "an async arrow, literal outside the graph",
      `const f = async () => { await import("ts-node"); return 5; }; const call = () => f();`,
    ],
    [
      "an async arrow, non-literal specifier",
      `const f = async (u) => { await import(u); return 5; }; const call = () => f("a" + "b");`,
    ],
    [
      "an async function expression",
      `const f = async function (u) { return (await import(u)).x; }; const call = () => f(String(1));`,
    ],
    [
      "an async class method",
      `class C { async m() { return await import("esbuild-register/dist/node"); } } const call = () => new C().m();`,
    ],
    [
      "an async object method",
      `const o = { async m() { const ns = await import("ts-node"); return ns; } }; const call = () => o.m();`,
    ],
    [
      "an async function declaration",
      `async function f() { await import("ts-node"); return 5; } const call = () => f();`,
    ],
  ])("rejects with a TypeError from %s", async (_name, body) => {
    expect(await run(`${body}\n${OBSERVE}`)).toBe(3);
  });

  it.each([
    [
      "an async arrow",
      `const f = async (u) => { try { await import(u); return 5; } catch (e) { return e instanceof TypeError ? 6 : 7; } };`,
    ],
    [
      "an async method",
      `class C { async m(u) { try { await import(u); return 5; } catch (e) { return e instanceof TypeError ? 6 : 7; } } } const f = (u) => new C().m(u);`,
    ],
    [
      "an async function declaration",
      `async function f(u) { try { await import(u); return 5; } catch (e) { return e instanceof TypeError ? 6 : 7; } }`,
    ],
  ])("delivers the rejection to a catch in %s (jest-util importModule shape)", async (_name, body) => {
    expect(
      await run(`${body}
        let out = 0;
        export function result() { return out; }
        f("x" + "y").then((v) => { out = v; }, () => { out = 9; });`),
    ).toBe(6);
  });

  it("rejects an async arrow that awaits any already-rejected promise", async () => {
    expect(
      await run(
        `const f = async () => { await Promise.reject(new TypeError("r")); return 5; }; const call = () => f();\n${OBSERVE}`,
      ),
    ).toBe(3);
  });

  it("still fulfills an async arrow awaiting a fulfilled promise with its value", async () => {
    expect(
      await run(`const f = async () => (await Promise.resolve(40)) + 2;
        let out = 0;
        export function result() { return out; }
        f().then((v) => { out = v; }, () => { out = -9; });`),
    ).toBe(42);
  });

  // §13.3.10.1: GetValue(specifier) is `?` (a synchronous throw), ToString is
  // IfAbruptRejectPromise (a rejection carrying the thrown value itself).
  it.each([
    ["an async arrow", `const call = async () => { await import(obj); };`],
    ["a plain call", `const call = () => import(obj);`],
  ])("rejects with the ToString abrupt completion of the specifier in %s", async (_name, body) => {
    expect(
      await run(`const obj = { toString() { throw "custom error"; } };
        ${body}
        let out = 0;
        export function result() { return out; }
        try { call().then(() => { out = 1; }, (e) => { out = e === "custom error" ? 3 : 4; }); } catch (e) { out = -1; }`),
    ).toBe(3);
  });

  it("still throws a specifier evaluation error synchronously", async () => {
    expect(
      await run(`function thrower() { throw new RangeError("x"); }
        let out = 0;
        export function result() { return out; }
        try { import(thrower()).then(() => { out = 1; }, () => { out = 2; }); } catch (e) { out = e instanceof RangeError ? 3 : 4; }`),
    ).toBe(3);
  });
});
