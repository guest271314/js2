// #1833 — implicit externref-backed subclass constructors must forward every
// observed constructor argument to the built-in parent.
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.ts";

async function runNumber(source: string): Promise<number> {
  const exports = await compileAndInstantiate(source);
  return (exports.test as () => number)();
}

describe("#1833 implicit subclass constructor forwarding", () => {
  it("forwards DataView byteOffset through the default derived constructor", async () => {
    expect(
      await runNumber(`
        class Sub extends DataView {}

        export function test(): number {
          const buf = new ArrayBuffer(16);
          const view = new Sub(buf, 4, 4);
          return view.byteOffset;
        }
      `),
    ).toBe(4);
  });

  it("forwards DataView byteLength through the default derived constructor", async () => {
    expect(
      await runNumber(`
        class Sub extends DataView {}

        export function test(): number {
          const buf = new ArrayBuffer(16);
          const view = new Sub(buf, 4, 4);
          return view.byteLength;
        }
      `),
    ).toBe(4);
  });
});
