// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyObjectRuntimeMainComposition,
  authenticateObjectRuntimeMainComposition,
  invertObjectRuntimeMainComposition,
  objectRuntimeMainCompositionText,
  verifyObjectRuntimeMainComposition,
} from "./helpers/object-runtime-main-composition.js";
import {
  conversionSha,
  objectRuntimePath,
  readConversionSource,
  verifyConversionComposition,
} from "./helpers/conversion-source-composition.js";
import {
  verifyObjectRuntimeComposition,
  verifyPreWriteObjectRuntimeComposition,
} from "./helpers/object-get-key-composition.js";
import { invertObjectWriteSource } from "./helpers/native-object-write-donor.js";

const receipt = authenticateObjectRuntimeMainComposition();
const actual = readConversionSource(objectRuntimePath);
// Every historical mutant starts from the actual candidate's authenticated write inverse.
const current = invertObjectWriteSource(objectRuntimePath, actual);
describe("fixed main changes precede the unchanged conversion and getter/key inverses", () => {
  it("reconstructs the entire signed integration and reciprocally reproduces the actual merge", () => {
    verifyObjectRuntimeComposition(actual);
    const integration = verifyObjectRuntimeMainComposition(current);
    expect(conversionSha(integration)).toBe("2cc32a6af0e913340ac8a27c77befb6b345a61688893aa1cb3fc29d6161719b7");
    expect(integration).not.toBe(current);
    expect(applyObjectRuntimeMainComposition(integration, false)).toBe(current);
    expect(receipt.spans).toHaveLength(19);
    expect(receipt.integration.blob).toBe("77ddd2aabd035307a0be00928f927e158c721bc2");
  });

  it("retains every historical full-source validator and reproduces the exact main Git blob", () => {
    verifyObjectRuntimeMainComposition(current);
    const conversions = verifyConversionComposition();
    expect(conversions).toHaveLength(2);
    const original = verifyPreWriteObjectRuntimeComposition(current).original;
    expect(conversionSha(original)).toBe(receipt.base.sha256);
    const main = applyObjectRuntimeMainComposition(original, false);
    expect(conversionSha(main)).toBe("45b31c33b9524059163ddf8de9945848db3685437d72454a63e5107207fadd35");
    expect(receipt.main.blob).toBe("57375151acd765e8870c3c7f67bf7e25797fd970");
    expect(invertObjectRuntimeMainComposition(main)).toBe(original);
    // A real main-only source must not substitute for the integrated compiler.
    expect(() => verifyObjectRuntimeMainComposition(main)).toThrow("retained source mismatch");
    expect(() => verifyObjectRuntimeMainComposition(invertObjectRuntimeMainComposition(current))).toThrow(
      "span missing or duplicated",
    );
  });

  it.each(receipt.spans)("positive first: main span $ordinal rejects altered, removed and duplicated bytes", (span) => {
    verifyObjectRuntimeMainComposition(current);
    expect(current.split(span.after)).toHaveLength(2);
    const altered = span.after.replace(/\S/, (character) => (character === "~" ? "!" : "~"));
    expect(altered).not.toBe(span.after);
    for (const replacement of [altered, "", span.after + span.after]) {
      const changed = current.replace(span.after, replacement);
      expect(changed).not.toBe(current);
      expect(() => verifyObjectRuntimeMainComposition(changed)).toThrow("span missing or duplicated");
      expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("span missing or duplicated");
    }
  });

  it("positive first: reordered main spans cannot cross the historical boundary", () => {
    verifyObjectRuntimeMainComposition(current);
    const first = receipt.spans[0]!.after;
    const last = receipt.spans.at(-1)!.after;
    const token = "__main_composition_reorder__";
    expect(current).not.toContain(token);
    const changed = current.replace(first, token).replace(last, first).replace(token, last);
    expect(changed).not.toBe(current);
    expect(() => verifyObjectRuntimeMainComposition(changed)).toThrow("span order mismatch");
    expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("span order mismatch");
  });

  it("positive first: source outside all main spans remains visible to the old checks", () => {
    verifyObjectRuntimeMainComposition(current);
    verifyPreWriteObjectRuntimeComposition(current);
    const retained = 'name: "previousActive"';
    expect(current).toContain(retained);
    expect(receipt.spans.every((span) => !span.after.includes(retained))).toBe(true);
    const changed = current.replace(retained, 'name: "changedActive"');
    expect(changed).not.toBe(current);
    expect(() => verifyObjectRuntimeMainComposition(changed)).toThrow("retained source mismatch");
    expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("signed peer source mismatch");
  });

  it("positive first: changed receipt bytes cannot replace signed history", () => {
    expect(authenticateObjectRuntimeMainComposition().base.sha256).toBe(
      "692133e0345a24e3c45071ed031036b96dc3f6e7702dc358e2f99651820eed9e",
    );
    for (const text of [
      objectRuntimeMainCompositionText + "\n",
      objectRuntimeMainCompositionText.replace("35e040c0", "00000000"),
    ])
      expect(() => authenticateObjectRuntimeMainComposition(text)).toThrow("receipt digest mismatch");
  });
});
