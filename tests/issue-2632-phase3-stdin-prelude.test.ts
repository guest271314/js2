// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2632 Phase 3 — `process.stdin` faithful Node `Readable` (string/Buffer chunks).
 *
 * Phase 3's substrate (the reactor-tick reader hook + the four stdin intrinsics)
 * is proven by `issue-2632-phase3-stdin-readable.test.ts` against a hand-written
 * byte-chunk `__Readable` library. THIS suite proves the user-facing deliverable:
 * a real program using the PUBLIC Node `process.stdin` API compiles under
 * `--target wasi` and runs end-to-end, because the compiler **auto-injects** the
 * faithful string-chunk Readable source-prelude (import-scoped) and rewrites
 * `process.stdin` to the `__js2wasm_stdin()` singleton (`src/process-stdin-prelude.ts`,
 * wired in `compileSourceSync`).
 *
 * Coverage:
 *   1. `process.stdin.on('data'|'end')` flowing mode — chunk + EOF.
 *   2. `process.stdin.on('readable')` + `.read(size)` paused mode — null-on-short,
 *      EOF flushes the remainder.
 *   3. `.pause()` / `.resume()` gating of flowing-mode delivery.
 *   4. The injection is BYTE-NEUTRAL for programs that never reference
 *      `process.stdin` (no prelude globals, source byte-identical).
 *   5. Real wasmtime over piped stdin (skipped when wasmtime is absent).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { injectProcessStdinPrelude } from "../src/process-stdin-prelude.js";
import { buildWasiPolyfill } from "../src/runtime.js";

const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,exceptions=y"];

function findWasmtime(): string | null {
  for (const cand of ["wasmtime", "/usr/local/bin/wasmtime"]) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}
const wasmtimeBin = findWasmtime();

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-2632-p3-prelude-"));
});
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function compileWasi(src: string, name: string): Promise<Uint8Array> {
  const r = await compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(WebAssembly.validate(r.binary!), "binary must validate").toBe(true);
  return r.binary!;
}

/** Drive a compiled WASI module through the polyfill with preloaded stdin. */
async function runPolyfill(binary: Uint8Array, stdin: string): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const wasi = buildWasiPolyfill();
    wasi.setStdin(stdin);
    const { instance } = await WebAssembly.instantiate(binary, {
      wasi_snapshot_preview1: wasi as unknown as WebAssembly.ModuleImports,
      env: wasi.envImports,
    });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
    (instance.exports._start as () => void)();
  } finally {
    console.log = origLog;
  }
  return lines;
}

function runWasmtime(binary: Uint8Array, name: string, stdin: string): string[] {
  const path = join(tmpDir, `${name}.wasm`);
  writeFileSync(path, binary);
  const out = execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, path], { input: stdin, encoding: "utf-8" });
  return out.split("\n").filter((l) => l.length > 0);
}

describe("#2632 Phase 3 — process.stdin prelude auto-injection (unit)", () => {
  it("rewrites process.stdin and prepends the prelude when referenced", () => {
    const r = injectProcessStdinPrelude(`process.stdin.on("data", (c: string) => {});`);
    expect(r.injected).toBe(true);
    expect(r.source).toContain("class __Js2wasmReadable");
    expect(r.source).toContain("__js2wasm_stdin()");
    expect(r.source).not.toContain("process.stdin");
  });

  it("is byte-identical (identity map) when process.stdin is not referenced", () => {
    for (const src of [
      `setTimeout(() => {}, 5);`,
      `process.stdout.write("x"); process.exit(0);`,
      `console.log(process.argv.length);`,
      // `process` and `stdin` only inside a string literal — must NOT rewrite.
      `const note = "process.stdin is documented here";`,
    ]) {
      const r = injectProcessStdinPrelude(src);
      expect(r.injected, src).toBe(false);
      expect(r.source, src).toBe(src);
      expect(r.positionMap.isIdentity, src).toBe(true);
    }
  });

  it("does not rewrite process.stdin when the user declares their own process", () => {
    const src = `const process = { stdin: { on() {} } }; process.stdin.on("data", () => {});`;
    const r = injectProcessStdinPrelude(src);
    expect(r.injected).toBe(false);
    expect(r.source).toBe(src);
  });
});

