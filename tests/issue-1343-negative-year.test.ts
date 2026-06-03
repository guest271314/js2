/**
 * #1343 Slice 5 — negative-year serialization in the DateString / UTCString
 * formatter family.
 *
 * ECMAScript §21.4.4.41.1 (DateString) and §21.4.4.43 (toUTCString) require a
 * negative year to be rendered with a leading "-" and a *minimum* of four
 * digits of magnitude: year -1 → "-0001", year -12345 → "-12345". The runtime
 * `_formatDate` helper previously hard-coded 6-digit padding for all negative
 * years ("-000001"), which only matches the ISO (toISOString) ±YYYYYY form —
 * not the toString / toDateString / toUTCString family.
 *
 * Fix lives in `src/runtime.ts::_formatDate` (the `yearStr` computation). The
 * ISO path is unaffected: it delegates to the host `d.toISOString()` and keeps
 * its own 6-digit extended-year form.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// Timestamps (ms since epoch) for July 1 of the given proleptic-Gregorian year,
// computed from `new Date("<sign><year>-07-01T00:00Z").getTime()`.
const MS_YEAR_NEG_1 = -62183116800000;
const MS_YEAR_NEG_12345 = -451722096000000;

describe("issue #1343 Slice 5 — negative-year DateString/UTCString padding", () => {
  it("toUTCString serializes year -1 with four digits", async () => {
    const source = `
      export function test(): string {
        return new Date(${MS_YEAR_NEG_1}).toUTCString().split(" ")[3];
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("-0001");
  });

  it("toUTCString keeps all digits of a five-digit negative year", async () => {
    const source = `
      export function test(): string {
        return new Date(${MS_YEAR_NEG_12345}).toUTCString().split(" ")[3];
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("-12345");
  });

  it("toDateString serializes year -1 with four digits", async () => {
    const source = `
      export function test(): string {
        return new Date(${MS_YEAR_NEG_1}).toDateString().split(" ")[3];
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("-0001");
  });

  it("toString serializes year -1 with four digits", async () => {
    const source = `
      export function test(): string {
        return new Date(${MS_YEAR_NEG_1}).toString().split(" ")[3];
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("-0001");
  });

  it("toISOString keeps its own six-digit extended-year form", async () => {
    const source = `
      export function test(): string {
        return new Date(${MS_YEAR_NEG_1}).toISOString();
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("-000001-07-01T00:00:00.000Z");
  });

  it("positive years still pad to four digits (year 20)", async () => {
    const source = `
      export function test(): string {
        return new Date(-61536067200000).toUTCString().split(" ")[3];
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("0020");
  });
});
