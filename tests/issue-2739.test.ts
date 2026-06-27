// #2739 (part a) — for-in must walk a prototype set via Object.setPrototypeOf
// on a WasmGC struct. §13.7.5.15 EnumerateObjectProperties walks
// [[GetPrototypeOf]]; an opaque struct has no host-observable [[Prototype]], so
// `Object.setPrototypeOf(struct, proto)` previously dropped the link on the
// floor (gc/host arm compiled both args, dropped proto) and the for-in walk's
// `Object.getPrototypeOf(struct)` returned null — the inherited keys never
// enumerated.
//
// Fix: record the link in `_wasmStructProto` via a `__host_set_struct_proto`
// host import (called from the Object.setPrototypeOf gc/host arm), and advance
// the for-in walk through `_structUserProto` (which consults that link).
//
// The constructor-function prototype-chain half (S12.6.4_A6*) and the
// Object.defineProperty array+accessor ordering half are carved to a follow-up.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function forInKeys(body: string): Promise<string> {
  const src = `export function test(): any { ${body} }`;
  const result = (await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
  } as never)) as any;
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  const ex = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return ex.test() as string;
}

describe("#2739 (a) — for-in walks a setPrototypeOf prototype chain", () => {
  it("enumerates own keys then the proto's keys (order-property-on-prototype)", async () => {
    // Mirrors test262 language/statements/for-in/order-property-on-prototype.js
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2", p3: "p3" };
        Object.setPrototypeOf(o, proto);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,p3,p4,");
  });

  it("walks a multi-level setPrototypeOf chain, own-shadows-proto", async () => {
    expect(
      await forInKeys(`
        const grand: any = { g: 1, shared: "grand" };
        const proto: any = { p: 1, shared: "proto" };
        Object.setPrototypeOf(proto, grand);
        const o: any = { a: 1, shared: "own" };
        Object.setPrototypeOf(o, proto);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("a,shared,p,g,");
  });

  it("setPrototypeOf(o, null) enumerates own keys only", async () => {
    expect(
      await forInKeys(`
        const proto: any = { p4: "p4" };
        const o: any = { p1: "p1", p2: "p2" };
        Object.setPrototypeOf(o, proto);
        Object.setPrototypeOf(o, null);
        let keys = "";
        for (const k in o) keys += k + ",";
        return keys;`),
    ).toBe("p1,p2,");
  });
});
