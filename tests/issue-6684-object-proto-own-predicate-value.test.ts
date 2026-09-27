// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6684 — `Object.prototype.hasOwnProperty` / `propertyIsEnumerable` read as a
// VALUE under `--target standalone`. lodash-es opens nearly every module with
// `var hasOwnProperty = objectProto.hasOwnProperty` and later calls
// `hasOwnProperty.call(value, key)`; the reflective closure used to be the
// catchable refusal `Object.prototype.hasOwnProperty is not yet implemented in
// --target standalone`, which killed lodash-es's standalone lane at module init.
//
// Each row runs the same source under Node (the oracle) and standalone.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SRC = `
var objectProto = Object.prototype;
var hasOwnProperty = objectProto.hasOwnProperty;
var propertyIsEnumerable = objectProto.propertyIsEnumerable;
function kind(fn) {
  try { return fn() ? 1 : 0; } catch (e) { return e instanceof TypeError ? 7 : 9; }
}
export function run() {
  var o = { a: 1 };
  var arr = [5, 6];
  var inherited = Object.create(o);
  var r = 0;
  r = r * 10 + kind(function () { return hasOwnProperty.call(o, "a"); });
  r = r * 10 + kind(function () { return hasOwnProperty.call(o, "b"); });
  r = r * 10 + kind(function () { return hasOwnProperty.call(inherited, "a"); });
  r = r * 10 + kind(function () { return hasOwnProperty.call(arr, "1"); });
  r = r * 10 + kind(function () { return hasOwnProperty.call(null, "a"); });
  r = r * 10 + kind(function () { return propertyIsEnumerable.call(o, "a"); });
  r = r * 10 + kind(function () { return propertyIsEnumerable.call(inherited, "a"); });
  r = r * 10 + kind(function () { return propertyIsEnumerable.call(undefined, "a"); });
  return r;
}
`;

describe("#6684 — Object.prototype own-property predicates as values (standalone)", () => {
  it("answers like Node, including the nullish-receiver TypeError", async () => {
    const expected = (
      new Function(`${SRC.replace("export function run", "return function run")}`) as () => () => number
    )()();
    expect(expected).toBe(10_017_107);
    const result = await compile(SRC, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as (() => void) | undefined)?.();
    expect((instance.exports.run as () => number)()).toBe(expected);
  });
});
