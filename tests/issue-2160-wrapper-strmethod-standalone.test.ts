// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2160 (wrapper-strmethod slice) — String.prototype METHOD dispatch on a
 * `new String(x)` WRAPPER receiver, standalone.
 *
 * A String wrapper (`new String("abc")`) reaches the native-string method
 * dispatch in `compileMethodCall` because `isStringType` deliberately also
 * matches the wrapper Object type (so primitive-string methods can dispatch).
 * But the wrapper lowers to a `$Object` externref, NOT a native string ref, so
 * the receiver emitter's `__str_flatten` `ref.cast $NativeString` TRAPPED at
 * runtime ("illegal cast" / "null pointer dereference") for EVERY
 * String.prototype method (`charAt`, `slice`, `indexOf`, `toUpperCase`, …) —
 * making the entire wrapper-method surface unusable standalone. The cs-2160
 * slice fixed `.length`/`[i]`/`.valueOf()`/`.toString()` on a wrapper but
 * explicitly left "full String-method dispatch on a wrapper receiver" open.
 *
 * Fix (no new coercion site): route the native string method's RECEIVER through
 * the existing `__to_primitive` engine helper (§7.1.1.1, reads the wrapper's
 * FLAG_INTERNAL `[[PrimitiveValue]]` slot first), recovering the wrapped native
 * string ref, then dispatch the method against it. Implemented via
 * `compileNativeStringMethodCall`'s `receiverOverride` callback; the two-string-
 * arg arms (indexOf/lastIndexOf/includes/startsWith/endsWith) also route their
 * receiver through the override (they previously bypassed it). Gated on
 * `ctx.standalone` — WASI / gc keep their existing object paths.
 *
 * Each case returns 1 on the spec-correct result and the standalone module is
 * instantiated with an EMPTY import object, so any host-import leak (or the old
 * trap) fails the test.
 */

// Each body returns 1 iff the wrapper method produced the spec-correct value.
const CASES: ReadonlyArray<[string, string]> = [
  ["charAt", `return new String("abc").charAt(1) === "b" ? 1 : 0;`],
  ["charCodeAt", `return new String("A").charCodeAt(0) === 65 ? 1 : 0;`],
  ["at negative", `return new String("abc").at(-1) === "c" ? 1 : 0;`],
  ["toUpperCase", `return new String("ab").toUpperCase() === "AB" ? 1 : 0;`],
  ["toLowerCase", `return new String("AB").toLowerCase() === "ab" ? 1 : 0;`],
  ["slice", `return new String("abcd").slice(1, 3) === "bc" ? 1 : 0;`],
  ["substring", `return new String("abcd").substring(1, 3) === "bc" ? 1 : 0;`],
  ["indexOf hit", `return new String("abcabc").indexOf("b") === 1 ? 1 : 0;`],
  ["indexOf miss", `return new String("abc").indexOf("z") === -1 ? 1 : 0;`],
  ["lastIndexOf", `return new String("abcabc").lastIndexOf("b") === 4 ? 1 : 0;`],
  ["includes true", `return new String("abc").includes("b") ? 1 : 0;`],
  ["includes false", `return new String("abc").includes("z") ? 0 : 1;`],
  ["startsWith", `return new String("hello").startsWith("he") ? 1 : 0;`],
  ["endsWith", `return new String("hello").endsWith("lo") ? 1 : 0;`],
  ["repeat", `return new String("ab").repeat(2) === "abab" ? 1 : 0;`],
  ["padStart", `return new String("5").padStart(3, "0") === "005" ? 1 : 0;`],
  ["trim", `return new String("  x  ").trim() === "x" ? 1 : 0;`],
  ["concat", `return new String("a").concat("b") === "ab" ? 1 : 0;`],
  ["split length", `return new String("a,b,c").split(",").length === 3 ? 1 : 0;`],
  ["chained", `return new String("Hello World").toUpperCase().slice(0, 5) === "HELLO" ? 1 : 0;`],
  // via a wrapper local (not only inline) — exercises the bound-local path too.
  ["local charAt", `const s = new String("xyz"); return s.charAt(2) === "z" ? 1 : 0;`],
  ["local indexOf", `const s = new String("hello"); return s.indexOf("l") === 2 ? 1 : 0;`],
];

const fn = (i: number) => `t${i}`;
const MODULE = CASES.map(([, body], i) => `export function ${fn(i)}(): number { ${body} }`).join("\n");

describe("#2160 String.prototype method dispatch on a wrapper receiver — standalone", () => {
  it("every String method works on a new String() wrapper (no host-import leak)", async () => {
    const r = await compile(MODULE, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No leaked host import for the wrapper method-dispatch path.
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    for (const re of [/^env::__unbox_string$/, /^env::__new_String$/, /^env::__extern_/, /^wasm:js-string::/]) {
      expect(
        labels.filter((l) => re.test(l)),
        `leaked ${re.source}`,
      ).toEqual([]);
    }
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    CASES.forEach(([name], i) => {
      expect(ex[fn(i)]!(), `standalone wrapper ${name}`).toBe(1);
    });
  });

  // gc / JS-host mode is untouched (the fix is `ctx.standalone`-gated). This
  // guard proves the default backend still compiles + runs wrapper methods.
  it("default (gc / JS-host) mode still compiles wrapper string methods", async () => {
    const r = await compile(MODULE, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    const ex = instance.exports as Record<string, () => number>;
    CASES.forEach(([name], i) => {
      expect(ex[fn(i)]!(), `gc wrapper ${name}`).toBe(1);
    });
  });
});
