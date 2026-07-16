// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { addedLineNumbers, evaluatePushRawChange, scanPushRaw } from "../scripts/check-pushraw.mjs";

describe("#2953 pushRaw escape-hatch ratchet", () => {
  it("recognizes same-line and preceding-line issue tags", () => {
    const scan = scanPushRaw(`
emitter.pushRaw(out, legacy);
// pushraw-ok(#3296): Porffor legality rejects this family
emitter.pushRaw(out, nextLine);
emitter.pushRaw(out, sameLine); // pushraw-ok(#2952)
// pushraw-ok(#0): invalid issue number
emitter.pushRaw(out, invalidTag);
`);

    expect(scan).toMatchObject({ total: 4, tagged: 2, untagged: 2 });
    expect(scan.sites.map((site) => site.issue)).toEqual([undefined, 3296, 2952, undefined]);
  });

  it("rejects an untagged added site even when another site is removed", () => {
    const base = `
emitter.pushRaw(out, oldA);
emitter.pushRaw(out, oldB);
`;
    const current = `
emitter.pushRaw(out, oldA);
emitter.pushRaw(out, replacement);
`;

    const result = evaluatePushRawChange(base, current, new Set([3]));

    expect(result.growth).toBe(0);
    expect(result.untaggedAdded.map((site) => site.line)).toEqual([3]);
    expect(result.ok).toBe(false);
  });

  it("allows reviewed tagged growth", () => {
    const base = "emitter.pushRaw(out, oldSite);\n";
    const current = `${base}// pushraw-ok(#3296): backend-specific bridge\nemitter.pushRaw(out, newSite);\n`;

    const result = evaluatePushRawChange(base, current, new Set([2, 3]));

    expect(result.growth).toBe(1);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ line: 3, issue: 3296, tagged: true });
    expect(result.ok).toBe(true);
  });

  it("maps zero-context diff hunks to new-side line numbers", () => {
    const diff = `
@@ -4,0 +5,2 @@
+// pushraw-ok(#3296): temporary bridge
+emitter.pushRaw(out, op);
@@ -20 +22 @@
-old();
+replacement();
`;

    expect([...addedLineNumbers(diff)]).toEqual([5, 6, 22]);
  });
});
