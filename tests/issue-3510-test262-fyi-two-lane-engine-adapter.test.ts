import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Test262FyiEngineAdapter } from "../scripts/test262-fyi-engine-adapter.mjs";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function externalTest262Root(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "js2-test262-fyi-engine-"));
  scratchRoots.push(root);
  const directory = path.join(root, "test", "language", "module-code");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "value_FIXTURE.js"), "export const value = 42;\n");
  return root;
}

describe("#3510 test262.fyi two-lane engine adapter", () => {
  it.each(["gc", "standalone"] as const)(
    "returns a direct %s verdict using FYI's external fixture tree",
    async (target) => {
      const test262Root = externalTest262Root();
      const adapter = new Test262FyiEngineAdapter({ target, test262Root });
      try {
        const result = await adapter.run({
          file: "language/module-code/entry.js",
          contents: `
          import { value } from "./value_FIXTURE.js";
          if (value !== 42) throw new Error("fixture graph was not evaluated");
        `,
          flags: { module: true },
          negative: undefined,
          strictRerun: false,
        });

        expect(result).toMatchObject({ pass: true, phase: "runtime", reachedTest: true });
      } finally {
        adapter.shutdown();
      }
    },
  );

  it("rejects ambiguous targets instead of silently publishing a third mode", () => {
    expect(() => new Test262FyiEngineAdapter({ target: "wasi", test262Root: externalTest262Root() })).toThrow(
      "target must be gc or standalone",
    );
  });
});
