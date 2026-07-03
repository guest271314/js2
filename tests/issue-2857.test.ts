// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2857 static-method slice — the IR class-member selector (`planIrCompilation`)
// should claim a `static` method even when its class `extends` a parent, as long
// as the method body does not reference `super`. A static method compiles to an
// ordinary function (no `self` injection, no dependency on the parent-prefixed
// instance layout), so it is exactly as IR-claimable as the same static in a
// flat class — cf. the pre-existing claim of a parent-less static.
//
// Scope (drives the `class-method` fallback bucket 6 -> 5 for the
// `website/playground/examples/js/classes.ts` corpus file):
//   - static method in an `extends` class, no `super`  → CLAIMED
//   - static method that references `super`            → NOT claimed (Phase E)
//   - instance method / constructor in an `extends` class → NOT claimed (Phase E)
//
// The selector change is byte-inert: class-member claims are informational
// telemetry (Phase B integration only patches instance methods of flat
// classes; the legacy path still emits every class-member body), so the
// emitted Wasm is unchanged. This test asserts BOTH the selector split and
// runtime parity of the compiled module.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";

function classMembersFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
  return new Set(sel.classMembers ?? []);
}

function fallbackReasons(source: string): Map<string, string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
  const m = new Map<string, string>();
  for (const fb of sel.fallbacks ?? []) m.set(fb.name, fb.reason);
  return m;
}

// A subclass with: a plain static (no super), a super-using static, an
// instance method (super.speak), an accessor, and a constructor (super()).
const SUBCLASS_SOURCE = `
  class Animal {
    #name: string;
    constructor(name: string) {
      this.#name = name;
    }
    speak(): string {
      return this.#name + " makes a sound";
    }
    static kingdom(): string {
      return "Animalia";
    }
  }

  class Dog extends Animal {
    constructor(name: string) {
      super(name);
    }
    speak(): string {
      return super.speak() + " — woof!";
    }
    get breed(): string {
      return "unknown";
    }
    // Plain static in a subclass — no super, no self. IR-claimable.
    static kingdom(): string {
      return "Animalia (canine)";
    }
    // Static that chains to the parent static via super — Phase E territory.
    static describe(): string {
      return super.kingdom() + " (dog)";
    }
  }

  export function test(): number {
    return Dog.kingdom() === "Animalia (canine)" ? 1 : 0;
  }
`;

describe("#2857 — IR selector claims static methods under `extends`", () => {
  it("claims a plain static method in a subclass (Dog_kingdom), like the parent-less static", () => {
    const claimed = classMembersFor(SUBCLASS_SOURCE);
    expect(claimed.has("Dog_kingdom")).toBe(true);
    // The parent-less static was already claimed before this slice.
    expect(claimed.has("Animal_kingdom")).toBe(true);
  });

  it("does NOT claim a super-using static (Dog_describe) — deferred to the Phase E inheritance slice", () => {
    const claimed = classMembersFor(SUBCLASS_SOURCE);
    expect(claimed.has("Dog_describe")).toBe(false);
    expect(fallbackReasons(SUBCLASS_SOURCE).get("Dog_describe")).toBe("class-method");
  });

  it("does NOT claim instance members / constructor of an `extends` class (Phase E)", () => {
    const reasons = fallbackReasons(SUBCLASS_SOURCE);
    // Dog constructor + super.speak() override stay class-method.
    expect(reasons.get("Dog_new")).toBe("class-method");
    expect(reasons.get("Dog_speak")).toBe("class-method");
    // The accessor stays class-method (touches private-field substrate).
    expect(reasons.get("Dog_breed")).toBe("class-method");
  });

  it("compiles + runs correctly (static dispatch on a subclass)", async () => {
    const r = await compile(SUBCLASS_SOURCE, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    const test = (instance.exports as Record<string, () => number>).test;
    expect(test()).toBe(1);
  });
});
