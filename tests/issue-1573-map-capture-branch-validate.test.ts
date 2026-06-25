// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1573 (ESLint next-layer survey) — bug A: a branch arm that leaves a value on
// the stack FOLLOWED BY a void (empty-block-type) structured instruction was
// mis-typed by the stack-balance pass, which injected a wrong `f64.convert_i32_s
// + __box_number` coercion and produced invalid Wasm.
//
// Root cause: `inferLastType` in src/codegen/stack-balance.ts walked backwards to
// find a branch arm's result type but had NO case for structured control flow
// (`if`/`block`/`loop`/`try`). For an arm shaped like
//   [ call (-> externref),            ; the value (e.g. arr.map(cb) host call)
//     local.get $cell, ref.is_null, i32.eqz, if (void) ]   ; callback writeback
// it skipped the trailing void `if` and misread the writeback's internal
// `i32.eqz` as the arm's result type ("i32"). `fixBranchType` then coerced that
// phantom i32 → externref, splicing `f64.convert_i32_s + __box_number` over the
// real externref value → `f64.convert_i32_s expected i32, found externref`.
//
// This is exactly the ESLint `LazyLoadingRuleMap_new` validation failure (the
// `extends Map` ctor `super(debug.enabled ? loaders.map(cb) : loaders)` where
// `cb` mutates a captured `remaining`). It is a GENERAL bug: any
// `expectedExternref(cond ? arr.map(capturingCb) : x)` shape hit it.
//
// Fix: `inferLastType` now stops at a structured instruction and reports its
// block result type (or null when void/multi-value, so `fixBranchType` skips
// rather than mis-coercing).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** Compile JS and return whether the emitted module is structurally valid. */
async function validates(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "t.ts", allowJs: true });
  expect(r.success).toBe(true);
  return WebAssembly.validate(r.binary);
}

describe("#1573 bug A — branch arm value followed by void writeback is not mis-coerced", () => {
  it("extends Map: super(cond ? loaders.map(capturingCb) : loaders) validates", async () => {
    const src = `
class LazyMap extends Map {
  constructor(loaders) {
    let remaining = loaders.length;
    super(
      debugEnabled
        ? loaders.map(([ruleId, load]) => {
            let cache = null;
            return [ruleId, () => {
              if (!cache) { --remaining; cache = load(); }
              return cache;
            }];
          })
        : loaders
    );
  }
}
var debugEnabled = false;
export function test() { return 1; }
`;
    expect(await validates(src)).toBe(true);
  });

  it("plain externref-arg context: take(cond ? arr.map(capturingCb) : arr) validates", async () => {
    const src = `
function take(x) { return x; }
function f(loaders) {
  let r = loaders.length;
  return take(debugEnabled ? loaders.map((x) => { --r; return x; }) : loaders);
}
var debugEnabled = false;
export function test() { return 1; }
`;
    expect(await validates(src)).toBe(true);
  });

  it("the same shape WITHOUT a captured mutation still validates (no false-positive change)", async () => {
    const src = `
class M extends Map {
  constructor(loaders) {
    super(debugEnabled ? loaders.map(([id, load]) => [id, () => load()]) : loaders);
  }
}
var debugEnabled = false;
export function test() { return 1; }
`;
    expect(await validates(src)).toBe(true);
  });
});
