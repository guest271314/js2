// #2831 — the member-WRITE value coercion `__set_member_<name>` / `__sset_<name>`
// emitted an UNGUARDED narrowing `ref.cast` on the inbound externref value. At a
// dynamic any-receiver write `this.x = []`, the `[]` is built as a wasm
// `$__vec_externref` then marshalled to a HOST externref via `__make_iterable`
// before the setter — so the host value is not the wasm vec struct and the
// unguarded cast trapped `illegal cast` (compiled acorn could not parse ANY
// function/arrow body, whose `parseFunctionBody` does `this.labels = []`).
//
// Fix (#2831): a reserved per-target-vec materializer
// `__vec_from_extern_<vecIdx>(externref) -> (ref null $vec)` —
// `buildVecFromExternref`, the read-consistent inverse of `__make_iterable` —
// converts the host externref (empty / non-empty / host-array / same-rep / null)
// into a FRESH vec of the EXACT target type on the SLOT (no sidecar ⇒ no #2664
// desync; no bare ref.cast ⇒ no trap). Routed at all three setter emitters via
// `coercionInstrs` (member-set-dispatch + inline) and `buildSetterStore`
// (`__sset_*`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<{ exp: any; wat: string }> {
  const result: any = await compile(src, { fileName: "probe.ts" });
  expect(result.success).toBe(true);
  const io: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, io);
  io.__setExports?.(instance.exports);
  return { exp: wrapExports(instance.exports, { signatures: result.exportSignatures }), wat: result.wat as string };
}

describe("#2831 — host-externref → wasm-vec materializer for dynamic vec-field writes", () => {
  it("empty `this.x = []` on a dynamic any-receiver does NOT trap and is not stale (length 0)", async () => {
    // The architect's minimal repro: `reset()` writes `[]` on a prototype-method
    // `this` (dynamic any-receiver). Pre-fix this trapped `illegal cast` in
    // `__set_member_labels`; the wasm-vec-only guard alternative SILENTLY DROPPED
    // the write (returned the stale length). Must read back 0.
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P(){ this.labels = [{k:1},{k:2}]; };
      P.prototype.reset = function(){ this.labels = []; };
      P.prototype.run = function(){ this.reset(); return this.labels.length; };
      export function probe(){ return new P().run(); }
    `);
    expect(exp.probe()).toBe(0);
  });

  it("`this.x = null` then a fresh `this.x = []` does NOT trap and the slot is usable (length 0)", async () => {
    // The materializer's null guard returns `ref.null $vec` (no `__extern_length`
    // on null). A null write must not corrupt the slot for a later vec write —
    // the subsequent `[]` materializes a fresh empty vec and reads back length 0.
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P(){ this.labels = [{k:1}]; };
      P.prototype.clear = function(){ this.labels = null; };
      P.prototype.reset = function(){ this.labels = []; };
      P.prototype.run = function(){ this.clear(); this.reset(); return this.labels.length; };
      export function probe(){ return new P().run(); }
    `);
    expect(exp.probe()).toBe(0);
  });

  it("same-rep restore (`this.x = oldVecReadBack`) preserves length (identity short-circuit)", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P(){ this.labels = [{k:1},{k:2},{k:3}]; };
      P.prototype.restore = function(){ var t = this.labels; this.labels = t; };
      P.prototype.run = function(){ this.restore(); return this.labels.length; };
      export function probe(){ return new P().run(); }
    `);
    expect(exp.probe()).toBe(3);
  });

  it("non-empty cross-rep numeric write materializes the exact vec (length + element readback)", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P(){ this.vals = [1]; };
      P.prototype.reset = function(){ this.vals = [10, 20, 30]; };
      P.prototype.run = function(){ this.reset(); return this.vals.length * 100 + this.vals[1]; };
      export function probe(){ return new P().run(); }
    `);
    expect(exp.probe()).toBe(320);
  });

  it("the vec-field write routes through `__vec_from_extern_*` (no unguarded value ref.cast)", async () => {
    const { wat } = await run(`
      // @ts-nocheck
      var P = function P(){ this.labels = [{k:1}]; };
      P.prototype.reset = function(){ this.labels = []; };
      P.prototype.run = function(){ this.reset(); return this.labels.length; };
      export function probe(){ return new P().run(); }
    `);
    // The reserved materializer helper must exist and be called from the setter.
    expect(wat).toContain("__vec_from_extern_");
  });

  it("the #2664 slot/sidecar terminate invariant still holds with the new value coercion", async () => {
    // A closure `this.type = v` write + a loop reading `this.type` MUST terminate
    // (the write hits the slot the read uses). Unchanged by #2831 — scalar field,
    // not a vec — but guard against the materializer pass perturbing it.
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P() { this.type = 0; };
      var pp = P.prototype;
      pp.finishToken = function(t) { this.type = t; };
      pp.run = function() {
        var guard = 0;
        while (this.type !== 99 && guard < 1000) { this.finishToken(99); guard = guard + 1; }
        return this.type;
      };
      export function probe() { return new P().run(); }
    `);
    expect(exp.probe()).toBe(99);
  });
});
