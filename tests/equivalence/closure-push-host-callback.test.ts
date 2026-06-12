import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #2070 — closures stored via Array.push/unshift / bare Map.set were wrapped as
// host callbacks (__make_callback externref) but the element-read call site
// expects the WasmGC closure struct, so ref.cast/struct.get trapped on null.
// The HOST_CALLBACK_METHODS allowlist was dead code; isHostCallbackArgument now
// consults it so storage methods get the closure-struct path.
describe("closures stored via push/unshift/Map.set (#2070)", () => {
  it("push then call element", async () => {
    await assertEquivalent(
      `export function test(): number {
         const fns: (() => number)[] = [];
         fns.push(() => 42);
         return fns[0]();
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("unshift then call element", async () => {
    await assertEquivalent(
      `export function test(): number {
         const fns: (() => number)[] = [];
         fns.push(() => 1);
         fns.unshift(() => 7);
         return fns[0]();
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("captured closure pushed and called", async () => {
    await assertEquivalent(
      `export function test(): number {
         const base = 10;
         const fns: (() => number)[] = [];
         fns.push(() => base + 5);
         return fns[0]();
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple closures pushed, each callable", async () => {
    await assertEquivalent(
      `export function test(): number {
         const fns: (() => number)[] = [];
         fns.push(() => 1);
         fns.push(() => 2);
         fns.push(() => 3);
         return fns[0]() * 100 + fns[1]() * 10 + fns[2]();
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("array map host HOF still works (host-callback path preserved)", async () => {
    await assertEquivalent(
      `export function test(): number {
         const arr = [1, 2, 3];
         const doubled = arr.map((x) => x * 2);
         return doubled[0] + doubled[1] + doubled[2];
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
