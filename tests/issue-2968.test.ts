import { test, expect, describe } from "vitest";
import { compile } from "../src/index.ts";
import { WASI } from "node:wasi";
import { openSync, readFileSync, closeSync, mkdirSync, existsSync, rmSync } from "node:fs";

// #2968 — WASI `_start` uncaught-exception printer.
//
// When an uncaught exception reaches `_start` in a `--target wasi` binary, the
// `_start` wrapper renders it to stderr (fd 2) via the #2962 native
// `__error_to_string` / `__any_to_string` path and `proc_exit(1)`s, instead of
// the pre-fix silent exit 0. Validated under a real WASI runtime (`node:wasi`,
// which — like the V8/Node #2962 harness — supports the compiler's exception
// encoding). Modern wasmtime rejects the compiler's legacy exception-handling
// opcodes for EVERY try/catch program (a separate, pre-existing, compiler-wide
// gap), so these end-to-end runs use `node:wasi`.

const WORK_DIR = "/tmp/wasi-test-2968";

/** Compile `src` for wasi, run `_start` under node:wasi, return {code, stderr}. */
async function runWasi(src: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success).toBe(true);

  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  const outPath = `${WORK_DIR}/out-${Math.random().toString(36).slice(2)}.txt`;
  const errPath = `${WORK_DIR}/err-${Math.random().toString(36).slice(2)}.txt`;
  const outFd = openSync(outPath, "w+");
  const errFd = openSync(errPath, "w+");
  try {
    const wasi = new WASI({
      version: "preview1",
      args: ["prog"],
      returnOnExit: true,
      stdout: outFd,
      stderr: errFd,
    });
    const mod = await WebAssembly.compile(r.binary);
    const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
    const code = wasi.start(instance);
    return {
      code: typeof code === "number" ? code : 0,
      stdout: readFileSync(outPath, "utf-8"),
      stderr: readFileSync(errPath, "utf-8"),
    };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
    try {
      rmSync(outPath);
      rmSync(errPath);
    } catch {
      /* ignore */
    }
  }
}

describe("#2968 — WASI _start uncaught-exception printer", () => {
  test("bare top-level `throw new TypeError` renders to stderr and exits nonzero", async () => {
    const { code, stderr } = await runWasi(`throw new TypeError("x");`);
    expect(stderr).toContain("TypeError: x");
    expect(code).not.toBe(0);
  });

  test("uncaught Error / RangeError render their name + message", async () => {
    {
      const { code, stderr } = await runWasi(`throw new Error("boom");`);
      expect(stderr).toContain("Error: boom");
      expect(code).not.toBe(0);
    }
    {
      const { code, stderr } = await runWasi(`throw new RangeError("out");`);
      expect(stderr).toContain("RangeError: out");
      expect(code).not.toBe(0);
    }
  });

  test("side effects before the throw still run, then the exception surfaces", async () => {
    const { code, stdout, stderr } = await runWasi(`console.log("before"); throw new TypeError("late");`);
    expect(stdout).toContain("before");
    expect(stderr).toContain("TypeError: late");
    expect(code).not.toBe(0);
  });

  test("throw from a function reached via top-level call surfaces at _start", async () => {
    const { code, stderr } = await runWasi(`function main(): void { throw new Error("in main"); } main();`);
    expect(stderr).toContain("Error: in main");
    expect(code).not.toBe(0);
  });

  test("throw null exits nonzero without trapping (null payload has no render)", async () => {
    const { code } = await runWasi(`throw null;`);
    expect(code).not.toBe(0);
  });

  test("a throwing wasi module gains the exception-tag + proc_exit + fd_write it needs", async () => {
    const r = await compile(`throw new TypeError("x");`, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    const mod = new WebAssembly.Module(r.binary);
    const importNames = WebAssembly.Module.imports(mod).map((i) => i.name);
    expect(importNames).toContain("fd_write");
    expect(importNames).toContain("proc_exit");
    const exportNames = WebAssembly.Module.exports(mod).map((e) => e.name);
    expect(exportNames).toContain("_start");
  });

  test("a NON-throwing wasi module is unaffected: no proc_exit import, still runs", async () => {
    const r = await compile(`console.log("hi");`, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    const mod = new WebAssembly.Module(r.binary);
    const importNames = WebAssembly.Module.imports(mod).map((i) => i.name);
    // The uncaught-exception printer is what pulls in proc_exit; a module with no
    // `throw` must not gain it (keeps non-throwing wasi output unchanged).
    expect(importNames).not.toContain("proc_exit");
    const { code, stdout } = await runWasi(`console.log("hi");`);
    expect(stdout).toContain("hi");
    expect(code).toBe(0);
  });
});
