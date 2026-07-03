// #3026 — early error: trailing comma after a rest element in a destructuring
// pattern is a parse-time SyntaxError.
//
// The pre-existing "rest must be last" check caught `[...x, y]` (an element
// following the rest) but missed the bare trailing-comma case `[...x,]` /
// `({...x,})`. Per ES2015+ grammar, an AssignmentRestElement /
// BindingRestElement / AssignmentRestProperty / BindingRestProperty must be
// the final element, and no trailing comma (elision) may follow it. TypeScript's
// parser accepts the trailing comma silently, so the early-error pass detects it
// via the NodeArray `hasTrailingComma` flag when the last element is the rest.
//
// Guard against false positives: a trailing comma after a NON-rest element
// (`[a,]`, `{a,}`) is valid, and a spread with a trailing comma in an array/
// object literal *value* (`[...x,]`, `{...x,}` on the RHS) is valid.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function isRejected(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts" });
  return !r.success;
}

describe("#3026 — trailing comma after rest element in destructuring pattern", () => {
  it("rejects trailing comma after array assignment rest (`[...x,] = y`)", async () => {
    expect(await isRejected("[...x,] = [1, 2];")).toBe(true);
  });

  it("rejects trailing comma after rest in a for-of head (`for ([...x,] of ...)`)", async () => {
    expect(await isRejected("for ([...x,] of [[]]) ;")).toBe(true);
  });

  it("rejects trailing comma after array binding rest (`const [...x,] = y`)", async () => {
    expect(await isRejected("const [...x,] = [1, 2];")).toBe(true);
  });

  it("rejects trailing comma after object assignment rest (`({...x,} = y)`)", async () => {
    expect(await isRejected("({...x,} = {});")).toBe(true);
  });

  it("rejects trailing comma after object binding rest (`const {...x,} = y`)", async () => {
    expect(await isRejected("const {...x,} = {};")).toBe(true);
  });

  // ── Valid controls: must NOT be rejected ──────────────────────────────────
  it("accepts a spread with trailing comma in an array literal value", async () => {
    expect(await isRejected("const x = [1]; const v = [...x,];")).toBe(false);
  });

  it("accepts a spread with trailing comma in an object literal value", async () => {
    expect(await isRejected("const x = {}; const o = {...x,};")).toBe(false);
  });

  it("accepts a rest without a trailing comma (`const [...x] = y`)", async () => {
    expect(await isRejected("const [...x] = [1, 2];")).toBe(false);
  });

  it("accepts a trailing comma after a non-rest array element (`[a,] = y`)", async () => {
    expect(await isRejected("let a; [a,] = [1];")).toBe(false);
  });

  it("accepts a trailing comma after a non-rest object element (`const {a,} = y`)", async () => {
    expect(await isRejected("const {a,} = {a: 1};")).toBe(false);
  });
});
