// #1913 — standalone RegExp string protocol: g/y [[LastIndex]] exec/test
// semantics, global String.prototype.match, full §22.2.6.14 split (limit,
// captures, empty-match rule), and §22.2.6.11 GetSubstitution in replace.
// Also pins the nativeRegexHelpers late-import-shift fix (stale `call`
// indices produced invalid Wasm when an import landed between two regex
// call sites).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error("compile failed: " + result.errors.map((e) => e.message).join("; "));
  }
  const envImports = result.imports.filter((i) => i.module === "env");
  expect(envImports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1913 g/y exec lastIndex semantics (§22.2.7.2)", () => {
  it("global exec starts at lastIndex and writes back match end / 0", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const re = /\\d+/g;
          const s = "a1 b22 c333";
          const m1 = re.exec(s); if (m1 === null || m1[0] !== "1") return 1;
          if (re.lastIndex !== 2) return 2;
          const m2 = re.exec(s); if (m2 === null || m2[0] !== "22") return 3;
          if (re.lastIndex !== 6) return 4;
          const m3 = re.exec(s); if (m3 === null || m3[0] !== "333") return 5;
          const m4 = re.exec(s); if (m4 !== null) return 6;
          if (re.lastIndex !== 0) return 7;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("sticky exec fails when lastIndex is not at a match and resets to 0", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const re = /\\d+/y;
          const s = "12ab34";
          const m1 = re.exec(s); if (m1 === null || m1[0] !== "12") return 1;
          if (re.lastIndex !== 2) return 2;
          const m2 = re.exec(s); if (m2 !== null) return 3;
          if (re.lastIndex !== 0) return 4;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("manual lastIndex writes feed the next global exec", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const re = /\\d/g;
          re.lastIndex = 4;
          const m = re.exec("0123456");
          if (m === null || m[0] !== "4") return 1;
          if (m.index !== 4) return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("test() with g advances lastIndex (§22.2.6.17 = RegExpExec)", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const re = /a/g;
          const s = "aa";
          if (!re.test(s)) return 1;
          if (re.lastIndex !== 1) return 2;
          if (!re.test(s)) return 3;
          if (re.test(s)) return 4;
          if (re.lastIndex !== 0) return 5;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});

describe("#1913 global String.prototype.match (§22.2.6.8)", () => {
  it("collects every match and returns null when none", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const m = "a1 b22 c333".match(/\\d+/g);
          if (m === null) return 1;
          if (m.length !== 3) return 2;
          if (m[0] !== "1" || m[1] !== "22" || m[2] !== "333") return 3;
          const none = "abc".match(/\\d/g);
          if (none !== null) return 4;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});

describe("#1913 split (§22.2.6.14)", () => {
  it("honors the limit argument", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const p = "a,b,c,d".split(/,/, 2);
          if (p.length !== 2) return 1;
          if (p[0] !== "a" || p[1] !== "b") return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("interleaves capture values after each split slice", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const p = "a1b2c".split(/(\\d)/);
          if (p.length !== 5) return 1;
          if (p[0] !== "a" || p[1] !== "1" || p[2] !== "b" || p[3] !== "2" || p[4] !== "c") return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("splits into characters on an empty-match separator", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const p = "abc".split(/(?:)/);
          if (p.length !== 3) return 1;
          if (p[0] !== "a" || p[1] !== "b" || p[2] !== "c") return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("handles the empty-subject special cases", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const a = "".split(/,/);
          if (a.length !== 1 || a[0] !== "") return 1;
          const b = "".split(/.?/);
          if (b.length !== 0) return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});

describe("#1913 replace GetSubstitution (§22.2.6.11)", () => {
  it("expands $n, $&, $`, $', $$ and leaves out-of-range $n literal", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          if ("john smith".replace(/(\\w+)\\s(\\w+)/, "$2 $1") !== "smith john") return 1;
          if ("abc".replace(/b/, "[$&]") !== "a[b]c") return 2;
          if ("abc".replace(/b/, "[$\`]") !== "a[a]c") return 3;
          if ("abc".replace(/b/, "[$']") !== "a[c]c") return 4;
          if ("abc".replace(/b/, "$$") !== "a$c") return 5;
          if ("abc".replace(/b/, "$9") !== "a$9c") return 6;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("accepts dynamic (non-literal) string replacements", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const r: string = "<" + "X" + ">";
          if ("a-b".replace(/-/, r) !== "a<X>b") return 1;
          if ("aXbXc".replace(/X/g, "_") !== "a_b_c") return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});

describe("#1913 nativeRegexHelpers late-import-shift regression pin", () => {
  it("keeps regex helper call indices valid when a late import lands between call sites", async () => {
    // The throw materializes a late `Test262Error`-style construct ONLY via
    // compiled user classes here (no host import), but the shape matches the
    // S15.5.4.10 wrapTest failure: regex call → import-adding statement →
    // regex call. Before the fix the second call site baked a stale-low
    // funcIdx and stack-balance emitted invalid ref.casts.
    expect(
      await runStandalone(`
        var __string = "343443444";
        function check1(): number {
          return __string.match(/34/g)!.length;
        }
        function check2(): number {
          const m = __string.match(/34/g);
          if (m === null) return -1;
          let ok = 0;
          for (let mi = 0; mi < m.length; mi++) {
            if (m[mi] === "34") ok++;
          }
          return ok;
        }
        function test(): number {
          if (check1() !== 3) return 1;
          if (check2() !== 3) return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});
