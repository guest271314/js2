// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3921 follow-up) `[]`'s zero-length backing store is shared, not allocated.
 *
 * `push` grows on `capacity < length + argc`, which from capacity 0 always
 * trips — so the store an empty literal allocates is replaced by the first push
 * without ever being read. Sharing one immutable singleton per element type is
 * therefore observationally identical, and the census measured it removing
 * 8,922 allocations per acorn parse.
 *
 * The risk is aliasing: if any writer reached a backing store WITHOUT the
 * capacity check, it would scribble on every other empty array in the program.
 * That is what the mutation tests below exist for — two independently-created
 * empty arrays must not observe each other.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(body: string, env?: Record<string, string>): Promise<unknown> {
  const saved = process.env.JS2WASM_SHARED_EMPTY_VEC;
  if (env?.JS2WASM_SHARED_EMPTY_VEC !== undefined) process.env.JS2WASM_SHARED_EMPTY_VEC = env.JS2WASM_SHARED_EMPTY_VEC;
  try {
    const result = await compile(`export function main() {${body}}`, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    if (!result.success) throw new Error(result.errors.map((e) => e.message).join("; "));
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const ex = instance.exports as Record<string, (() => number) | undefined>;
    ex.__module_init?.();
    return ex.main!();
  } finally {
    // `= undefined` is NOT equivalent: assigning to process.env coerces to the
    // STRING "undefined", which `!== "0"` reads as ENABLED — so the control
    // would silently run instrumented and the comparison would be vacuous.
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (saved === undefined) delete process.env.JS2WASM_SHARED_EMPTY_VEC;
    else process.env.JS2WASM_SHARED_EMPTY_VEC = saved;
  }
}

/** Two empties pushed to independently — the aliasing case that would break. */
const NON_ALIASING = `
  var a = [1]; a.pop();
  var b = [1]; b.pop();
  a.push(7); a.push(8);
  var out = a.length * 100 + b.length * 10 + a[0];
  b.push(3);
  return out + b.length + b[0] + a.length;
`;

/** An empty that is never pushed must still read as length 0. */
const NEVER_PUSHED = `
  var a = [1]; a.pop();
  var b = [1]; b.pop();
  return a.length + b.length + (a.length === 0 ? 5 : 0);
`;

describe("#3921 — shared zero-length backing store", () => {
  for (const [name, body] of [
    ["independently-pushed empties do not alias", NON_ALIASING],
    ["an unpushed empty still reads length 0", NEVER_PUSHED],
  ] as const) {
    it(name, async () => {
      // Pinned against the paired control rather than a hand-computed constant:
      // sharing is a representation change, so the only claim is that it is
      // invisible. Whatever the lane answers, both must answer the same.
      expect(await run(body)).toBe(await run(body, { JS2WASM_SHARED_EMPTY_VEC: "0" }));
    });
  }

  it("matches plain JS on the aliasing fixture", async () => {
    expect(await run(NON_ALIASING)).toBe(new Function(NON_ALIASING)());
  });
});
