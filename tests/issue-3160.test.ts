// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3160 — self-hosted object-runtime slice 1. The two purest object-runtime
// helpers — `Object.getOwnPropertyDescriptors` and `Object.fromEntries` — are
// now compiled from ordinary TS source (`src/stdlib/object-runtime.ts`)
// through the compiler's own IR pipeline via the generalized self-hosting
// driver (#3161), replacing their hand-emitted `Instr[]` bodies in
// `ensureObjectRuntime`. Both are STANDALONE-native (host mode backs them with
// JS imports, so the self-hosted bodies are live only under `--target
// standalone`/`wasi`). These tests pin observable behaviour against Node's
// native semantics; the broader #2042 suites cover the fromEntries call-site
// normalisation and are the primary body-swap regression guard.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  // No host import leaked for either self-hosted helper.
  const env = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  expect(
    env.filter((n) => n === "__object_fromEntries" || n === "__object_getOwnPropertyDescriptors"),
    `must not leak host import: ${env.join(", ")}`,
  ).toEqual([]);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).run();
}

const fn = (body: string) => `export function run(): number { ${body} }`;

describe("#3160 self-hosted Object.fromEntries (standalone, IR-compiled TS source)", () => {
  it("single pair value", async () => {
    expect(await runStandalone(fn(`const o: any = Object.fromEntries([["a", 1]]); return o.a as number;`))).toBe(1);
  });

  it("multiple pairs + duplicate key (last wins)", async () => {
    expect(
      await runStandalone(
        fn(`const o: any = Object.fromEntries([["a", 1], ["a", 9], ["b", 2]]); return o.a as number;`),
      ),
    ).toBe(9);
  });

  it("key count via Object.keys", async () => {
    expect(
      await runStandalone(
        fn(`const o: any = Object.fromEntries([["a", 1], ["b", 2], ["c", 3]]); return Object.keys(o).length;`),
      ),
    ).toBe(3);
  });

  it("round-trips Object.entries", async () => {
    expect(
      await runStandalone(
        fn(
          `const src: any = { x: 7, y: 8 }; const o: any = Object.fromEntries(Object.entries(src)); return o.y as number;`,
        ),
      ),
    ).toBe(8);
  });
});

describe("#3160 self-hosted Object.getOwnPropertyDescriptors (standalone, IR-compiled TS source)", () => {
  it("descriptor value is readable", async () => {
    expect(
      await runStandalone(
        fn(`const o: any = { a: 5 }; const d: any = Object.getOwnPropertyDescriptors(o); return d.a.value as number;`),
      ),
    ).toBe(5);
  });

  it("descriptor enumerable flag for a plain own property", async () => {
    expect(
      await runStandalone(
        fn(
          `const o: any = { a: 1 }; const d: any = Object.getOwnPropertyDescriptors(o); return (d.a.enumerable as boolean) ? 1 : 0;`,
        ),
      ),
    ).toBe(1);
  });

  it("one descriptor entry per own key", async () => {
    expect(
      await runStandalone(
        fn(
          `const o: any = { a: 1, b: 2, c: 3 }; const d: any = Object.getOwnPropertyDescriptors(o); return Object.keys(d).length;`,
        ),
      ),
    ).toBe(3);
  });

  it("non-object receiver yields empty descriptor map", async () => {
    expect(
      await runStandalone(
        fn(`const d: any = Object.getOwnPropertyDescriptors(42 as any); return Object.keys(d).length;`),
      ),
    ).toBe(0);
  });
});
