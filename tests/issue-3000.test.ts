// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3000 — IR private-field substrate (issue Phase 1).
//
// Before this slice, IR's Phase-1 shape gate rejected any `this.#x` read or
// write: `PropertyAccessExpression` / assignment LHS were gated on
// `ts.isIdentifier(name)`, and a `PrivateIdentifier` is not an `Identifier`, so
// the member fell into the `body-shape-rejected` bucket before any lowering.
//
// This slice teaches the selector (`src/ir/select.ts`) and the AST→IR lowerer
// (`src/ir/from-ast.ts`) to accept `PrivateIdentifier` field access, mangling
// `#x` → `__priv_x` (byte-identical to the legacy `resolveClassMemberName`) so
// the IR `class.get`/`class.set` resolve the SAME `structFields` slot the
// legacy path allocated. It clears the two class-member `body-shape-rejected`
// attributions on `website/playground/examples/js/classes.ts` (`Animal_new`,
// `Animal_speak`).
//
// Scope / NON-goals (the XL remainder stays on #3000's later phases):
//   - Accessors (get/set) still bucket as `class-method` (selector arm).
//   - Constructors are claimed by the selector but Phase B integration does not
//     yet build ConstructorDeclarations (it handles MethodDeclarations only),
//     so `Animal_new` stays on the legacy body — the claim is metric-only /
//     byte-inert for the ctor. Constructor IR emission is the separate Phase C.
//   - Inheritance / `super` (Dog extends Animal) stays `class-method`.
//   - A void method whose *tail* statement is a field assignment
//     (`set(v){ this.#x = v }`) is rejected by the pre-existing
//     `isPhase1Tail`→`isPhase1Expr` gate (which rejects ALL `=` expressions,
//     public or private) — not part of this substrate.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { planIrCompilation } from "../src/ir/select.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

function selection(source: string) {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
}

// Instantiate through the PRODUCTION runtime path (`compileAndInstantiate` →
// native `wasm:js-string` builtins, JS polyfill fallback). #3000 Phase-1b makes
// string-field class members genuinely IR-emit, and the IR path expresses string
// ops as native js-string *builtin* imports rather than tracked host imports —
// so `CompileResult.importObject` (the JS-polyfill map, keyed off
// `result.imports`) is empty for an all-builtin module and the old raw
// `WebAssembly.instantiate(binary, importObject)` harness could not resolve
// `wasm:js-string`. The builtins-first runtime resolves them exactly as test262
// / the playground do.
async function runString(source: string): Promise<string> {
  const exports = await compileAndInstantiate(source);
  const fn = (exports as Record<string, () => unknown>).test;
  return String(fn());
}

// Mirrors website/playground/examples/js/classes.ts: a flat class with private
// fields read in an instance method + written in the constructor, plus a
// subclass whose override chains to the parent method via `super`.
const CLASSES_SOURCE = `
  class Animal {
    #name: string;
    #age: number;
    constructor(name: string, age: number) {
      this.#name = name;
      this.#age = age;
    }
    speak(): string {
      return this.#name + " makes a sound";
    }
    describe(): string {
      return this.#name;
    }
  }
  class Dog extends Animal {
    #breed: string;
    constructor(name: string, age: number, breed: string) {
      super(name, age);
      this.#breed = breed;
    }
    speak(): string {
      return super.speak() + " — woof!";
    }
  }
  export function test(): string {
    const rex = new Dog("Rex", 4, "Labrador");
    return rex.speak() + "|" + rex.describe();
  }
`;

describe("#3000 — IR private-field substrate", () => {
  it("selector claims a flat-class instance method that reads a private field", () => {
    const sel = selection(CLASSES_SOURCE);
    const claimed = new Set(sel.classMembers ?? []);
    // Private-field READ in an instance-method return tail.
    expect(claimed.has("Animal_speak")).toBe(true);
    expect(claimed.has("Animal_describe")).toBe(true);
  });

  it("selector claims a constructor whose body only writes private fields", () => {
    const sel = selection(CLASSES_SOURCE);
    const claimed = new Set(sel.classMembers ?? []);
    // Private-field WRITE in a (flat-class) ctor body. Metric-only: Phase B
    // integration keeps the legacy ctor body (byte-inert), but the shape gate
    // no longer rejects it as `body-shape-rejected`.
    expect(claimed.has("Animal_new")).toBe(true);
  });

  it("no member of the flat class stays `body-shape-rejected`", () => {
    const sel = selection(CLASSES_SOURCE);
    const reasons = new Map<string, string>();
    for (const fb of sel.fallbacks ?? []) reasons.set(fb.name, fb.reason);
    expect(reasons.get("Animal_speak")).toBeUndefined();
    expect(reasons.get("Animal_new")).toBeUndefined();
    // #3000-E landed inheritance/super: `Dog_speak` (a `super.speak()` override)
    // is now CLAIMED, not deferred as class-method. (Was `class-method` pre-#3000-E.)
    expect(reasons.get("Dog_speak")).toBeUndefined();
  });

  it("compiles + runs: private read via IR, incl. super-dispatch to the IR parent method", async () => {
    // Dog.speak() (legacy override) calls super.speak() → the now-IR-emitted
    // Animal_speak with a Dog receiver (WasmGC subtype). Validates the private
    // `class.get` resolves the correct struct slot across the subtype boundary.
    expect(await runString(CLASSES_SOURCE)).toBe("Rex makes a sound — woof!|Rex");
  });

  it("compiles + runs: private field written in ctor, read+concatenated in a method", async () => {
    // Ctor writes `this.#label` (private WRITE, non-tail body statement) and a
    // method reads it back (private READ). String-typed so the compile emits a
    // populated `importObject` (numeric-only class modules trip a pre-existing
    // empty-importObject harness quirk unrelated to this slice).
    const src = `
      class Box {
        #label: string;
        constructor(label: string) { this.#label = label; }
        shout(): string { return this.#label + "!"; }
      }
      export function test(): string {
        const b = new Box("hi");
        return b.shout();
      }
    `;
    expect(await runString(src)).toBe("hi!");
  });
});
