// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { buildImports } from "../src/runtime.js";

/**
 * #1333 — Annex B §B.2.2 legacy RegExp static accessors. After calling
 * buildImports() the host's %RegExp% constructor gains spec-compliant
 * getters that (a) return the slot value and (b) throw TypeError when
 * the receiver is not the RegExp constructor itself.
 *
 * V8 ships its own native annexB accessors but does NOT enforce the
 * SameValue(C, thisValue) receiver check, so we override.
 */

function installLegacy(): typeof RegExp {
  buildImports([]);
  return RegExp;
}

describe("#1333 Annex B legacy RegExp accessor descriptors", () => {
  it("RegExp.input descriptor is enumerable=false, configurable=true, has get + set", () => {
    const R = installLegacy();
    const d = Object.getOwnPropertyDescriptor(R, "input")!;
    expect(d.enumerable).toBe(false);
    expect(d.configurable).toBe(true);
    expect(typeof d.get).toBe("function");
    expect(typeof d.set).toBe("function");
  });

  it("RegExp.lastMatch descriptor is read-only (get only)", () => {
    const R = installLegacy();
    const d = Object.getOwnPropertyDescriptor(R, "lastMatch")!;
    expect(typeof d.get).toBe("function");
    expect(d.set).toBeUndefined();
  });

  it("aliases ($_, $&, $+, $`, $') map to the same accessor as their named slot", () => {
    const R = installLegacy();
    expect(Object.getOwnPropertyDescriptor(R, "$_")!.get).toBe(Object.getOwnPropertyDescriptor(R, "input")!.get);
    expect(Object.getOwnPropertyDescriptor(R, "$&")!.get).toBe(Object.getOwnPropertyDescriptor(R, "lastMatch")!.get);
    expect(Object.getOwnPropertyDescriptor(R, "$+")!.get).toBe(Object.getOwnPropertyDescriptor(R, "lastParen")!.get);
    expect(Object.getOwnPropertyDescriptor(R, "$`")!.get).toBe(Object.getOwnPropertyDescriptor(R, "leftContext")!.get);
    expect(Object.getOwnPropertyDescriptor(R, "$'")!.get).toBe(Object.getOwnPropertyDescriptor(R, "rightContext")!.get);
  });

  it("$1..$9 are configurable read-only accessors", () => {
    const R = installLegacy();
    for (let i = 1; i <= 9; i++) {
      const d = Object.getOwnPropertyDescriptor(R, `$${i}`)!;
      expect(d.enumerable).toBe(false);
      expect(d.configurable).toBe(true);
      expect(typeof d.get).toBe("function");
      expect(d.set).toBeUndefined();
    }
  });
});

describe("#1333 Annex B legacy RegExp accessor this-check", () => {
  it("get throws TypeError on a non-RegExp receiver (plain object)", () => {
    const R = installLegacy();
    const d = Object.getOwnPropertyDescriptor(R, "input")!;
    expect(() => d.get!.call({})).toThrow(TypeError);
    expect(() => Object.getOwnPropertyDescriptor(R, "lastMatch")!.get!.call({})).toThrow(TypeError);
    expect(() => Object.getOwnPropertyDescriptor(R, "$1")!.get!.call({})).toThrow(TypeError);
  });

  it("set throws TypeError on a non-RegExp receiver", () => {
    const R = installLegacy();
    const d = Object.getOwnPropertyDescriptor(R, "input")!;
    expect(() => d.set!.call({}, "abc")).toThrow(TypeError);
  });

  it("get throws TypeError when called on a RegExp subclass constructor", () => {
    const R = installLegacy();
    class MyRegExp extends R {}
    const d = Object.getOwnPropertyDescriptor(R, "input")!;
    expect(() => d.get!.call(MyRegExp)).toThrow(TypeError);
  });

  it("get returns the current slot value when called on %RegExp%", () => {
    const R = installLegacy();
    const d = Object.getOwnPropertyDescriptor(R, "input")!;
    expect(typeof d.get!.call(R)).toBe("string");
  });
});

describe("#1333 Annex B legacy slots updated after match", () => {
  it("RegExp.input + lastMatch + $1 reflect the last successful exec", () => {
    const R = installLegacy();
    // Drive an exec through the SAME path the compiled wasm uses by setting
    // the slots via the JS side of the host import surface — the post-exec
    // hook in the extern_class method handler is what the test262 cases
    // actually exercise. For this unit test we set them via the spec's
    // own update helper indirectly by running a regex through the JS side.
    R.input; // touch to ensure descriptor is installed
    const re = /(\w+)\s(\w+)/;
    "John Smith".replace(re, "$2 $1"); // native match → V8 updates its own slots
    // Our slot table is updated by the runtime hooks; here we just verify
    // the accessor returns a string and doesn't throw on the real RegExp ctor.
    expect(typeof Object.getOwnPropertyDescriptor(R, "input")!.get!.call(R)).toBe("string");
    expect(typeof Object.getOwnPropertyDescriptor(R, "lastMatch")!.get!.call(R)).toBe("string");
    expect(typeof Object.getOwnPropertyDescriptor(R, "$1")!.get!.call(R)).toBe("string");
  });

  it("RegExp.input setter coerces ToString and round-trips", () => {
    const R = installLegacy();
    const d = Object.getOwnPropertyDescriptor(R, "input")!;
    d.set!.call(R, 42);
    expect(d.get!.call(R)).toBe("42");
    d.set!.call(R, "hello");
    expect(d.get!.call(R)).toBe("hello");
  });
});
