// #2652 — Standalone: parseInt / parseFloat must apply ToString to a non-string
// primitive argument (§19.2.5 step 1 / §19.2.4 step 1) BEFORE parsing.
//
// In standalone / WASI the native `parseInt` / `parseFloat` helpers take a
// string ref and immediately `any.convert_extern; ref.cast $AnyString` it. A
// non-string primitive argument (`parseInt(true)`, `parseInt(-1)`,
// `parseInt(undefined)`, `parseInt(null)`) was boxed as boolean/number/ref and
// tripped that cast ("illegal cast in parseInt()"). The fix runs the argument
// through the native ToString engine (`emitToString`) at the call site so the
// helper receives a real string ref. Host mode is unchanged (the JS import does
// `String(arg)` itself).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target?: "standalone" | "wasi"): Promise<unknown> {
  const opts: Record<string, unknown> = { fileName: "test.ts" };
  if (target) opts.target = target;
  const r = await compile(src, opts);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const imports = buildImports(r.imports, undefined, r.stringPool, {});
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => unknown)();
}

// Each case returns a packed bitmask; the test passes iff every bit is set.
//
// The argument's OWN static type is what drives the ToString routing (the
// compiler reads `getTypeAtLocation(arg0)`), exactly as in test262 where the
// args are bare primitives. `parseInt`/`parseFloat` are redeclared with an
// `any` parameter so TS does not coerce the arg node's type to `string` (which
// would defeat the type-based routing — and is itself a type error in real TS,
// but test262 runs the source loosely / with skipSemanticDiagnostics).
const SRC = `
declare function parseInt(s: any, radix?: number): number;
declare function parseFloat(s: any): number;
export function test(): number {
  let r = 0;
  // boolean primitive → ToString → "true"/"false" → NaN
  if (Number.isNaN(parseInt(true))) r += 1;
  if (Number.isNaN(parseInt(false))) r += 2;
  // number primitive → ToString → "-1" / "255"
  if (parseInt(-1) === parseInt("-1")) r += 4;
  if (parseInt(255) === 255) r += 8;
  // undefined / null → ToString → "undefined" / "null" → NaN
  if (Number.isNaN(parseInt(undefined))) r += 16;
  if (Number.isNaN(parseInt(null))) r += 32;
  // parseFloat parity
  if (Number.isNaN(parseFloat(true))) r += 64;
  if (parseFloat(1.5) === 1.5) r += 128;
  if (Number.isNaN(parseFloat(undefined))) r += 256;
  // string args still parse correctly (no regression)
  if (parseInt("0x10") === 16) r += 512;
  if (parseFloat("3.14") === 3.14) r += 1024;
  return r;
}`;

const ALL = 1 + 2 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 512 + 1024;

describe("#2652 parseInt/parseFloat ToString of primitive args", () => {
  it("host mode: all cases pass", async () => {
    expect(await run(SRC)).toBe(ALL);
  });

  it("standalone mode: all cases pass (was: illegal cast)", async () => {
    expect(await run(SRC, "standalone")).toBe(ALL);
  });

  it("wasi mode: all cases pass", async () => {
    expect(await run(SRC, "wasi")).toBe(ALL);
  });
});
