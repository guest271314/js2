// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6794 — CLI defects found by running `src/cli.ts`:
//   - `-v` meant both --version and --verbose; the version check ran first, so
//     `js2wasm x.ts -v` printed the version and compiled nothing.
//   - a missing input file dumped Node's `node:fs` stack trace.
//   - error-severity diagnostics on a SUCCESSFUL compile were never printed.
//   - `--out=<dir>` was rejected although `--target=` etc. accept `=`.
//   - docs/cli.md had drifted from `--help` (missing flags, a `--nativeStrings`
//     flag that does not exist). The last block diffs the two.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = path.resolve("src/cli.ts");
const PKG_VERSION = (JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as { version: string }).version;
const workDir = mkdtempSync(path.join(tmpdir(), "issue-6794-cli-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync("npx", ["-y", "tsx", CLI, ...args], { cwd: workDir, encoding: "utf8", timeout: 120_000 });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function writeInput(name: string, source: string): string {
  const file = path.join(workDir, name);
  writeFileSync(file, source);
  return file;
}

describe("#6794 — -v is --verbose, -V is --version", () => {
  it("-V and --version print the package version", () => {
    for (const flag of ["-V", "--version"]) {
      const r = runCli([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(PKG_VERSION);
    }
  }, 120_000);

  it("`<input> -v` compiles and lists every dropped host import", () => {
    // `Proxy` and `WeakRef` have no Wasm-native lowering under --target wasi,
    // so each trips one host-import allowlist warning (#2520): collapsed into a
    // summary by default, listed individually under --verbose.
    const input = writeInput(
      "verbose.ts",
      `export function f(x: any): any { return [new Proxy(x, {}), new WeakRef(x)]; }`,
    );
    const outDir = mkdtempSync(path.join(workDir, "verbose-out-"));
    const r = runCli([input, "-v", "--target", "wasi", "--no-dts", "-q", "-o", outDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(PKG_VERSION + "\n");
    expect(existsSync(path.join(outDir, "verbose.wasm"))).toBe(true);
    expect((r.stderr.match(/Host import "env\./g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(r.stderr).not.toMatch(/Re-run with --verbose/);
  }, 120_000);

  it("a bare `-v` with no input points at -V", () => {
    const r = runCli(["-v"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no input file specified .*-V or --version/);
  }, 120_000);
});

describe("#6794 — usage errors and diagnostics", () => {
  it("a missing input prints one line and exits 1 (no stack trace)", () => {
    const r = runCli([path.join(workDir, "does-not-exist.ts")]);
    expect(r.status).toBe(1);
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Error: cannot read input file .*does-not-exist\.ts: no such file$/);
    expect(r.stderr).not.toMatch(/node:fs|readFileUtf8|\sat\s/);
  }, 120_000);

  it("prints error-severity diagnostics on a successful compile, exit 0", () => {
    // TS2678 ("Type '2' is not comparable to type '1'") is tolerated: codegen
    // does not depend on it, so the compile succeeds with it in result.errors.
    const input = writeInput(
      "tolerated.ts",
      `export function f(x: 1): number {\n  switch (x) { case 2: return 2; }\n  return 0;\n}\n`,
    );
    const outDir = mkdtempSync(path.join(workDir, "tolerated-out-"));
    const r = runCli([input, "-q", "--no-optimize", `--out=${outDir}`]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/tolerated\.ts:2:\d+ - error: Type '2' is not comparable to type '1'/);
    expect(r.stderr).toMatch(/note: 1 error-severity diagnostic\(s\) above did not block compilation/);
    // `--out=<dir>` was honoured.
    expect(existsSync(path.join(outDir, "tolerated.wasm"))).toBe(true);
  }, 120_000);
});

// ── help text vs docs ───────────────────────────────────────────────────────

/** Every flag on an option line of `--help` (lines indented exactly two spaces). */
function helpFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const line of help.split("\n")) {
    const m = /^ {2}(-\S.*)$/.exec(line);
    if (!m) continue;
    const column = m[1]!.split(/\s{2,}/)[0]!;
    for (const f of column.matchAll(/(?<![\w-])(--?[A-Za-z0-9][\w-]*)/g)) flags.add(f[1]!);
  }
  return flags;
}

function mentions(text: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

describe("#6794 — docs match `--help`", () => {
  const help = runCli(["--help"]);
  const flags = helpFlags(help.stdout);
  const cliDoc = readFileSync(path.resolve("docs/cli.md"), "utf8");
  const startDoc = readFileSync(path.resolve("docs/getting-started.md"), "utf8");
  const cliSource = readFileSync(CLI, "utf8");

  it("help lists the core flags", () => {
    expect(help.status).toBe(0);
    for (const f of ["-o", "--out", "--target", "-v", "--verbose", "-V", "--version", "-h", "--help"]) {
      expect(flags, f).toContain(f);
    }
  });

  it("every --help flag is documented in docs/cli.md", () => {
    const undocumented = [...flags].filter((f) => !mentions(cliDoc, f));
    expect(undocumented).toEqual([]);
  });

  it("every flag in a docs/cli.md heading exists in --help", () => {
    const stale: string[] = [];
    for (const line of cliDoc.split("\n")) {
      if (!line.startsWith("### ")) continue;
      for (const f of line.matchAll(/`(--?[A-Za-z0-9][\w-]*)/g)) if (!flags.has(f[1]!)) stale.push(f[1]!);
    }
    expect(stale).toEqual([]);
  });

  it("every flag in the getting-started flag table exists in --help", () => {
    const stale: string[] = [];
    for (const line of startDoc.split("\n")) {
      if (!line.startsWith("| `-")) continue;
      const cell = line.split("|")[1]!;
      for (const f of cell.matchAll(/(?<![\w-])(--?[A-Za-z0-9][\w-]*)/g)) if (!flags.has(f[1]!)) stale.push(f[1]!);
    }
    expect(stale).toEqual([]);
  });

  it("every --help flag is handled by the argument parser", () => {
    // Flags are matched as string literals in the parser; -O1..-O4 by a regex.
    const parser = cliSource.slice(cliSource.indexOf("for (let i = 0; i < args.length; i++)"));
    const unhandled = [...flags].filter(
      (f) => !/^-O[1-4]$/.test(f) && !parser.includes(`"${f}"`) && !cliSource.includes(`args.includes("${f}")`),
    );
    expect(unhandled).toEqual([]);
  });
});
