// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2984 bucket-1 — standalone gOPD with a LOCAL-ALIAS builtin receiver
// (`var m = Math; Object.getOwnPropertyDescriptor(m, "atan2")`).
//
// The Phase 3 synthesis gate was purely syntactic (bare unshadowed builtin
// identifier as arg0), but test262's 15.2.3.3-4-* fixtures overwhelmingly bind
// the receiver through a local first. Those shapes fell to the dynamic
// `__getOwnPropertyDescriptor` path and silently yielded `undefined` under
// `--target standalone`. The conservative reaching-def alias resolver
// (`resolveBuiltinReceiverName`, src/codegen/builtin-static-gopd.ts) accepts an
// alias only when exactly one declaration binds the name in the enclosing
// scope tree, its initializer unwraps to an unshadowed builtin identifier, and
// nothing else writes or re-binds the name — anything else keeps today's path.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2984 bucket-1: gOPD alias builtin receivers (standalone)", () => {
  it("const alias: gOPD(m, 'atan2') synthesizes a descriptor", async () => {
    const ret = await runStandalone(
      `const m: any = Math; const d = Object.getOwnPropertyDescriptor(m, "atan2"); if (d !== undefined) return 1; return 2;`,
    );
    expect(ret).toBe(1);
  });

  it("var alias: gOPD(m, 'atan2') synthesizes a descriptor", async () => {
    const ret = await runStandalone(
      `var m: any = Math; var d = Object.getOwnPropertyDescriptor(m, "atan2"); if (d !== undefined) return 1; return 2;`,
    );
    expect(ret).toBe(1);
  });

  it("alias descriptor .value keeps singleton identity with the plain read", async () => {
    const ret = await runStandalone(
      `const m: any = Math; const d = Object.getOwnPropertyDescriptor(m, "atan2"); const v: any = d ? (d as any).value : undefined; if (v === Math.atan2) return 1; return 2;`,
    );
    expect(ret).toBe(1);
  });

  it("alias + absent key on a closed-universe receiver answers undefined", async () => {
    const ret = await runStandalone(
      `const m: any = Math; const d = Object.getOwnPropertyDescriptor(m, "nope"); if (d === undefined) return 1; return 2;`,
    );
    expect(ret).toBe(1);
  });

  it("GUARD: a reassigned local is NOT treated as a builtin alias", async () => {
    // m no longer aliases Math at the call — the resolver must decline and the
    // dynamic path answers undefined for the plain-object receiver.
    const ret = await runStandalone(
      `let m: any = Math; m = {}; const d = Object.getOwnPropertyDescriptor(m, "atan2"); if (d === undefined) return 1; return 2;`,
    );
    expect(ret).toBe(1);
  });

  it("GUARD: a non-builtin initializer keeps the native object gOPD path", async () => {
    const ret = await runStandalone(
      `const m: any = { atan2: 5 }; const d = Object.getOwnPropertyDescriptor(m, "atan2"); if (d !== undefined) return 1; return 2;`,
    );
    expect(ret).toBe(1);
  });

  it("GUARD: a same-name shadow in a nested scope blocks resolution (no wrong synthesis)", async () => {
    // Two declarations of `m` in the scope tree → declCount !== 1 → decline.
    // The outer read then takes the dynamic path (undefined), never Math's
    // descriptor from the WRONG binding.
    const ret = await runStandalone(
      `var m: any = Math; function inner(): number { var m: any = { x: 1 }; return m.x; } if (inner() === 1) { const d = Object.getOwnPropertyDescriptor(m, "atan2"); if (d === undefined) return 1; return 3; } return 2;`,
    );
    expect(ret).toBe(1);
  });
});
