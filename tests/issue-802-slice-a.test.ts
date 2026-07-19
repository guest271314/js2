// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #802 Slice A — object-literal proto RECEIVERS promoted to the open `$Object`.
//
// Root cause: a plain object literal WITHOUT an `any` annotation
// (`const o = { x: 1 }`) is lowered to a closed-shape WasmGC struct, which has no
// `$proto` field. In `--target standalone`, `Object.setPrototypeOf(o, p)` routes
// to the native `__object_setPrototypeOf`, whose `ref.test $Object` fails for that
// closed struct → the [[Prototype]] link is silently dropped and every inherited
// read returns `undefined`/0. (The `#2580` tests all annotate `:any`, which
// diverts the literal to the `$Object` builder already; the un-annotated case is
// the gap Slice A closes.)
//
// Fix: a cheap pre-scan (`scanForDynamicProto`) detects object-literal receivers
// of `Object.setPrototypeOf` / `Reflect.setPrototypeOf` / `o.__proto__ =` and
// promotes just those literals to the open `$Object` representation — which
// already carries a mutable `$proto` and the full native setPrototypeOf / read /
// getPrototypeOf machine. Zero struct-layout change.
//
// STANDALONE-ONLY promotion: in gc/host mode a closed-shape struct receiver
// already gets correct dynamic-proto semantics via the `_wasmStructProto` WeakMap
// sidecar (#2739), so the host lane keeps its existing (working) path. The
// host-mode cases below therefore double as regression guards that the promotion
// gate does NOT disturb gc/host.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { assertEquivalent } from "./equivalence/helpers.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#802 Slice A — object-literal proto receiver → $Object (standalone)", () => {
  it("un-annotated literal receiver: inherited field read after setPrototypeOf (was 0)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { x: 1 };
           const base: any = { y: 5 };
           Object.setPrototypeOf(o, base);
           return (o as any).y;
         }`,
      ),
    ).toBe(5);
  });

  it("own property still reads correctly through the promoted $Object", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { x: 7 };
           const base: any = { y: 5 };
           Object.setPrototypeOf(o, base);
           return o.x;
         }`,
      ),
    ).toBe(7);
  });

  it("own property SHADOWS an inherited one of the same name", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { k: 9 };
           const base: any = { k: 1 };
           Object.setPrototypeOf(o, base);
           return (o as any).k;
         }`,
      ),
    ).toBe(9);
  });

  it("inherited METHOD lookup through the new proto", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { a: 2 };
           const base: any = { double(this: any): number { return this.a * 2; } };
           Object.setPrototypeOf(o, base);
           return (o as any).double();
         }`,
      ),
    ).toBe(4);
  });

  it("null proto: inherited read is undefined, own props intact", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { a: 3 };
           Object.setPrototypeOf(o, null);
           const missing = (o as any).nope === undefined ? 100 : 0;
           return o.a + missing;
         }`,
      ),
    ).toBe(103);
  });

  it("setPrototypeOf returns the receiver object", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { x: 8 };
           const base: any = { y: 4 };
           const r: any = Object.setPrototypeOf(o, base);
           return r.y + r.x;
         }`,
      ),
    ).toBe(12);
  });

  it("direct-literal receiver: Object.setPrototypeOf({...}, base) then inherited read", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const base: any = { y: 6 };
           const o: any = Object.setPrototypeOf({ x: 1 }, base);
           return o.y;
         }`,
      ),
    ).toBe(6);
  });

  it("o.__proto__ = base legacy setter promotes the receiver literal", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { x: 1 };
           const base: any = { y: 11 };
           (o as any).__proto__ = base;
           return (o as any).y;
         }`,
      ),
    ).toBe(11);
  });

  it("Reflect.setPrototypeOf on a literal receiver links the proto", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { x: 1 };
           const base: any = { y: 13 };
           Reflect.setPrototypeOf(o, base);
           return (o as any).y;
         }`,
      ),
    ).toBe(13);
  });

  it("unrelated literal (no proto mutation) is byte-unaffected — own read works", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o = { x: 21 };
           return o.x;
         }`,
      ),
    ).toBe(21);
  });
});

// gc/host lane. Promotion is STANDALONE-ONLY (spec §0: the dropped-link gap is
// standalone-only), so gc/host stays byte-for-byte unchanged. These are the
// regression guards that the (standalone-scoped) Slice A change did NOT disturb
// gc/host: a program using setPrototypeOf on a plain-object literal still
// compiles + validates in host mode, and OWN-property reads still match JS.
// (gc/host inherited-read-through-a-setPrototypeOf'd-proto is a separate host
// read-path item, outside Slice A — see the issue body notes.)
async function compilesInHostMode(src: string): Promise<boolean> {
  const r = await compile(src);
  return r.success && WebAssembly.validate(r.binary);
}

describe("#802 Slice A — object-literal proto receiver (gc/host regression guards)", () => {
  it("setPrototypeOf on a literal receiver still compiles + validates in host mode", async () => {
    expect(
      await compilesInHostMode(
        `export function test(): number {
           const o = { x: 1 };
           const base: any = { y: 5 };
           Object.setPrototypeOf(o, base);
           return o.x;
         }`,
      ),
    ).toBe(true);
  });

  it("own property read still matches JS in host mode (unchanged)", async () => {
    await assertEquivalent(
      `export function test(): number {
         const o = { x: 7 };
         const base: any = { y: 5 };
         Object.setPrototypeOf(o, base);
         return o.x;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("own property shadows inherited still matches JS in host mode", async () => {
    await assertEquivalent(
      `export function test(): number {
         const o = { k: 9 };
         const base: any = { k: 1 };
         Object.setPrototypeOf(o, base);
         return (o as any).k;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("o.__proto__ = / Reflect.setPrototypeOf on a literal still compile in host mode", async () => {
    expect(
      await compilesInHostMode(
        `export function test(): number {
           const o = { x: 1 };
           const base: any = { y: 11 };
           (o as any).__proto__ = base;
           Reflect.setPrototypeOf(o, base);
           return o.x;
         }`,
      ),
    ).toBe(true);
  });
});
