import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
var nonAsciiStartChars = "\\u00aa\\u00b5\\u00ba\\u00c0-\\u00d6";
var nonAsciiStart = new RegExp("[" + nonAsciiStartChars + "]");
var nonAsciiPart = new RegExp("[" + nonAsciiStartChars + "\\u0300-\\u036f]");

function isIdentifierStart(code: number): boolean {
  return code >= 0xaa && nonAsciiStart.test(String.fromCharCode(code));
}

function isIdentifierChar(code: number): boolean {
  return code >= 0xaa && nonAsciiPart.test(String.fromCharCode(code));
}

function isRegExpIdentifierStart(code: number): boolean {
  return isIdentifierStart(code) || code === 0x24 || code === 0x5f;
}

function isRegExpIdentifierPart(code: number): boolean {
  return isIdentifierChar(code) || code === 0x24 || code === 0x5f;
}

export function run(): number {
  if (!isIdentifierStart(0xaa) || isIdentifierStart(0x41)) return 0;
  if (!isIdentifierChar(0x0301) || isIdentifierChar(0x41)) return 0;
  if (!isRegExpIdentifierStart(0x24)) return 0;
  if (!isRegExpIdentifierPart(0x5f)) return 0;
  return 1;
}
`;

describe("#3791 standalone native RegExp.test IR bridge", () => {
  it("loads the existing native carrier and emits the identifier helpers through IR", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-3791-ir-native-regexp-test.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining([
        "isIdentifierStart",
        "isIdentifierChar",
        "isRegExpIdentifierStart",
        "isRegExpIdentifierPart",
      ]),
    );

    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });

  it("keeps reassigned and stateful RegExp carriers on the legacy path", async () => {
    const result = await compile(
      `
      var reassigned = new RegExp("a");
      reassigned = new RegExp("b");
      var destructured = new RegExp("a");
      [destructured] = [new RegExp("c")];
      var stateful = new RegExp("a", "g");
      function reassignedTest(value: string): boolean {
        return reassigned.test(value);
      }
      function destructuredTest(value: string): boolean {
        return destructured.test(value);
      }
      function statefulTest(value: string): boolean {
        return stateful.test(value);
      }
      export function run() {
        return reassignedTest("b") && statefulTest("a") ? 1 : 0;
      }
      `,
      {
        fileName: "issue-3791-ir-native-regexp-test-fallbacks.ts",
        target: "standalone",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("reassignedTest");
    expect(result.irCompiledFuncs ?? []).not.toContain("destructuredTest");
    expect(result.irCompiledFuncs ?? []).not.toContain("statefulTest");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });

  it("projects only exact stable numeric-array globals at direct-call boundaries", async () => {
    const stable = await compile(
      `
      var stableSet = [3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181];

      function includesValue(value, set) {
        var position = 0;
        for (var index = 0; index < set.length; index += 2) {
          position += set[index];
          if (position > value) return false;
          position += set[index + 1];
          if (position >= value) return true;
        }
        return false;
      }
      function usesStable(value) {
        return includesValue(value, stableSet);
      }
      function groundAbi(value: any, set: number[]): boolean {
        return includesValue(value, set);
      }
      export function run() {
        return usesStable(5) && groundAbi(5, stableSet) ? 1 : 0;
      }
      `,
      {
        fileName: "issue-3791-static-numeric-array-call.ts",
        target: "standalone",
        trackIrOutcomes: true,
        allowJs: true,
        skipSemanticDiagnostics: true,
        optimize: 4,
      },
    );

    expect(stable.success, stable.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(stable.irPostClaimErrors ?? []).toEqual([]);
    expect(stable.irCompiledFuncs ?? []).toContain("usesStable");
    const { instance } = await WebAssembly.instantiate(stable.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);

    const fallback = await compile(
      `
      var reassignedSet = [1];
      reassignedSet = [2];
      var sourceSet = [13];
      var aliasedSet = sourceSet;
      function read(value, set) {
        return set[0] === value;
      }
      function usesReassigned(value) {
        return read(value, reassignedSet);
      }
      function usesAlias(value) {
        return read(value, aliasedSet);
      }
      export function run() {
        return usesReassigned(2) && usesAlias(13) ? 1 : 0;
      }
      `,
      {
        fileName: "issue-3791-static-numeric-array-fallbacks.mjs",
        target: "standalone",
        trackIrOutcomes: true,
        allowJs: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect(fallback.success, fallback.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(fallback.irCompiledFuncs ?? []).not.toContain("usesReassigned");
    expect(fallback.irCompiledFuncs ?? []).not.toContain("usesAlias");
  });
});
