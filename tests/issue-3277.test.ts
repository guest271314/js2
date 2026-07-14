// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3277 — smoke test for the ensureNativeStringHelpers slice-2 decomposition.
 *
 * The head/middle core builders (rope flatten / UTF-8 conversion / concat /
 * compare / slice / char access) were lifted verbatim out of the god-function
 * into `native-strings-core.ts` + `native-strings-basics.ts`. Byte-identity
 * across the playground corpus is proved by `prove-emit-identity`; this is the
 * required #2093 runtime gate — it compiles each core family under `--target
 * standalone` (pure Wasm, NO JS host) and checks the emitted helpers execute
 * correctly. Cases build ConsStrings (via `a + b`) to exercise the flatten /
 * copy_tree rope path, then read them back.
 */
async function instantiate(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envLeaks = r.imports.filter((i) => i.module === "env" || i.module.startsWith("wasm:js-string"));
  expect(
    envLeaks.map((i) => `${i.module}::${i.name}`),
    "JS-host imports leaked",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...args: number[]) => number>;
}

describe("#3277 native-strings-core (flatten / concat) — standalone", () => {
  it("concat + index over string literals, and a deep rope that must flatten", async () => {
    const ex = await instantiate(`
      export function len(): number { return ("foo" + "bar").length; }
      export function mid(): number { return ("foo" + "bar").charCodeAt(3); } // 'b'
      export function deepLen(): number {
        let s = "";
        for (let i = 0; i < 50; i++) s = s + "ab";
        return s.length;
      }
      export function deepLast(): number {
        let s = "";
        for (let i = 0; i < 50; i++) s = s + "ab";
        return s.charCodeAt(99);
      }
    `);
    expect(ex.len!()).toBe(6);
    expect(ex.mid!()).toBe(98); // 'b'
    expect(ex.deepLen!()).toBe(100);
    expect(ex.deepLast!()).toBe(98); // 'b'
  });
});

describe("#3277 native-strings-basics (compare / slice / char) — standalone", () => {
  it("equality and ordering", async () => {
    const ex = await instantiate(`
      export function eq(): number { return ("ab" + "c") === "abc" ? 1 : 0; }
      export function neq(): number { return "abc" === "abd" ? 1 : 0; }
      export function lt(): number { return "abc" < "abd" ? 1 : 0; }
      export function gt(): number { return "b" > "a" ? 1 : 0; }
    `);
    expect(ex.eq!()).toBe(1);
    expect(ex.neq!()).toBe(0);
    expect(ex.lt!()).toBe(1);
    expect(ex.gt!()).toBe(1);
  });

  it("substring / slice / substr / charAt / charCodeAt", async () => {
    const ex = await instantiate(`
      export function sub(): number { return "hello".substring(1, 3).length; } // "el"
      export function subChar(): number { return "hello".substring(1, 3).charCodeAt(0); } // 'e'
      export function sliceNeg(): number { return "hello".slice(-2).charCodeAt(0); } // 'l'
      export function substr(): number { return "hello".substr(1, 2).charCodeAt(1); } // 'l'
      export function at(): number { return "hello".charAt(4).charCodeAt(0); } // 'o'
      export function code(): number { return "hello".charCodeAt(0); } // 'h'
    `);
    expect(ex.sub!()).toBe(2);
    expect(ex.subChar!()).toBe(101); // 'e'
    expect(ex.sliceNeg!()).toBe(108); // 'l'
    expect(ex.substr!()).toBe(108); // 'l'
    expect(ex.at!()).toBe(111); // 'o'
    expect(ex.code!()).toBe(104); // 'h'
  });
});
