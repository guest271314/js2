import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";

// #2589: under `--target wasi` (node-emulation) the checker should resolve the
// ambient `process` global js2wasm lowers, so the repeated TS2580
// "Cannot find name 'process'" warnings disappear — without the user installing
// @types/node. Type-level only; emitted wasm is unchanged (asserted via the CLI
// md5 comparison during development).

function messageOf(d: { messageText: string | { messageText: string } }): string {
  return typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
}
const processNotFound = (diags: readonly { code: number; messageText: string | { messageText: string } }[]) =>
  diags.some((d) => (d.code === 2580 || d.code === 2304) && /'process'/.test(messageOf(d)));

describe("#2589 ambient `process` typing under --target wasi", () => {
  it("resolves `process` under wasi (no TS2580 'Cannot find name process')", () => {
    const src = [
      `process.stdout.write("hi");`,
      `process.stderr.write("e");`,
      `process.stdin.read(new Uint8Array(4));`,
      `const a = process.argv;`,
      `const e = process.env.HOME;`,
      `process.exit(0);`,
    ].join("\n");
    const ast = analyzeSource(src, "input.ts", { wasi: true });
    expect(processNotFound(ast.diagnostics)).toBe(false);
  });

  it("still warns about `process` when NOT targeting wasi (no blanket change)", () => {
    const ast = analyzeSource(`process.stdout.write("hi");`, "input.ts", { wasi: false });
    expect(processNotFound(ast.diagnostics)).toBe(true);
  });

  it("does NOT suppress genuinely-undefined names under wasi", () => {
    const src = `process.stdout.write("x");\nnonexistentThing.foo();`;
    const ast = analyzeSource(src, "input.ts", { wasi: true });
    expect(processNotFound(ast.diagnostics)).toBe(false);
    expect(ast.diagnostics.some((d) => /nonexistentThing/.test(messageOf(d)))).toBe(true);
  });

  it("falls back (no injection) when the user declares `process` — no duplicate-identifier error", () => {
    const src = `declare const process: { stdout: { write(s: string): void } };\nprocess.stdout.write("x");`;
    const ast = analyzeSource(src, "input.ts", { wasi: true });
    const dup = ast.diagnostics.some((d) => d.code === 2300 || d.code === 2403 || d.code === 2451);
    expect(dup).toBe(false);
  });
});