describe("#2632 Phase 3 — compiled process.stdin Readable (polyfill)", () => {
  it("emits a stdin prelude + reactor only for a process.stdin program (byte-scoped)", async () => {
    const stdinR = await compile(`process.stdin.on("data", (c: string) => { console.log(c); });`, {
      target: "wasi",
      skipSemanticDiagnostics: true,
    });
    expect(stdinR.success).toBe(true);
    expect(stdinR.wat!).toContain("$__stdin_reader_hook");
    expect(stdinR.wat!).toContain("$__run_event_loop");

    // A non-stdin WASI program must carry NONE of the Phase-3 stdin globals.
    const timerR = await compile(`setTimeout(() => {}, 5);`, { target: "wasi", skipSemanticDiagnostics: true });
    expect(timerR.success).toBe(true);
    expect(timerR.wat!).not.toContain("$__stdin_reader_hook");
    expect(timerR.wat!).not.toContain("$__rl_stdin_drain");
  });

  const dataProgram = `
    process.stdin.on("data", (chunk: string) => { console.log("d:" + chunk); });
    process.stdin.on("end", () => { console.log("end"); });
  `;

  it("flowing mode: 'data' delivers a chunk then 'end'", async () => {
    const bin = await compileWasi(dataProgram, "p3p-data");
    expect(await runPolyfill(bin, "Hi")).toEqual(["d:Hi", "end"]);
    expect(await runPolyfill(bin, "")).toEqual(["end"]);
  });

  // Paused-mode read(size): null-on-short, then the chunk, with the remainder
  // flushed at EOF. The consumer narrows the nullable result then hands it to a
  // function (the idiomatic shape).
  const readProgram = `
    const s = process.stdin;
    s.pause();
    function emit(chunk: string): void { console.log("r:" + chunk); }
    s.on("readable", () => {
      let x = s.read(3);
      while (x !== null) { emit(x); x = s.read(3); }
    });
    s.on("end", () => { console.log("eof"); });
  `;

  it("paused mode: read(size) is null-on-short, EOF flushes the remainder", async () => {
    const bin = await compileWasi(readProgram, "p3p-read");
    expect(await runPolyfill(bin, "ABCDE")).toEqual(["r:ABC", "r:DE", "eof"]);
    expect(await runPolyfill(bin, "ABCDEFG")).toEqual(["r:ABC", "r:DEF", "r:G", "eof"]);
    expect(await runPolyfill(bin, "")).toEqual(["eof"]);
  });

  const pauseProgram = `
    const s = process.stdin;
    let count = 0;
    s.on("data", (b: string) => { count = count + b.length; });
    s.on("end", () => { console.log("total:" + count); });
    s.pause();
    setTimeout(() => { s.resume(); }, 1);
  `;

  it("pause()/resume() gates flowing-mode delivery", async () => {
    const bin = await compileWasi(pauseProgram, "p3p-pause");
    expect(await runPolyfill(bin, "Hello")).toContain("total:5");
  });
});

describe.skipIf(!wasmtimeBin)("#2632 Phase 3 — process.stdin Readable end-to-end under real wasmtime", () => {
  const dataProgram = `
    process.stdin.on("data", (chunk: string) => { console.log("d:" + chunk); });
    process.stdin.on("end", () => { console.log("end"); });
  `;

  it("flowing 'data'/'end' over piped stdin", async () => {
    const bin = await compileWasi(dataProgram, "p3p-wt-data");
    expect(runWasmtime(bin, "p3p-wt-data", "Hi")).toEqual(["d:Hi", "end"]);
    expect(runWasmtime(bin, "p3p-wt-data", "")).toEqual(["end"]);
  });

  const readProgram = `
    const s = process.stdin;
    s.pause();
    function emit(chunk: string): void { console.log("r:" + chunk); }
    s.on("readable", () => {
      let x = s.read(3);
      while (x !== null) { emit(x); x = s.read(3); }
    });
    s.on("end", () => { console.log("eof"); });
  `;

  it("paused read(size) over piped stdin reads all bytes then ends", async () => {
    const bin = await compileWasi(readProgram, "p3p-wt-read");
    expect(runWasmtime(bin, "p3p-wt-read", "ABCDEFG")).toEqual(["r:ABC", "r:DEF", "r:G", "eof"]);
  });
});
