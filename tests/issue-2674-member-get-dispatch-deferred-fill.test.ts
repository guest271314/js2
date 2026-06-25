// #2674 — the `any`-receiver member-READ multi-struct dispatch now routes its
// terminal (un-matched) case through a DEFERRED-FILL `__get_member_<name>`
// dispatcher, the SYMMETRIC read-side counterpart of #2664's `__set_member_<name>`.
//
// The inline `findAlternateStructsForField` read chain froze its struct-candidate
// set at the read's compile time, so a field reader compiled before a later
// struct type only got the earlier candidate's `ref.test` arm → a read of the
// real (later-type) instance fell to `__extern_get` → `undefined` while #2664's
// deferred WRITE hit the slot (read/write divergence). Routing the read terminal
// through a finalize-filled dispatcher (complete candidate set) closes the gap.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<{ exp: any; wat: string }> {
  const r: any = await compile(src, { fileName: "probe.ts" });
  expect(r.success).toBe(true);
  const io: any = r.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports);
  return { exp: wrapExports(instance.exports, { signatures: r.exportSignatures }), wat: r.wat as string };
}

describe("#2674 — deferred-fill member-get dispatcher", () => {
  it("an any-typed field read round-trips through the dispatcher", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P() { this.field = 42; };
      var pp = P.prototype;
      pp.readField = function () { var self: any = this; return self.field; };
      export function probe() { var p = new P(); return p.readField(); }
    `);
    expect(exp.probe()).toBe(42);
  });

  it("a __get_member_<name> dispatcher is emitted for an any-receiver read", async () => {
    const { wat } = await run(`
      // @ts-nocheck
      var P = function P() { this.q = 1; };
      var pp = P.prototype;
      pp.rd = function () { var o: any = this; return o.q; };
      export function probe() { var p = new P(); return p.rd(); }
    `);
    expect(/__get_member_q\b/.test(wat)).toBe(true);
  });

  it("a dynamic (sidecar-only) read still resolves via the dispatcher's __extern_get terminal", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      export function probe() {
        var o: any = {};
        o.dyn = 9;
        var r: any = o;
        return r.dyn;
      }
    `);
    expect(exp.probe()).toBe(9);
  });
});
