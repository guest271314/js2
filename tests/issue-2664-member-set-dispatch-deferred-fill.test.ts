// #2664 — the `any`-receiver member-WRITE dispatch (#2659) is now DEFERRED-FILLED
// at finalize via a shared `__set_member_<name>` dispatcher, so every write site
// enumerates the COMPLETE struct-candidate set regardless of which function
// compiled first.
//
// Root cause of the 8th acorn dogfood wall: the symmetric struct.set write
// dispatch was emitted INLINE at each write site, freezing its candidate set at
// the write's compile time. acorn's Parser fnctor gets TWO struct shapes — an
// anonymous `$__anon_5` and the constructor `$__fnctor_Parser`, registered
// LATER. finishToken's `this.type = type` (a lifted closure reading `this` from
// `__current_this`) compiled before `$__fnctor_Parser` existed, so its inline
// dispatch only `ref.test`ed the anon shape; the real instance (the fnctor type)
// failed it and the write leaked to the `__extern_set` sidecar while reads used
// the slot → `while (this.type !== eof)` never terminated.
//
// The fix routes the write through `__set_member_<name>(recv, val)`, reserved at
// the write site and FILLED at finalize (`fillMemberSetDispatch`) when the full
// struct-type table is known — so the dispatcher's `ref.test` chain covers EVERY
// mutable struct candidate that owns the field, in any compile order.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.ts" });
  expect(result.success).toBe(true);
  const io: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, io);
  io.__setExports?.(instance.exports);
  return { exp: wrapExports(instance.exports, { signatures: result.exportSignatures }), wat: result.wat as string };
}

describe("#2664 — deferred-fill member-set dispatcher", () => {
  it("a closure `this.field = v` write on a fnctor instance round-trips and terminates", async () => {
    // Mirrors acorn's finishToken/run shape: a prototype-method closure writes
    // `this.type` and the loop condition reads it. The write MUST hit the slot
    // the read uses, or the loop never terminates (the #2664 hang).
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
      export function probe() { var p = new P(); return p.run(); }
    `);
    expect(exp.probe()).toBe(99);
  });

  it("the member-WRITE compiles to a shared `__set_member_<name>` dispatcher (deferred fill)", async () => {
    // Structural guard: the write must route through the reserved dispatcher, not
    // an inline per-site `struct.set` chain (whose candidate set freezes early).
    const { wat } = await run(`
      // @ts-nocheck
      var P = function P() { this.type = 0; };
      var pp = P.prototype;
      pp.set = function(t) { this.type = t; };
      export function probe() { var p = new P(); p.set(7); return p.type; }
    `);
    expect(/__set_member_type/.test(wat)).toBe(true);
  });

  it("plain `=` write keeps strict-[[Set]] fallback; `+=`/`++` use the non-strict variant", async () => {
    // Two strictness variants must coexist (a plain `=` throws on a getter-only
    // accessor; a read-modify-write already read the prop). Both must round-trip.
    const { exp } = await run(`
      // @ts-nocheck
      var P = function P() { this.n = 0; };
      var pp = P.prototype;
      pp.go = function() {
        this.n = 5;        // plain = (strict dispatcher)
        this.n += 3;       // compound (non-strict dispatcher)
        this.n++;          // unary (non-strict dispatcher)
        return this.n;
      };
      export function probe() { var p = new P(); return p.go(); }
    `);
    expect(exp.probe()).toBe(9);
  });

  it("dynamic (sidecar-only) property still round-trips via the dispatcher fallback", async () => {
    const { exp } = await run(`
      // @ts-nocheck
      export function probe() {
        var o = {};
        o.dyn = 1;
        o.dyn += 4;
        return o.dyn;
      }
    `);
    expect(exp.probe()).toBe(5);
  });

  it("boxed-primitive-wrapper own-property write (immutable slot) falls through to the sidecar (no validator crash)", async () => {
    // #2657 regression guard preserved through the dispatcher: the immutable
    // WrapperString/Number/Boolean `value` slot must NOT be picked by a
    // struct.set arm; it falls to the sidecar.
    const { exp } = await run(`
      // @ts-nocheck
      export function probe() {
        var s = new String("abc");
        s.value = "X";
        return String(s.value);
      }
    `);
    expect(exp.probe()).toBe("X");
  });
});
