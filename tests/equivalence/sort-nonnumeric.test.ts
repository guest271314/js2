import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #1967 — sort on string (externref) and struct (ref) element arrays silently
// no-op'd because the outer gate excluded non-numeric elements, even though
// compileArraySort internally handles them (comparator + default ToString sort).
describe("sort on non-numeric element arrays (#1967)", () => {
  it("string array default sort", async () => {
    await assertEquivalent(
      `export function test(): string {
         const a = ["b", "a", "c"];
         a.sort();
         return a[0] + a[1] + a[2];
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("object array comparator sort", async () => {
    await assertEquivalent(
      `export function test(): string {
         const a = [{ k: 2 }, { k: 1 }, { k: 3 }];
         a.sort((x, y) => x.k - y.k);
         return a[0].k + "," + a[1].k + "," + a[2].k;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("string array comparator sort (by length)", async () => {
    await assertEquivalent(
      `export function test(): string {
         const a = ["ccc", "a", "bb"];
         a.sort((x, y) => x.length - y.length);
         return a[0] + "," + a[1] + "," + a[2];
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric sort still works (unregressed)", async () => {
    await assertEquivalent(
      `export function test(): string {
         const a = [3, 1, 2];
         a.sort((x, y) => x - y);
         return a[0] + "," + a[1] + "," + a[2];
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
