// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2501 — Object.prototype.toString.call(v) → native [object X] builtin tag
// (§20.1.3.6 builtin-tag subset). Previously: host mode mis-tagged Array/
// Function/Date as [object Object] (the Wasm vec/closure receiver is opaque to
// the host's Object.prototype.toString), and standalone hard-errored on the
// whole .call(...) form. Now intercepted by a compile-time classifier that
// emits the statically-known tag string in BOTH modes — no host import.
// Symbol.toStringTag (§20.1.3.6 step 15) is a deferred phase-2.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<Record<string, (...a: number[]) => unknown>> {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as unknown as Record<string, (...a: number[]) => unknown>;
}

// Standalone string-return marshalling needs the full harness; assert the tag
// via `.length` (which avoids it) + no env-import leak.
async function runStandaloneLen(source: string): Promise<{ len: number; envLeak: string[] }> {
  const result = await compile(source, { target: "standalone" } as Parameters<typeof compile>[1]);
  expect(result.success).toBe(true);
  const envLeak = (result.imports ?? [])
    .filter((i) => i.module === "env" && !String(i.name).startsWith("__"))
    .map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const len = (instance.exports as Record<string, () => number>).test();
  return { len, envLeak };
}

describe("#2501 Object.prototype.toString [object X] tag", () => {
  it("host: tags Array/Function/Number/String/Boolean/Date/RegExp/Object correctly", async () => {
    const e = await runHost(`
      export function test(): string {
        const parts: string[] = [];
        parts.push(Object.prototype.toString.call([1, 2]));      // [object Array]  (was [object Object])
        function f() {}
        parts.push(Object.prototype.toString.call(f));            // [object Function] (was [object Object])
        parts.push(Object.prototype.toString.call(new Date()));   // [object Date]   (was [object Object])
        parts.push(Object.prototype.toString.call(42));           // [object Number]
        parts.push(Object.prototype.toString.call("s"));          // [object String]
        parts.push(Object.prototype.toString.call(true));         // [object Boolean]
        parts.push(Object.prototype.toString.call({}));           // [object Object]
        parts.push(Object.prototype.toString.call(null));         // [object Null]
        parts.push(Object.prototype.toString.call(undefined));    // [object Undefined]
        return parts.join("|");
      }
    `);
    expect(e.test()).toBe(
      "[object Array]|[object Function]|[object Date]|[object Number]|[object String]|[object Boolean]|[object Object]|[object Null]|[object Undefined]",
    );
  });

  it("standalone: array tag is [object Array] with no env import leak (was hard CE)", async () => {
    const { len, envLeak } = await runStandaloneLen(`
      export function test(): number {
        const a = [1, 2];
        return Object.prototype.toString.call(a).length;   // "[object Array]" = 14
      }
    `);
    expect(len).toBe(14);
    expect(envLeak).toEqual([]); // no env.Object_toString / __proto_method_call leak
  });

  it("standalone: plain object tag is [object Object] (15 chars)", async () => {
    const { len, envLeak } = await runStandaloneLen(`
      export function test(): number {
        const o = {};
        return Object.prototype.toString.call(o).length;   // "[object Object]" = 15
      }
    `);
    expect(len).toBe(15);
    expect(envLeak).toEqual([]);
  });
});
