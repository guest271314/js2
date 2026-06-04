// #1841 — the element-section parser (src/link/reader.ts) must honor the full
// 3-bit flags field (0-7), not just active flag-0. Previously `flags & 0x02`
// consumed a bogus tableidx for declarative (flag 3), and the parser always
// scanned for an offset-expr even for passive/declarative segments (which have
// none) — desyncing the cursor and corrupting every following section.
//
// These tests build a raw element-section body for each flag case, parse it,
// and assert (a) the cursor lands exactly at the end (no desync) and (b) the
// fields are recovered correctly.
import { describe, expect, it } from "vitest";
import { parseElementSegmentsForTest } from "../src/link/reader.js";

// A minimal active offset const-expr: `i32.const 0` `end` = 0x41 0x00 0x0b.
const OFFSET_EXPR = [0x41, 0x00, 0x0b];
// A minimal element expression: `ref.func 0` `end` = 0xd2 0x00 0x0b.
const REF_FUNC_EXPR = [0xd2, 0x00, 0x0b];
const FUNCREF = 0x70; // elemkind / reftype byte

function body(...segments: number[][]): Uint8Array {
  return new Uint8Array([segments.length, ...segments.flat()]);
}

describe("#1841 — element-section flag bitfield (cases 0-7)", () => {
  it("flag 0: active, table 0, funcref, funcidx*", () => {
    const seg = [0x00, ...OFFSET_EXPR, 0x02, 0x05, 0x07]; // 2 funcs: 5, 7
    const bytes = body(seg);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length); // no desync
    expect(elements).toHaveLength(1);
    expect(elements[0]!.flags).toBe(0);
    expect(elements[0]!.tableIdx).toBe(0);
    expect(elements[0]!.offsetExpr).not.toBeNull();
    expect(elements[0]!.funcIndices).toEqual([5, 7]);
    expect(elements[0]!.kindByte).toBeNull();
  });

  it("flag 1: passive, elemkind, funcidx*", () => {
    const seg = [0x01, FUNCREF, 0x01, 0x09]; // elemkind=0x00 actually funcidx-kind 0x00? use 0x00
    // elemkind for funcidx segments is 0x00; use that to be spec-faithful.
    const segFixed = [0x01, 0x00, 0x01, 0x09];
    const bytes = body(segFixed);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length);
    expect(elements[0]!.flags).toBe(1);
    expect(elements[0]!.offsetExpr).toBeNull(); // passive — no offset
    expect(elements[0]!.kindByte).toBe(0x00);
    expect(elements[0]!.funcIndices).toEqual([9]);
    void seg;
  });

  it("flag 2: active, explicit tableidx, elemkind, funcidx*", () => {
    const seg = [0x02, 0x03, ...OFFSET_EXPR, 0x00, 0x02, 0x01, 0x02]; // table 3, kind 0, funcs 1,2
    const bytes = body(seg);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length); // the bug consumed a bogus tableidx for 3, desyncing
    expect(elements[0]!.flags).toBe(2);
    expect(elements[0]!.tableIdx).toBe(3);
    expect(elements[0]!.offsetExpr).not.toBeNull();
    expect(elements[0]!.kindByte).toBe(0x00);
    expect(elements[0]!.funcIndices).toEqual([1, 2]);
  });

  it("flag 3: declarative, elemkind, funcidx* (no tableidx, no offset)", () => {
    const seg = [0x03, 0x00, 0x01, 0x04]; // kind 0, func 4
    const bytes = body(seg);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    // The old code did `flags & 0x02` → read a bogus tableidx, then scanned for a
    // non-existent offset-expr → ran off the end. This asserts the fix.
    expect(finalPos).toBe(bytes.length);
    expect(elements[0]!.flags).toBe(3);
    expect(elements[0]!.tableIdx).toBe(0); // no explicit table for declarative
    expect(elements[0]!.offsetExpr).toBeNull();
    expect(elements[0]!.kindByte).toBe(0x00);
    expect(elements[0]!.funcIndices).toEqual([4]);
  });

  it("flag 4: active, table 0, funcref, expr*", () => {
    const seg = [0x04, ...OFFSET_EXPR, 0x01, ...REF_FUNC_EXPR];
    const bytes = body(seg);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length);
    expect(elements[0]!.flags).toBe(4);
    expect(elements[0]!.offsetExpr).not.toBeNull();
    expect(elements[0]!.kindByte).toBeNull(); // funcref implied for flag 4
    expect(elements[0]!.elemCount).toBe(1);
    expect(elements[0]!.elemExprs).not.toBeNull();
    expect(elements[0]!.funcIndices).toEqual([]);
  });

  it("flag 5: passive, reftype, expr*", () => {
    const seg = [0x05, FUNCREF, 0x01, ...REF_FUNC_EXPR];
    const bytes = body(seg);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length);
    expect(elements[0]!.flags).toBe(5);
    expect(elements[0]!.offsetExpr).toBeNull();
    expect(elements[0]!.kindByte).toBe(FUNCREF);
    expect(elements[0]!.elemExprs).not.toBeNull();
  });

  it("flag 6: active, explicit tableidx, reftype, expr*", () => {
    const seg = [0x06, 0x02, ...OFFSET_EXPR, FUNCREF, 0x01, ...REF_FUNC_EXPR];
    const bytes = body(seg);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length);
    expect(elements[0]!.flags).toBe(6);
    expect(elements[0]!.tableIdx).toBe(2);
    expect(elements[0]!.offsetExpr).not.toBeNull();
    expect(elements[0]!.kindByte).toBe(FUNCREF);
    expect(elements[0]!.elemExprs).not.toBeNull();
  });

  it("flag 7: declarative, reftype, expr*", () => {
    const seg = [0x07, FUNCREF, 0x02, ...REF_FUNC_EXPR, ...REF_FUNC_EXPR];
    const bytes = body(seg);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length);
    expect(elements[0]!.flags).toBe(7);
    expect(elements[0]!.offsetExpr).toBeNull();
    expect(elements[0]!.kindByte).toBe(FUNCREF);
    expect(elements[0]!.elemCount).toBe(2);
    expect(elements[0]!.elemExprs).not.toBeNull();
  });

  it("multiple mixed segments parse without cursor drift", () => {
    const active = [0x00, ...OFFSET_EXPR, 0x01, 0x00];
    const declarative = [0x03, 0x00, 0x01, 0x01];
    const passiveExpr = [0x05, FUNCREF, 0x01, ...REF_FUNC_EXPR];
    const bytes = body(active, declarative, passiveExpr);
    const { elements, finalPos } = parseElementSegmentsForTest(bytes);
    expect(finalPos).toBe(bytes.length);
    expect(elements.map((e) => e.flags)).toEqual([0, 3, 5]);
  });
});
