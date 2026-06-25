// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2683 — 5-way Native Messaging comparison harness.
 *
 * `examples/native-messaging/` carries the SAME Native Messaging echo host (read
 * a 4-byte little-endian length prefix + body off fd 0, write the framed response
 * to fd 1) implemented against several host surfaces, so they can be compared:
 *
 *   - `nm_wasi.ts`         RAW `wasi_snapshot_preview1` fd_read/fd_write + linear
 *                          memory (`wasm:memory`)                              (#2657)
 *   - `nm_js2wasm.ts`      synchronous `node:fs` readSync/writeSync(fd, …)     (#2655)
 *   - `nm_node_process.ts` async `process.stdin` Readable + process.stdout.write (#2683/#2632)
 *   - `nm_deno.ts`         the Deno stdio surface (lands separately)
 *   - `nm_wasi_p3.ts`      the WASI Preview 3 spike (lands separately)
 *
 * Despite the different host APIs, every variant speaks the IDENTICAL wire
 * protocol, so a single framed request must come back BYTE-IDENTICAL from each.
 * This harness pins exactly that:
 *
 *   1. Every discovered `nm_*.ts` variant compiles + validates under `--target wasi`.
 *   2. Every variant that lowers to a standalone WASI command module (imports a
 *      subset of `wasi_snapshot_preview1` / `env`) echoes a shared frame
 *      BYTE-IDENTICALLY. Synchronous variants run in-process under a raw fd shim
 *      (CI-safe, no external runtime); reactor-driven async variants (e.g.
 *      `nm_node_process.ts`, whose `process.stdin` needs the event loop) run under
 *      real `wasmtime` when it is on PATH.
 *
 * It is written DEFENSIVELY so the later variants are picked up with no edits:
 * variant files are DISCOVERED on disk, a variant that does not lower to a
 * wasmtime-runnable command module (e.g. the P3 component spike, which needs its
 * own runner) is skipped gracefully, and the real-runtime path gates on
 * `findWasmtime()`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// wasmtime feature flags for the WasmGC + exception-handling binaries js2wasm
// emits (structs/arrays + the exception tag).
const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,exceptions=y"];

/** Resolve a usable `wasmtime` binary, or null when none is on PATH. */
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

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");

/** The host-surface variants present on disk (any `nm_<surface>.ts`), sorted. */
function discoverVariants(): string[] {
  return readdirSync(NM_DIR)
    .filter((f) => /^nm_.*\.ts$/.test(f))
    .sort();
}

/** The (module) name of every import in a compiled WAT. */
function importModules(wat: string): Set<string> {
  const mods = new Set<string>();
  for (const line of wat.split("\n")) {
    const m = line.match(/\(import\s+"([^"]+)"/);
    if (m) mods.add(m[1]!);
  }
  return mods;
}

// A variant lowers to a standalone WASI command module — runnable directly — iff
// it imports nothing beyond the WASI core module and `env`. A variant that needs
// another interface (e.g. a WASI Preview 3 component) is excluded and skipped.
const WASMTIME_RUNNABLE_MODULES = new Set(["wasi_snapshot_preview1", "env"]);
function isStandaloneWasi(imports: Set<string>): boolean {
  for (const m of imports) if (!WASMTIME_RUNNABLE_MODULES.has(m)) return false;
  return true;
}

/** Frame a body as a 4-byte LE length prefix + the body bytes (Native Messaging). */
function frame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  const n = body.length;
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  out.set(body, 4);
  return out;
}

async function compileVariant(file: string): Promise<Awaited<ReturnType<typeof compile>>> {
  const src = readFileSync(join(NM_DIR, file), "utf-8");
  return compile(src, { fileName: file, target: "wasi", skipSemanticDiagnostics: true });
}

/**
 * Run a synchronous standalone-WASI module under an in-process fd shim: fd 0 is
 * fed `stdin`, fd 1 is captured as raw bytes, fd 2 (stderr diagnostics) is
 * dropped. Only valid for variants that do NOT need the event-loop reactor — a
 * one-shot `_start` call drives the whole synchronous read/echo loop.
 */
async function runFdShim(binary: Uint8Array, stdin: Uint8Array): Promise<Uint8Array> {
  let inPos = 0;
  const out: number[] = [];
  const ref: { mem?: WebAssembly.Memory } = {};
  const dv = (): DataView => new DataView(ref.mem!.buffer);
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const v = dv();
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdin.length - inPos);
        for (let j = 0; j < n; j++) mem[buf + j] = stdin[inPos + j]!;
        inPos += n;
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const v = dv();
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        // Only fd 1 is the protocol stream; fd 2 carries debug telemetry.
        if (fd === 1) for (let j = 0; j < len; j++) out.push(mem[buf + j]!);
        total += len;
      }
      v.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(): void {},
    random_get(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
  };
  const { instance } = await WebAssembly.instantiate(binary, {
    wasi_snapshot_preview1: wasi as unknown as WebAssembly.ModuleImports,
    env: {},
  });
  ref.mem = instance.exports.memory as WebAssembly.Memory;
  const start = (instance.exports._start ?? instance.exports.main) as () => void;
  start();
  return Uint8Array.from(out);
}

