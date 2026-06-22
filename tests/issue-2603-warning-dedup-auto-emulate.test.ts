import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #2603 follow-ups to `--emulate node`:
//  1. identical Node/builtin "Cannot find name 'X'" warnings collapse to one line.
//  2. a `node:` import auto-enables Node API emulation (with a note + a disable flag).
// Driven through the real CLI (cli.ts) since both live in the arg/print layer.

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "js2-2603-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCli(file: string, src: string, extraArgs: string[] = []): string {
  const input = join(dir, file);
  writeFileSync(input, src);
  // spawnSync gives us stdout AND stderr on both success and failure (warnings
  // are on stderr, and the compile exits 0 — execFileSync would drop them).
  const r = spawnSync("npx", ["tsx", "src/cli.ts", input, "--target", "wasi", "-o", dir, ...extraArgs], {
    encoding: "utf8",
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

const procWarnLines = (out: string) => out.split("\n").filter((l) => l.includes("Cannot find name 'process'"));

describe("#2603 warning dedup + node:-import auto-emulate", () => {
  it("collapses repeated `process` warnings to a single line with a count", () => {
    const src = `process.stdout.write("a");\nprocess.stderr.write("b");\nprocess.stdout.write("c");\n`;
    const out = runCli("dedup.js", src);
    const lines = procWarnLines(out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/\(3\D*\)/); // "(3×)" — count of 3, char-agnostic
    expect(lines[0]).toContain("--emulate node");
  });

  it("auto-enables Node emulation on a `node:` import (note printed, no process warning)", () => {
    const src = `import { readFileSync } from "node:fs";\nvoid readFileSync;\nprocess.stdout.write("x");\n`;
    const out = runCli("auto.js", src);
    expect(out).toContain("auto-enabled Node API emulation");
    expect(procWarnLines(out).length).toBe(0);
  });

  it("--emulate none disables the node:-import auto-enable (process warns again)", () => {
    const src = `import { readFileSync } from "node:fs";\nvoid readFileSync;\nprocess.stdout.write("x");\n`;
    const out = runCli("noemu.js", src, ["--emulate", "none"]);
    expect(out).not.toContain("auto-enabled Node API emulation");
    expect(procWarnLines(out).length).toBeGreaterThanOrEqual(1);
  });
});
