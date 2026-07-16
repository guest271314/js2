// #3256 — self-hosted native-string family (Tier-1): trim/trimStart/trimEnd,
// startsWith/endsWith, repeat, padStart/padEnd are compiled from TS source in
// src/stdlib/strings.ts through the compiler's own IR pipeline instead of
// hand-emitted Instr[]. These tests pin the converted helpers' behaviour on
// the pure-Wasm lanes (standalone + wasi) against JS semantics — the host
// lane never emits these helpers (proven byte-identical in the #3256
// containment probe), so the JS results asserted here ARE the host-lane
// results, making this an A/B equivalence check by construction.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// Every exported function returns 1 (all sub-checks pass) or a small failure
// code — the assertions run INSIDE the wasm so no string bridging is needed.
const SRC = `
export function trims(): number {
  let a: string = "  \\t hello \\u00a0\\u2028 ";
  if (a.trim() !== "hello") return 2;
  if (a.trimStart() !== "hello \\u00a0\\u2028 ") return 3;
  if (a.trimEnd() !== "  \\t hello") return 4;
  if ("".trim() !== "") return 5;
  if ("\\uFEFF\\u3000x\\u205F".trim() !== "x") return 6;
  if ("no-ws".trim() !== "no-ws") return 7;
  if ("   ".trim() !== "") return 8;
  if ("\\u2000\\u200a mid \\u202f\\u205f".trim() !== "mid") return 9;
  return 1;
}
export function affix(): number {
  let s: string = "The quick brown fox";
  let n: number = 0;
  if (s.startsWith("The")) n = n + 1;
  if (s.startsWith("quick", 4)) n = n + 2;
  if (!s.startsWith("quick", 5)) n = n + 4;
  if (s.startsWith("The", -3)) n = n + 8;
  if (!s.startsWith("fox", 100)) n = n + 16;
  if (s.startsWith("")) n = n + 32;
  if (s.endsWith("fox")) n = n + 64;
  if (s.endsWith("brown", 15)) n = n + 128;
  if (!s.endsWith("The", 2)) n = n + 256;
  if (s.endsWith("", 0)) n = n + 512;
  if (s.endsWith("", -5)) n = n + 1024;
  if (!s.endsWith("quick", 4)) n = n + 2048;
  if (s.startsWith("The quick brown fox")) n = n + 4096;
  if (!s.startsWith("The quick brown fox!")) n = n + 8192;
  return n;
}
export function repeats(): number {
  if ("ab".repeat(3) !== "ababab") return 2;
  if ("x".repeat(0) !== "") return 3;
  if ("".repeat(100) !== "") return 4;
  if ("abc".repeat(1) !== "abc") return 5;
  if ("\\u{1F600}".repeat(2) !== "\\u{1F600}\\u{1F600}") return 6;
  if ("ab".repeat(7).length !== 14) return 7;
  if ("abc".repeat(5) !== "abcabcabcabcabc") return 8;
  return 1;
}
export function pads(): number {
  if ("5".padStart(3, "0") !== "005") return 2;
  if ("5".padEnd(3, "0") !== "500") return 3;
  if ("abc".padStart(2, "x") !== "abc") return 4;
  if ("abc".padStart(3, "x") !== "abc") return 5;
  if ("ab".padStart(7, "012") !== "01201ab") return 6;
  if ("ab".padEnd(7, "012") !== "ab01201") return 7;
  if ("ab".padStart(5) !== "   ab") return 8;
  if ("ab".padEnd(5) !== "ab   ") return 9;
  if ("x".padStart(4, "") !== "x") return 10;
  if ("".padStart(3, "ab") !== "aba") return 11;
  if ("ab".padStart(8, "0123456789") !== "012345ab") return 12;
  return 1;
}
export function consInputs(): number {
  let sp: string = "  ";
  let core: string = "ab";
  let built: string = sp + core + sp;
  if (built.trim() !== "ab") return 2;
  if (!built.startsWith("  a")) return 3;
  if (!built.endsWith("b  ")) return 4;
  if ((core + core).repeat(2) !== "abababab") return 5;
  if ((core + sp).trimEnd() !== "ab") return 6;
  if ((sp + core).padStart(6, sp + core) !== "  " + sp + core) return 7;
  return 1;
}
export function bigRepeat(): number {
  let r: string = "xy".repeat(5000);
  if (r.length !== 10000) return 2;
  if (!r.startsWith("xyxy")) return 3;
  if (!r.endsWith("yxy")) return 4;
  if (r.trim() !== r) return 5;
  return 1;
}
`;

// JS oracle for the affix bitmask — must mirror the wasm source above.
function affixOracle(): number {
  const s = "The quick brown fox";
  let n = 0;
  if (s.startsWith("The")) n += 1;
  if (s.startsWith("quick", 4)) n += 2;
  if (!s.startsWith("quick", 5)) n += 4;
  if (s.startsWith("The", -3)) n += 8;
  if (!s.startsWith("fox", 100)) n += 16;
  if (s.startsWith("")) n += 32;
  if (s.endsWith("fox")) n += 64;
  if (s.endsWith("brown", 15)) n += 128;
  if (!s.endsWith("The", 2)) n += 256;
  if (s.endsWith("", 0)) n += 512;
  if (s.endsWith("", -5)) n += 1024;
  if (!s.endsWith("quick", 4)) n += 2048;
  if (s.startsWith("The quick brown fox")) n += 4096;
  if (!s.startsWith("The quick brown fox!")) n += 8192;
  return n;
}

type Exports = Record<string, () => number>;

async function compileLane(target: "standalone" | "wasi"): Promise<Exports> {
  const r = await compile(SRC, { fileName: `issue-3256-${target}.ts`, target });
  if (!r.success) throw new Error(`${target} compile failed: ${r.errors[0]?.message}`);
  if (target === "standalone") {
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return instance.exports as Exports;
  }
  // wasi: stub every import (the string helpers themselves are pure Wasm).
  const mod = await WebAssembly.compile(r.binary);
  const imports: Record<string, Record<string, unknown>> = {};
  for (const im of WebAssembly.Module.imports(mod)) {
    imports[im.module] ??= {};
    imports[im.module]![im.name] = () => 0;
  }
  const instance = await WebAssembly.instantiate(mod, imports as WebAssembly.Imports);
  return instance.exports as unknown as Exports;
}

for (const lane of ["standalone", "wasi"] as const) {
  describe(`#3256 self-hosted string family — ${lane}`, () => {
    it("trim / trimStart / trimEnd (incl. unicode whitespace + all-ws + empty)", async () => {
      const ex = await compileLane(lane);
      expect(ex.trims!()).toBe(1);
    });
    it("startsWith / endsWith (position clamps per #2875, empty needles)", async () => {
      const ex = await compileLane(lane);
      expect(ex.affix!()).toBe(affixOracle());
    });
    it("repeat (zero/one/many, empty receiver, surrogate pairs)", async () => {
      const ex = await compileLane(lane);
      expect(ex.repeats!()).toBe(1);
    });
    it("padStart / padEnd (multi-char pad, remainder, default space, empty pad)", async () => {
      const ex = await compileLane(lane);
      expect(ex.pads!()).toBe(1);
    });
    it("cons-string (rope) inputs flatten once and behave identically", async () => {
      const ex = await compileLane(lane);
      expect(ex.consInputs!()).toBe(1);
    });
    it("large repeat stays linear and correct (doubling strategy)", async () => {
      const ex = await compileLane(lane);
      expect(ex.bigRepeat!()).toBe(1);
    });
  });
}
