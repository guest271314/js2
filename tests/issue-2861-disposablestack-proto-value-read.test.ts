// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2861 (slice 3) — standalone `DisposableStack.prototype` /
// `AsyncDisposableStack.prototype` value reads, extending the native-proto-glue
// chain (ArrayBuffer/DataView #2861-s1; SharedArrayBuffer/WeakRef/FinalizationRegistry
// #2861-s2; #2376 Date, #2651 TypedArray, #2374 String/Number/Boolean, #2193
// Array/Object, #2175 RegExp).
//
// Reading `<Stack>.prototype.<member>` (or bare `<Stack>.prototype`) AS A VALUE
// refused in standalone with the "built-in static property value read is not
// supported in --target standalone (#1907 / #1888 S6-b)" compile error. Fix:
// append the DisposableStack (slot 41) / AsyncDisposableStack (slot 42) brands to
// native-proto.ts, register glue (use/adopt/defer/move/dispose[Async] methods +
// the `disposed` accessor getter — `makeGlueWithGetters`), and wire them into
// tryEnsureNativeProtoBrand. The TC39 Explicit Resource Management resource list
// lives on the INSTANCE, never the proto, so the value-object materialization is
// clean. Member-CLOSURE bodies degrade to a catchable TypeError until native
// bodies land (the #2193/#2651 pattern).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2861 slice 3 — standalone DisposableStack.prototype value reads", () => {
  it("DisposableStack.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const p: any = DisposableStack.prototype; return p ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("DisposableStack.prototype.use value read compiles host-free (was a hard refusal)", async () => {
    const r = await compile(
      `export function test(): number { const m: any = DisposableStack.prototype.use; return 1; }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("DisposableStack.prototype.use.length folds the spec arity (1)", async () => {
    expect(await runStandalone(`export function test(): number { return DisposableStack.prototype.use.length; }`)).toBe(
      1,
    );
  });

  it("DisposableStack.prototype.adopt.length folds the spec arity (2)", async () => {
    expect(
      await runStandalone(`export function test(): number { return DisposableStack.prototype.adopt.length; }`),
    ).toBe(2);
  });

  it("DisposableStack.prototype.move.length folds the spec arity (0)", async () => {
    expect(
      await runStandalone(`export function test(): number { return DisposableStack.prototype.move.length; }`),
    ).toBe(0);
  });

  it("DisposableStack.prototype.disposed is an accessor getter — .length folds to 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (DisposableStack.prototype as any).disposed.length; }`,
      ),
    ).toBe(0);
  });
});

describe("#2861 slice 3 — standalone AsyncDisposableStack.prototype value reads", () => {
  it("AsyncDisposableStack.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const p: any = AsyncDisposableStack.prototype; return p ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("AsyncDisposableStack.prototype.disposeAsync.length folds the spec arity (0)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return AsyncDisposableStack.prototype.disposeAsync.length; }`,
      ),
    ).toBe(0);
  });

  it("AsyncDisposableStack.prototype.adopt.length folds the spec arity (2)", async () => {
    expect(
      await runStandalone(`export function test(): number { return AsyncDisposableStack.prototype.adopt.length; }`),
    ).toBe(2);
  });
});

describe("#2861 slice 3 — no regression on sibling proto glue", () => {
  it("sibling: FinalizationRegistry.prototype value read (the #2861 slice-2 path) still resolves", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const p: any = FinalizationRegistry.prototype; return p ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("sibling: ArrayBuffer.prototype.slice.length still folds (2)", async () => {
    expect(await runStandalone(`export function test(): number { return ArrayBuffer.prototype.slice.length; }`)).toBe(
      2,
    );
  });
});
