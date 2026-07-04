// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 family B1 — boxed `new String(...)` receiver / argument in a standalone
 * RegExp / String-method context.
 *
 * `new String(x)` builds a `$Object` wrapper (`__new_String`) carrying its
 * [[StringData]] under the reserved FLAG_INTERNAL WRAPPER_PRIMITIVE_KEY slot.
 * When such a wrapper flowed into an externref → native-`$AnyString` coercion
 * — the receiver-as-subject of `String.prototype.split/search/match/replace/
 * matchAll`, or the string argument of `RegExp.prototype.exec/test` — the
 * generic `ref.test $AnyString` missed it (a wrapper is an object, not a string)
 * and the value was dropped to null → downstream `__str_flatten` trapped
 * ("dereferencing a null pointer"). This is the `__str_flatten` deref family the
 * #2161 fresh harvest banked as B1 (~40 rows: every `instance-is-string-hello`
 * split/search/match/replace test plus `re.exec(new String(...))`).
 *
 * The fix teaches that coercion's else-arm to recover the wrapper's primitive
 * string via `__wrapper_string_value` — the same internal-slot read
 * `__to_primitive` performs inline (§7.1.1.1), WITHOUT the OrdinaryToPrimitive
 * valueOf/toString method dispatch (a pure, side-effect-free slot probe). The
 * helper is registered lazily and only when a qualifying coercion needs it, so
 * modules that never box a String stay byte-identical.
 *
 * All standalone with an EMPTY importObject — a boxed-String recovery that
 * leaked a host import (`env::__str_*` / `env::__extern_*`) would fail to
 * instantiate. `skipSemanticDiagnostics` mirrors the test262 runner: sputnik
 * sources are JS, so a `String`-wrapper receiver/argument flows into the native
 * string-method paths exactly as it does under test262 (strict TS would reject
 * `String` where `string` is wanted before codegen ever runs).
 */
async function runStandalone(src: string): Promise<{ leaks: string[]; main: () => unknown }> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => !l.startsWith("wasm:js-string::"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { leaks, main: instance.exports.main as () => unknown };
}

describe("#2161 B1 — boxed new String receiver (standalone, host-free)", () => {
  it("split(/re/) on a boxed String matches the real test262 instance-is-string-hello shape", async () => {
    // mirrors built-ins/String/prototype/split/argument-is-regexp-l-and-instance-is-string-hello.js
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var __string = new String("hello");
        var __split = __string.split(/l/);
        var ok = 1;
        if (__split.length !== 3) ok = 0;
        if (__split[0] !== "he") ok = 0;
        if (__split[1] !== "") ok = 0;
        if (__split[2] !== "o") ok = 0;
        return ok;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("split(string) on a boxed String receiver does not trap", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = new String("a-b-c");
        return s.split("-").length;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(3);
  });

  it("search(/re/) on a boxed String receiver returns the match index", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = new String("hello world");
        return s.search(/wor/);
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(6);
  });

  it("match(/re/g) on a boxed String receiver returns all matches", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = new String("aXbXc");
        var m = s.match(/X/g);
        return m ? m.length : -1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("match(/re/) on a boxed String exposes numbered capture groups", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = new String("2026-07");
        var m = s.match(/(\\d+)-(\\d+)/);
        return m ? Number(m[1]) + Number(m[2]) : -1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2033);
  });

  it("replace(/re/g, str) on a boxed String receiver yields the right string", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = new String("aXbXc");
        var r = s.replace(/X/g, "-");
        // "a-b-c": length 5, char at index 1 is '-'
        return r.length === 5 && r.charCodeAt(1) === 45 ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("matchAll(/re/g) on a boxed String receiver iterates captures", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = new String("a1b2");
        var sum = 0;
        for (const m of s.matchAll(/(\\d)/g)) sum += Number(m[1]);
        return sum;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(3);
  });
});

describe("#2161 B1 — boxed new String argument (standalone, host-free)", () => {
  it("re.exec(new String(...)) recovers the boxed subject", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var m = /b/.exec(new String("abc"));
        return m ? m.index : -99;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("re.test(new String(...)) recovers the boxed subject", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        return /i/.test(new String("hi")) ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });
});

describe("#2161 B1 — no-regression controls (standalone)", () => {
  it("a plain string receiver still works (no wrapper involved)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var s = "aXbXc";
        var m = s.match(/X/g);
        return m ? m.length : -1;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("a plain (non-wrapper) object argument does not spuriously become a string", async () => {
    // A plain object is NOT a boxed-String wrapper: the helper returns null for
    // it, so the prior null fallthrough is preserved — `.test` sees no match.
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var o: any = { toString: 0 };
        return /i/.test(o) ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(0);
  });
});