describe("#2683 Native Messaging comparison harness — every variant compiles", () => {
  const variants = discoverVariants();

  it("discovers the baseline variants on disk", () => {
    // The two landed variants plus this PR's node:process variant must be present;
    // later variants (nm_deno.ts, nm_wasi_p3.ts) are picked up automatically.
    expect(variants).toContain("nm_wasi.ts");
    expect(variants).toContain("nm_js2wasm.ts");
    expect(variants).toContain("nm_node_process.ts");
  });

  for (const file of variants) {
    it(`${file} compiles + validates under --target wasi`, async () => {
      const r = await compileVariant(file);
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      expect(WebAssembly.validate(r.binary!), `${file} binary must validate`).toBe(true);
    });
  }
});

describe("#2683 Native Messaging comparison harness — byte-identical framed echo", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nm-comparison-"));
  });
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function runWasmtime(binary: Uint8Array, name: string, input: Uint8Array): Uint8Array {
    const path = join(tmpDir, `${name}.wasm`);
    writeFileSync(path, binary);
    const out = execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, path], {
      input: Buffer.from(input),
      stdio: ["pipe", "pipe", "ignore"], // drop fd 2 diagnostics
      maxBuffer: 1 << 26,
    });
    return Uint8Array.from(out);
  }

  // A small, pure-ASCII JSON body — the canonical Native Messaging payload shape.
  // Every variant must echo the WHOLE frame (4-byte LE prefix + body) verbatim.
  const requestBody = new TextEncoder().encode('["hello",null,42]');
  const requestFrame = frame(requestBody);

  it("every standalone-WASI variant echoes the same frame byte-for-byte", async () => {
    const ran: { file: string; out: number[]; via: string }[] = [];
    const skipped: { file: string; why: string }[] = [];

    for (const file of discoverVariants()) {
      const r = await compileVariant(file);
      expect(r.success, r.success ? "" : `${file}: ${r.errors?.[0]?.message}`).toBe(true);

      const imports = importModules(r.wat!);
      if (!isStandaloneWasi(imports)) {
        // e.g. a WASI Preview 3 component variant — needs its own runner.
        skipped.push({ file, why: `non-standalone imports: ${[...imports].join(",")}` });
        continue;
      }

      const needsReactor = r.wat!.includes("$__run_event_loop");
      const name = file.replace(/\.ts$/, "");
      if (needsReactor) {
        // Async/event-driven (e.g. process.stdin): the read loop runs in the
        // event loop, which the in-process fd shim does not drive — needs a real
        // runtime. Run under wasmtime when available, otherwise skip gracefully.
        if (!wasmtimeBin) {
          skipped.push({ file, why: "reactor-driven; wasmtime not on PATH" });
          continue;
        }
        ran.push({ file, out: Array.from(runWasmtime(r.binary!, name, requestFrame)), via: "wasmtime" });
      } else if (wasmtimeBin) {
        ran.push({ file, out: Array.from(runWasmtime(r.binary!, name, requestFrame)), via: "wasmtime" });
      } else {
        ran.push({ file, out: Array.from(await runFdShim(r.binary!, requestFrame)), via: "fd-shim" });
      }
    }

    // At least the two synchronous baseline variants always run (they need no
    // external runtime), so the comparison is meaningful even without wasmtime.
    expect(ran.length, `too few runnable variants (skipped: ${JSON.stringify(skipped)})`).toBeGreaterThanOrEqual(2);

    // Every variant's stdout is a byte-identical echo of the request frame —
    // which transitively makes all variants byte-identical to one another.
    for (const { file, out, via } of ran) {
      expect(out, `${file} (via ${via}) did not echo the frame byte-identically`).toEqual(Array.from(requestFrame));
    }
  });
});
