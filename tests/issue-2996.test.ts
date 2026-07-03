import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2996 — Eliminate the `env::__get_globalThis` read leak in standalone mode.
 *
 * A bare `globalThis` identifier read in standalone / WASI mode must resolve to
 * a native `$Object` singleton (via the host-free `__new_plain_object` runtime),
 * NOT the `env::__get_globalThis` host import — which a no-JS-host binary can't
 * satisfy and which merely leaks into the import section. Host/gc mode is
 * unchanged (keeps the host import). Reflective `globalThis.prop` READS are the
 * deferred #2988 MOP work and keep their existing path.
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

// Mirrors the test262 `$262 = { global: globalThis, … }` harness stub shape —
// `globalThis` compiled as an object-literal field value (never read back).
const SRC = `
let host: any = { global: globalThis };
export function test(): number {
  return host.global == null ? 0 : 1;
}
`;

describe("#2996 standalone globalThis read leak", () => {
  it("standalone: bare globalThis emits NO env import", async () => {
    const r = await compile(SRC, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    const env = envImports(r.binary);
    expect(env).not.toContain("__get_globalThis");
    // The stub uses only globalThis + a plain object → fully host-free.
    expect(env).toEqual([]);
  });

  it("standalone: globalThis value is a non-null native object", async () => {
    const r = await compile(SRC, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // host.global (the native globalThis singleton) must be a real object (== 1).
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("standalone: repeated globalThis reads stay host-free (cached singleton)", async () => {
    // Two reads of the native globalThis singleton — must remain fully host-free
    // (the cached `$__native_globalThis` global is populated lazily once).
    const src = `
export function test(): number {
  let a: any = globalThis;
  let b: any = globalThis;
  return (a == null || b == null) ? 0 : 1;
}
`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    expect(envImports(r.binary)).not.toContain("__get_globalThis");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("host/gc mode is unchanged — still emits __get_globalThis", async () => {
    const r = await compile(SRC, { fileName: "t.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    expect(envImports(r.binary)).toContain("__get_globalThis");
  });
});
