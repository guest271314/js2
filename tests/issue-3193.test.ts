import { test } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// #3193 — the shape-inferred `Array.prototype.<M>.call(shapeGlobal, ...)` lane.
// These exercise the module-global object-shape-widened receiver path that
// previously dispatched to the dedicated clones
// compileArrayPrototype{IndexOf,Includes,Every,Some,ForEach}. The clones are
// deleted in favour of routing through the same synthetic-call rewrite the
// TS-type lane already uses; behavior must remain identical.

const SHAPE_PRELUDE = `
var obj: any = {};
obj.length = 4;
obj[0] = 10;
obj[1] = 20;
obj[2] = 30;
obj[3] = 20;
`;

test("#3193 shape-inferred Array.prototype.indexOf.call", async () => {
  const src = `${SHAPE_PRELUDE}
export function found(): number { return Array.prototype.indexOf.call(obj, 20); }
export function firstOnly(): number { return Array.prototype.indexOf.call(obj, 30); }
export function missing(): number { return Array.prototype.indexOf.call(obj, 99); }
export function firstElem(): number { return Array.prototype.indexOf.call(obj, 10); }
`;
  await assertEquivalent(src, [
    { fn: "found", args: [] },
    { fn: "firstOnly", args: [] },
    { fn: "missing", args: [] },
    { fn: "firstElem", args: [] },
  ]);
});

test("#3193 shape-inferred Array.prototype.includes.call", async () => {
  const src = `${SHAPE_PRELUDE}
export function has30(): number { return Array.prototype.includes.call(obj, 30) ? 1 : 0; }
export function has99(): number { return Array.prototype.includes.call(obj, 99) ? 1 : 0; }
export function has10(): number { return Array.prototype.includes.call(obj, 10) ? 1 : 0; }
`;
  await assertEquivalent(src, [
    { fn: "has30", args: [] },
    { fn: "has99", args: [] },
    { fn: "has10", args: [] },
  ]);
});

test("#3193 shape-inferred Array.prototype.every.call", async () => {
  const src = `${SHAPE_PRELUDE}
export function allGe10(): number { return Array.prototype.every.call(obj, (x: any) => x >= 10) ? 1 : 0; }
export function allGt15(): number { return Array.prototype.every.call(obj, (x: any) => x > 15) ? 1 : 0; }
export function withIndex(): number { return Array.prototype.every.call(obj, (x: any, i: number) => x >= i) ? 1 : 0; }
`;
  await assertEquivalent(src, [
    { fn: "allGe10", args: [] },
    { fn: "allGt15", args: [] },
    { fn: "withIndex", args: [] },
  ]);
});

test("#3193 shape-inferred Array.prototype.some.call", async () => {
  const src = `${SHAPE_PRELUDE}
export function anyGt25(): number { return Array.prototype.some.call(obj, (x: any) => x > 25) ? 1 : 0; }
export function anyGt99(): number { return Array.prototype.some.call(obj, (x: any) => x > 99) ? 1 : 0; }
export function anyEq10(): number { return Array.prototype.some.call(obj, (x: any) => x === 10) ? 1 : 0; }
`;
  await assertEquivalent(src, [
    { fn: "anyGt25", args: [] },
    { fn: "anyGt99", args: [] },
    { fn: "anyEq10", args: [] },
  ]);
});

test("#3193 shape-inferred Array.prototype.forEach.call", async () => {
  const src = `${SHAPE_PRELUDE}
export function sum(): number { let s = 0; Array.prototype.forEach.call(obj, (x: any) => { s += x; }); return s; }
export function idxSum(): number { let s = 0; Array.prototype.forEach.call(obj, (x: any, i: number) => { s += i; }); return s; }
export function count(): number { let c = 0; Array.prototype.forEach.call(obj, () => { c += 1; }); return c; }
`;
  await assertEquivalent(src, [
    { fn: "sum", args: [] },
    { fn: "idxSum", args: [] },
    { fn: "count", args: [] },
  ]);
});
