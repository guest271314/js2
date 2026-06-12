import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #1968 — [].join(...) must return "" not "null" (resultTmp was init'd to a null
// externref, which downstream string consumers stringify as "null").
describe("empty array join (#1968)", () => {
  it("[].join(',') is empty, not 'null'", async () => {
    await assertEquivalent(
      `export function test(): string {
         const a: number[] = [];
         return "<" + a.join(",") + ">";
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("filter-to-empty then join", async () => {
    await assertEquivalent(
      `export function test(): string {
         const a = [1, 2, 3];
         return "<" + a.filter((x) => x > 10).join(",") + ">";
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("string[] empty join", async () => {
    await assertEquivalent(
      `export function test(): string {
         const a: string[] = [];
         return "<" + a.join("-") + ">";
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-empty number join unregressed", async () => {
    await assertEquivalent(
      `export function test(): string {
         return [1, 2, 3].join(",");
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("single-element join unregressed", async () => {
    await assertEquivalent(
      `export function test(): string {
         return [42].join(",");
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-empty string join unregressed", async () => {
    await assertEquivalent(
      `export function test(): string {
         return ["a", "b", "c"].join("-");
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
