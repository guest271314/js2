import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2988 — Eliminate the `env::__get_globalThis` leak on the reflective
 * `globalThis.prop` member-READ path in standalone / WASI mode.
 *
 * #2996 reified bare `globalThis` (the identifier value) as a native `$Object`
 * singleton but deliberately left the `globalThis.prop` reflective read on the
 * host-import path (`__extern_get(__get_globalThis(), key)`), which leaked
 * `env::__get_globalThis` under a no-JS-host target. #2988 routes that receiver
 * to the SAME native singleton — the one `Object.defineProperty(globalThis, k,
 * desc)` and `globalThis.x = v` already write onto (both were host-free) — so
 * reflective reads round-trip host-free. `__extern_get` itself is already a
 * DEFINED native helper in these modes (via `ensureObjectRuntime`), so the whole
 * read is host-free. Host/gc mode keeps the `__get_globalThis` host import and is
 * byte-identical.
 */

/** Parse the WASM import section and return the `env::` import names. */
function envImports(bin: Uint8Array): string[] {
  let o = 8;
  const out: string[] = [];
  const u32 = () => {
    let r = 0,
      s = 0,
      b: number;
    do {
      b = bin[o++];
      r |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  const str = () => {
    const n = u32();
    const t = new TextDecoder().decode(bin.subarray(o, o + n));
    o += n;
    return t;
  };
  while (o < bin.length) {
    const id = bin[o++];
    const sz = u32();
    const end = o + sz;
    if (id === 2) {
      const cnt = u32();
      for (let i = 0; i < cnt; i++) {
        const m = str();
        const nm = str();
        const kind = bin[o++];
        if (m === "env") out.push(nm);
        if (kind === 0) u32();
        else if (kind === 1 || kind === 2) {
          o++;
          const f = bin[o++];
          u32();
          if (f) u32();
        } else if (kind === 3) {
          o += 2;
        }
      }
    }
    o = end;
  }
  return out;
}

const SA = { fileName: "t.ts", target: "standalone", nativeStrings: true, skipSemanticDiagnostics: true } as const;
const GC = { fileName: "t.ts", skipSemanticDiagnostics: true } as const;

describe("#2988 standalone globalThis.prop reflective read", () => {
  it("standalone: define-then-bare-read round-trips host-free", async () => {
    const src = `
declare global { var gx: number; }
export function test(): number {
  Object.defineProperty(globalThis, "gx", { value: 42, writable: true, configurable: true });
  return globalThis.gx;
}`;
    const r = await compile(src, SA);
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(envImports(r.binary)).not.toContain("__get_globalThis");
    expect(envImports(r.binary)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("standalone: bare-write-then-bare-read round-trips host-free", async () => {
    const src = `
declare global { var gy: number; }
export function test(): number {
  globalThis.gy = 5;
  return globalThis.gy;
}`;
    const r = await compile(src, SA);
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(envImports(r.binary)).not.toContain("__get_globalThis");
    expect(envImports(r.binary)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(5);
  });

  it("standalone: bare read and (as any) read hit the SAME singleton", async () => {
    // Define via `globalThis`, read via the `(as any)` any-receiver path, and via
    // the bare `globalThis.prop` path — both must observe the same value, proving
    // both routes resolve to the one native singleton.
    const src = `
declare global { var gz: number; }
export function test(): number {
  Object.defineProperty(globalThis, "gz", { value: 7, configurable: true });
  const viaAny = (globalThis as any).gz as number;
  const viaBare = globalThis.gz;
  return viaAny === viaBare && viaBare === 7 ? 1 : 0;
}`;
    const r = await compile(src, SA);
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(envImports(r.binary)).not.toContain("__get_globalThis");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("host/gc mode is unchanged — still emits __get_globalThis on globalThis.prop", async () => {
    const src = `
declare global { var gx: number; }
export function test(): number {
  return globalThis.gx;
}`;
    const r = await compile(src, GC);
    expect(r.success).toBe(true);
    expect(envImports(r.binary)).toContain("__get_globalThis");
  });
});
