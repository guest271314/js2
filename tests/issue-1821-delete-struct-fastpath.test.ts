// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1821 — `delete` struct fast-path defects (ECMAScript §13.5.1):
 *  1. `delete obj.nonConfigurable` returned `true` (the property-access arm
 *     dropped `__delete_property`'s result and hardcoded `i32.const 1`).
 *  2. `delete obj["x"]` and `delete obj.x` diverged: the element-access arm
 *     only did the struct.set sentinel and skipped the `__delete_property`
 *     sidecar that the property-access arm performs (#1334), so the
 *     `Object.defineProperty` descriptor survived and `hasOwnProperty("x")`
 *     differed between the two forms.
 *
 * Fix: return `__delete_property`'s result from both arms (spec configurability
 * result), and mirror the sidecar cleanup in the element-access arm.
 */

async function run(source: string): Promise<number> {
  const r = await compile(source, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { test: () => number }).test();
}

describe("#1821 delete struct fast-path", () => {
  it("delete of a plain (deletable) field returns true — dot and bracket", async () => {
    expect(
      await run(
        `class C { x = 5; } export function test(): number { const o = new C(); return (delete (o as any).x) ? 1 : 0; }`,
      ),
    ).toBe(1);
    expect(
      await run(
        `class C { x = 5; } export function test(): number { const o = new C(); return (delete (o as any)["x"]) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("delete of a non-configurable property returns false", async () => {
    expect(
      await run(`
        class C { x = 5; }
        export function test(): number {
          const o: any = new C();
          Object.defineProperty(o, "x", { configurable: false, value: 5 });
          return (delete o.x) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("delete obj['x'] removes the descriptor sidecar like delete obj.x (parity)", async () => {
    const bracket = `
      class C { x = 5; }
      export function test(): number {
        const o: any = new C();
        Object.defineProperty(o, "x", { configurable: true, value: 5, enumerable: true });
        delete o["x"];
        return o.hasOwnProperty("x") ? 1 : 0;
      }`;
    const dot = bracket.replace('delete o["x"]', "delete o.x");
    expect(await run(bracket), "bracket form leaves descriptor").toBe(0);
    expect(await run(dot), "dot form leaves descriptor").toBe(0);
  });
});
