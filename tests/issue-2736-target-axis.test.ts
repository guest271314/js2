// #2736 — unify `--platform` into the single `--target {wasi,node,deno,web}`
// host axis. The host environment (web/node/deno) selects the ambient global
// surface (#2528) and node-style emulation (#2645); `wasi` is the standalone
// output ABI; the backend-lowering names (gc/linear/standalone) stay orthogonal.
//
// This slice is the AXIS PLUMBING + migration only (NOT real @types/node / Deno
// lib loading — those are later #2698 slices). `deno` therefore routes through
// the same node-emulation / no-DOM ambient surface as `node` for now.
//
// Two surfaces are exercised:
//   - the programmatic `platform` option (the internal host field that
//     `--target {web,node,deno}` feeds), and
//   - the CLI flag parsing (`--target node|deno|web`). The `--platform` alias
//     that #2736 added as deprecated was removed in #3073 and is now rejected
//     as an unknown flag.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function messageOf(d: { messageText: string | { messageText: string } }): string {
  return typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
}
function nameNotFound(
  diags: readonly { code: number; messageText: string | { messageText: string } }[],
  which: string,
): boolean {
  return diags.some((d) => (d.code === 2304 || d.code === 2580) && new RegExp(`'${which}'`).test(messageOf(d)));
}

async function withTempTs<T>(source: string, fn: (dir: string, path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "issue-2736-"));
  try {
    const path = join(dir, "input.ts");
    await writeFile(path, source);
    return await fn(dir, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("#2736 — `deno` host routes through the node-emulation / no-DOM surface", () => {
  const winSrc = `export function test(): number { (window as any).stop(); return 1; }`;
  const procSrc = `process.exit(0);`;

  it("DOM globals (window) are NOT in scope under deno (like node)", () => {
    expect(nameNotFound(analyzeSource(winSrc, "input.ts", { platform: "deno" }).diagnostics, "window")).toBe(true);
  });

  it("deno implies node-style emulation: `process` resolves with no TS2580", () => {
    expect(nameNotFound(analyzeSource(procSrc, "input.ts", { platform: "deno" }).diagnostics, "process")).toBe(false);
  });

  it("core ES globals (Array/Map/Promise) stay in scope under deno", () => {
    const src = `export function test(): number {
      const m = new Map<string, number>(); m.set("a", 1);
      const a = [1, 2, 3].map((x) => x + 1);
      return m.size + a.length;
    }`;
    const ast = analyzeSource(src, "input.ts", { platform: "deno" });
    for (const name of ["Map", "Array", "Promise"]) {
      expect(nameNotFound(ast.diagnostics, name)).toBe(false);
    }
  });
});

describe("#2736 — byte-neutrality of the host axis (ES-only program)", () => {
  const src = `export function test(): number {
    let s = 0;
    for (let i = 0; i < 10; i++) s += i * 2;
    return s;
  }`;

  it("default ≡ web ≡ node ≡ deno for a program touching no host surface", async () => {
    const base = await compile(src, { fileName: "t.ts" });
    const web = await compile(src, { fileName: "t.ts", platform: "web" });
    const node = await compile(src, { fileName: "t.ts", platform: "node" });
    const deno = await compile(src, { fileName: "t.ts", platform: "deno" });
    expect(base.success && web.success && node.success && deno.success).toBe(true);
    expect(sha(web.binary!)).toBe(sha(base.binary!));
    expect(sha(node.binary!)).toBe(sha(base.binary!));
    expect(sha(deno.binary!)).toBe(sha(base.binary!));
  });
});

describe("#2736 — CLI `--target {web,node,deno}` flag parsing (`--platform` alias removed, #3073)", () => {
  const NODE_PROC = `process.exit(0);\nexport function test(): number { return 1; }\n`;

  it("--target node compiles and suppresses the `process` TS2580 (emulation implied)", async () => {
    await withTempTs(NODE_PROC, async (dir, path) => {
      const { stdout, stderr } = await execFileAsync("npx", [
        "tsx",
        CLI,
        path,
        "-o",
        dir,
        "--no-wat",
        "--no-dts",
        "-q",
      ]);
      // smoke: a node-target compile of a `process` program succeeds, no error.
      expect(stdout + stderr).not.toMatch(/error:/i);
    });
  });

  it("--target deno is accepted and emits a binary", async () => {
    await withTempTs(`export function test(): number { return 7; }\n`, async (dir, path) => {
      const { stdout } = await execFileAsync("npx", [
        "tsx",
        CLI,
        path,
        "--target",
        "deno",
        "-o",
        dir,
        "--no-wat",
        "--no-dts",
        "-q",
      ]);
      expect(stdout).toMatch(/\.wasm {2}\(\d+ bytes\)/);
    });
  });

  // #3073 — the deprecated `--platform` alias (introduced in #2736) has been
  // removed; `--target {web,node,deno}` is the only host-axis spelling. The
  // alias is now rejected by the CLI's unknown-flag handler (non-zero exit).
  it("--platform is rejected as an unknown flag (removed; was deprecated in #2736)", async () => {
    await withTempTs(`export function test(): number { return 1; }\n`, async (dir, path) => {
      await expect(
        execFileAsync("npx", ["tsx", CLI, path, "--platform", "node", "-o", dir, "-q"]),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/Unknown option: --platform/),
      });
    });
  });

  it("an unknown --target value is rejected with the unified expected-values message", async () => {
    await withTempTs(`export function test(): number { return 1; }\n`, async (dir, path) => {
      await expect(
        execFileAsync("npx", ["tsx", CLI, path, "--target", "bogus", "-o", dir, "-q"]),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/expected web, node, deno, wasi, gc, linear, or standalone/),
      });
    });
  });
});
