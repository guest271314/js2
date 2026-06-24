// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2632 Phase 3 — process.stdin Readable stream: the reactor-integration
 * substrate.
 *
 * Phase 2 (#1990) built the fd-readiness reactor + the internal stdin buffer and
 * exposed the `__wasiStdinReadByte()` primitive. Phase 3 adds the wiring a real
 * Node `Readable`/EventEmitter library needs to ride ON TOP of that buffer:
 *
 *   - `__wasiStdinSetReader(cb)` — register the stream's "pump" as a REACTOR-TICK
 *     HOOK. The run loop call_ref's it once per tick AFTER `__rl_stdin_drain`
 *     fills the internal buffer (so callbacks run as LOOP WORK, not synchronously
 *     inside `poll_oneoff` — matching Node's "data delivered as loop work").
 *   - `__wasiStdinEof()` — 1 once fd0 hit EOF AND the buffer is fully drained
 *     (the library emits `'end'` and makes `.read()` return all-remaining here).
 *   - `__wasiStdinAvailable()` — buffered+unread byte count (drives null-on-short
 *     `.read(size)`).
 *
 * These cases prove the substrate end-to-end through the runtime poll_oneoff /
 * fd_read polyfill (deterministic, no real OS poll) AND under real wasmtime with
 * piped stdin:
 *   1. the reader hook is invoked each tick by the reactor and pulls buffered
 *      bytes; EOF is observed correctly,
 *   2. a faithful `Readable` LIBRARY CLASS (byte chunks) — `.on('data')`,
 *      `.on('end')`, `.read(size)` null-on-short, `.pause()`/`.resume()`,
 *      flowing/paused — compiles to valid Wasm and runs over this substrate,
 *   3. a timer-only / non-stdin program stays byte-neutral (no reader-hook
 *      globals, no hook call).
 *
 * NOTE — the STRING-based faithful Readable (`String.fromCharCode` chunks, the
 * Node-default representation) is BLOCKED on a PRE-EXISTING native-string
 * index-shift compiler bug (#2637): a realistic class using `__str_concat` /
 * `__str_fromCharCode` in a method, compiled `--target wasi`, emits invalid Wasm
 * (`global.set expected (ref null <class>), found call of (ref null <string>)`).
 * Confirmed on origin/main with ZERO Phase-3 code (the identical `number[]`
 * library is valid). The `process.stdin` source-prelude library is therefore NOT
 * auto-injected yet — see the Phase 3 implementation notes in
 * `plan/issues/2632-wasi-async-runtime-event-loop.md`. This suite validates the
 * substrate + the byte-chunk library that IS expressible today.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
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
  tmpDir = mkdtempSync(join(tmpdir(), "issue-2632-p3-"));
});
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function compileWasi(src: string, name: string): Promise<Uint8Array> {
  const r = await compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
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

// ── The faithful Readable LIBRARY (byte-chunk variant — the string variant is
// blocked on #2637). Prepended to each program under test. `.on('data'/'end'/
// 'readable')`, `.read([size])` with null-on-short, `.pause()`/`.resume()`,
// flowing vs paused, EOF — all pure library TS over the Phase-2 buffer + the
// Phase-3 reactor-tick hook. This is the code a `process.stdin` source-prelude
// will inject once #2637 unblocks the string form.
const READABLE_LIB = `
declare function __wasiStdinReadByte(): number;
declare function __wasiStdinAvailable(): number;
declare function __wasiStdinEof(): boolean;
declare function __wasiStdinSetReader(cb: () => void): void;

class __Readable {
  private bytes: number[] = [];
  private buffered: number = 0;
  private dataCbs: ((b: number) => void)[] = [];
  private endCbs: (() => void)[] = [];
  private readableCbs: (() => void)[] = [];
  private flowing: boolean = false;
  private paused: boolean = false;
  private ended: boolean = false;
  private armed: boolean = false;

  private drainBytes(): void {
    let n = 0;
    let b = __wasiStdinReadByte();
    while (b >= 0) { this.bytes.push(b); n = n + 1; b = __wasiStdinReadByte(); }
    this.buffered = this.buffered + n;
  }

  private pump(): void {
    this.drainBytes();
    if (this.buffered > 0) {
      for (let i = 0; i < this.readableCbs.length; i = i + 1) { this.readableCbs[i](); }
    }
    if (this.flowing && !this.paused) {
      while (this.bytes.length > 0) {
        const x = this.bytes.shift()!;
        this.buffered = this.buffered - 1;
        for (let i = 0; i < this.dataCbs.length; i = i + 1) { this.dataCbs[i](x); }
      }
    }
    // 'end' only after fd EOF AND the stream's own buffer is fully delivered
    // (a paused stream withholds bytes in this.bytes, so EOF alone is not the
    // end of the readable side -- matches Node).
    if (__wasiStdinEof() && this.bytes.length === 0 && !this.ended) {
      this.ended = true;
      for (let i = 0; i < this.endCbs.length; i = i + 1) { this.endCbs[i](); }
    }
  }

  private arm(): void {
    if (this.armed) return;
    this.armed = true;
    __wasiStdinSetReader(() => { this.pump(); });
  }

  on(event: string, cb: any): __Readable {
    if (event === "data") { this.dataCbs.push(cb); this.flowing = true; this.arm(); }
    else if (event === "end") { this.endCbs.push(cb); this.arm(); }
    else if (event === "readable") { this.readableCbs.push(cb); this.arm(); }
    return this;
  }

  // read(size): -1 sentinel == null (byte-chunk variant returns one byte / sentinel).
  read(size?: number): number {
    const want = (size === undefined || size < 0) ? 1 : size;
    if (this.buffered < want) {
      if (__wasiStdinEof() && this.buffered > 0) {
        const x = this.bytes.shift()!;
        this.buffered = this.buffered - 1;
        return x;
      }
      return -1;
    }
    const x = this.bytes.shift()!;
    this.buffered = this.buffered - 1;
    return x;
  }

  pause(): __Readable { this.paused = true; return this; }
  resume(): __Readable {
    this.paused = false;
    this.flowing = true;
    this.arm();
    // flush any bytes withheld while paused immediately (the reactor may already
    // be at EOF and not call the hook again).
    this.pump();
    return this;
  }
}

let __stdinSingleton: __Readable | null = null;
function __stdin(): __Readable {
  if (__stdinSingleton === null) { __stdinSingleton = new __Readable(); }
  return __stdinSingleton;
}
`;

describe("#2632 Phase 3 — reactor-tick reader hook + EOF/available intrinsics", () => {
  // A hook-registered pump drains buffered bytes each tick and counts them; EOF
  // ends it. Proves the run loop invokes the reader hook as loop work and EOF is
  // observable.
  const hookProgram = `
    declare function __wasiStdinReadByte(): number;
    declare function __wasiStdinEof(): boolean;
    declare function __wasiStdinSetReader(cb: () => void): void;
    let total = 0;
    let ended = false;
    __wasiStdinSetReader(() => {
      let b = __wasiStdinReadByte();
      while (b >= 0) { total = total + 1; b = __wasiStdinReadByte(); }
      if (__wasiStdinEof() && !ended) { ended = true; console.log("end:" + total); }
    });
  `;

  it("the reader hook fires each tick and observes EOF (polyfill)", async () => {
    const bin = await compileWasi(hookProgram, "p3-hook");
    expect(await runPolyfill(bin, "Hi")).toEqual(["end:2"]);
    expect(await runPolyfill(bin, "")).toEqual(["end:0"]);
    expect(await runPolyfill(bin, "ABCDE")).toEqual(["end:5"]);
  });

  it("emits the reader-hook globals + hook call, and validates", async () => {
    const r = await compile(hookProgram, { target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    const wat = r.wat!;
    expect(wat).toContain("$__stdin_reader_hook");
    expect(wat).toContain("$__stdin_reader_cap");
    // The reactor + Phase-2 helpers are present (the hook rides on them).
    expect(wat).toContain("$__run_event_loop");
    expect(wat).toContain("$__rl_stdin_drain");
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });

  it("a timer-only program stays byte-neutral (no reader-hook globals)", async () => {
    const r = await compile(`setTimeout(() => {}, 5);`, { target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    expect(r.wat!).toContain("$__run_event_loop");
    // The Phase-3 hook globals must NOT appear for a non-stdin program.
    expect(r.wat!).not.toContain("$__stdin_reader_hook");
    expect(r.wat!).not.toContain("$__stdin_reader_cap");
    expect(r.wat!).not.toContain("$__rl_stdin_drain");
  });
});

describe("#2632 Phase 3 — faithful Readable LIBRARY over the reactor (byte chunks)", () => {
  // Flowing mode: `.on('data')` delivers each buffered byte; `.on('end')` fires
  // at EOF. Data callbacks run as loop work (hook is called by the run loop).
  const dataProgram =
    READABLE_LIB +
    `
    const s = __stdin();
    s.on("data", (b: number) => { console.log("d:" + b); });
    s.on("end", () => { console.log("end"); });
  `;

  it("flowing mode delivers 'data' per byte then 'end' (polyfill)", async () => {
    const bin = await compileWasi(dataProgram, "p3-data");
    expect(await runPolyfill(bin, "Hi")).toEqual(["d:72", "d:105", "end"]);
    expect(await runPolyfill(bin, "")).toEqual(["end"]);
  });

  // read(size) null(-1)-on-short, then bytes once enough buffered; remainder at EOF.
  const readProgram =
    READABLE_LIB +
    `
    const s = __stdin();
    s.on("readable", () => {
      // ask for 3 bytes; -1 (null) until >=3 buffered or EOF
      let x = s.read(3);
      while (x >= 0) { console.log("r:" + x); x = s.read(3); }
    });
    s.on("end", () => { console.log("eof"); });
  `;

  it("read(size) is null-on-short then yields bytes; EOF flushes remainder (polyfill)", async () => {
    const bin = await compileWasi(readProgram, "p3-read");
    // 5 bytes "ABCDE": with >=3 buffered, read(3) yields one byte per call until
    // <3 remain, then EOF flushes the rest, then "eof".
    const out = await runPolyfill(bin, "ABCDE");
    expect(out[out.length - 1]).toBe("eof");
    // All 5 bytes (65..69) are eventually read.
    const bytes = out.filter((l) => l.startsWith("r:")).map((l) => Number(l.slice(2)));
    expect(bytes.sort((a, b) => a - b)).toEqual([65, 66, 67, 68, 69]);
  });

  it("empty stdin → no data, just EOF (polyfill)", async () => {
    const bin = await compileWasi(readProgram, "p3-read-empty");
    expect(await runPolyfill(bin, "")).toEqual(["eof"]);
  });

  // pause()/resume() gate flowing-mode delivery: paused before data arrives, the
  // bytes buffer; resume() flushes them.
  const pauseProgram =
    READABLE_LIB +
    `
    const s = __stdin();
    let count = 0;
    s.on("data", (b: number) => { count = count + 1; console.log("d:" + b); });
    s.on("end", () => { console.log("end:" + count); });
    s.pause();
    // resume after a tick so the first drained bytes were withheld while paused.
    setTimeout(() => { s.resume(); }, 1);
  `;

  it("pause()/resume() gates flowing delivery (polyfill)", async () => {
    const bin = await compileWasi(pauseProgram, "p3-pause");
    const out = await runPolyfill(bin, "Hi");
    // All bytes are eventually delivered after resume; 'end' reports the count.
    expect(out).toContain("end:2");
    expect(out.filter((l) => l.startsWith("d:")).length).toBe(2);
  });
});

describe.skipIf(!wasmtimeBin)("#2632 Phase 3 — substrate end-to-end under real wasmtime", () => {
  const dataProgram =
    READABLE_LIB +
    `
    const s = __stdin();
    s.on("data", (b: number) => { console.log("d:" + b); });
    s.on("end", () => { console.log("end"); });
  `;

  it("Readable 'data'/'end' over piped stdin (wasmtime)", async () => {
    const bin = await compileWasi(dataProgram, "p3-wt-data");
    expect(runWasmtime(bin, "p3-wt-data", "Hi")).toEqual(["d:72", "d:105", "end"]);
    expect(runWasmtime(bin, "p3-wt-data", "")).toEqual(["end"]);
  });
});
