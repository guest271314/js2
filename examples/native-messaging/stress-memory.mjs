#!/usr/bin/env node
// Opt-in Native Messaging stress runner for wasmtime memory measurements.
//
// This is intentionally not wired into CI. The default payload is the 1 MiB
// Chrome Array shape, while --reported-64mib reproduces the reporter's larger
// Array(209715 * 64) body for local measurements.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ONE_MIB = 1024 * 1024;
const DEFAULT_ARRAY_ELEMENTS = 209715;
const REPORTED_ARRAY_ELEMENTS = DEFAULT_ARRAY_ELEMENTS * 64;
const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,tail-call=y,exceptions=y"];

function usage() {
  console.log(`Usage: node examples/native-messaging/stress-memory.mjs [options]

Builds examples/native-messaging/nm_js2wasm_node_fs.ts, runs it under wasmtime, streams
<=1 MiB Native Messaging request frames into stdin, drains framed stdout, and
samples the wasmtime child RSS.

Options:
  --array-elements N          Send JSON.stringify(Array(N)); default ${DEFAULT_ARRAY_ELEMENTS}
  --reported-64mib           Shortcut for --array-elements ${REPORTED_ARRAY_ELEMENTS}
  --bytes N                  Send N raw patterned bytes instead of a JSON array body
  --wasm PATH                Use an existing nm_js2wasm_node_fs.wasm instead of building
  --wasmtime PATH            Runtime binary; default "wasmtime"
  --sample-ms N              RSS sample interval; default 100
  --timeout-ms N             Kill wasmtime if it runs too long; default 180000
  --max-rss-delta-mb N       Kill wasmtime if sampled RSS exceeds first sample by N MiB;
                             default 256 for --reported-64mib, disabled otherwise
  --max-response-frame-bytes N
                             Chunk budget to enforce; default ${ONE_MIB}
  --max-request-frame-bytes N
                             Request chunk budget; default ${ONE_MIB}
  --allow-large-response-frame
                             Permit legacy single-frame wasm when it exceeds the chunk budget
  --keep                     Keep the temporary build directory
  --help                     Show this help
`);
}

function parsePositiveInteger(value, name) {
  if (value === undefined) throw new Error(`missing value for ${name}`);
  const cleaned = String(value).replaceAll("_", "");
  if (!/^[0-9]+$/.test(cleaned)) throw new Error(`${name} must be a non-negative integer`);
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is too large for this runner`);
  return n;
}

function parseArgs(argv) {
  const opts = {
    arrayElements: DEFAULT_ARRAY_ELEMENTS,
    bodyBytes: undefined,
    wasm: undefined,
    wasmtime: process.env.WASMTIME || "wasmtime",
    sampleMs: 100,
    timeoutMs: 180_000,
    maxRssDeltaMb: undefined,
    maxResponseFrameBytes: ONE_MIB,
    maxRequestFrameBytes: ONE_MIB,
    allowLargeResponseFrame: false,
    reported64mib: false,
    keep: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (name) => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      i++;
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--reported-64mib") {
      opts.arrayElements = REPORTED_ARRAY_ELEMENTS;
      opts.bodyBytes = undefined;
      opts.reported64mib = true;
    } else if (arg === "--allow-large-response-frame") {
      opts.allowLargeResponseFrame = true;
    } else if (arg === "--keep") {
      opts.keep = true;
    } else if (arg === "--array-elements" || arg.startsWith("--array-elements=")) {
      opts.arrayElements = parsePositiveInteger(readValue("--array-elements"), "--array-elements");
      opts.bodyBytes = undefined;
      opts.reported64mib = false;
    } else if (arg === "--bytes" || arg.startsWith("--bytes=")) {
      opts.bodyBytes = parsePositiveInteger(readValue("--bytes"), "--bytes");
      opts.arrayElements = undefined;
      opts.reported64mib = false;
    } else if (arg === "--wasm" || arg.startsWith("--wasm=")) {
      opts.wasm = resolve(readValue("--wasm"));
    } else if (arg === "--wasmtime" || arg.startsWith("--wasmtime=")) {
      opts.wasmtime = readValue("--wasmtime");
    } else if (arg === "--sample-ms" || arg.startsWith("--sample-ms=")) {
      opts.sampleMs = parsePositiveInteger(readValue("--sample-ms"), "--sample-ms");
    } else if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      opts.timeoutMs = parsePositiveInteger(readValue("--timeout-ms"), "--timeout-ms");
    } else if (arg === "--max-rss-delta-mb" || arg.startsWith("--max-rss-delta-mb=")) {
      opts.maxRssDeltaMb = parsePositiveInteger(readValue("--max-rss-delta-mb"), "--max-rss-delta-mb");
    } else if (arg === "--max-response-frame-bytes" || arg.startsWith("--max-response-frame-bytes=")) {
      opts.maxResponseFrameBytes = parsePositiveInteger(
        readValue("--max-response-frame-bytes"),
        "--max-response-frame-bytes",
      );
    } else if (arg === "--max-request-frame-bytes" || arg.startsWith("--max-request-frame-bytes=")) {
      opts.maxRequestFrameBytes = parsePositiveInteger(
        readValue("--max-request-frame-bytes"),
        "--max-request-frame-bytes",
      );
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (opts.sampleMs < 10) throw new Error("--sample-ms must be at least 10");
  if (opts.timeoutMs < 1000) throw new Error("--timeout-ms must be at least 1000");
  if (opts.maxRequestFrameBytes < 1) throw new Error("--max-request-frame-bytes must be at least 1");
  if (opts.maxRequestFrameBytes > ONE_MIB) throw new Error("--max-request-frame-bytes must be at most 1048576");
  if (opts.reported64mib && opts.maxRssDeltaMb === undefined) opts.maxRssDeltaMb = 256;
  return opts;
}

function arrayBodyBytes(elements) {
  return elements === 0 ? 2 : elements * 5 + 1;
}

function bodyBytesFor(opts) {
  const bytes = opts.bodyBytes ?? arrayBodyBytes(opts.arrayElements);
  if (bytes > 0xffffffff) throw new Error(`Native Messaging frame body is too large: ${bytes} bytes`);
  return bytes;
}

async function writeAll(stream, chunk) {
  if (chunk.length === 0) return;
  await new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function writeRawBody(writeBodyChunk, bytes) {
  const maxChunk = 64 * 1024;
  let written = 0;
  while (written < bytes) {
    const n = Math.min(maxChunk, bytes - written);
    const chunk = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) chunk[i] = (written + i) % 251;
    await writeBodyChunk(chunk);
    written += n;
  }
}

async function writeArrayBody(writeBodyChunk, elements) {
  if (elements === 0) {
    await writeBodyChunk(Buffer.from("[]"));
    return;
  }

  await writeBodyChunk(Buffer.from("["));
  let remaining = elements;
  let first = true;
  const group = 8192;
  while (remaining > 0) {
    const count = Math.min(group, remaining);
    const text = first ? `null${",null".repeat(count - 1)}` : ",null".repeat(count);
    await writeBodyChunk(Buffer.from(text));
    remaining -= count;
    first = false;
  }
  await writeBodyChunk(Buffer.from("]"));
}

async function writeNativeMessage(stream, opts, bytes) {
  if (bytes === 0) {
    await writeAll(stream, Buffer.alloc(4));
    stream.end();
    return;
  }

  let bodyRemaining = bytes;
  let frameRemaining = 0;
  const writeHeader = async (len) => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(len, 0);
    await writeAll(stream, header);
  };
  const writeBodyChunk = async (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (frameRemaining === 0) {
        if (bodyRemaining <= 0) throw new Error("attempted to write more body bytes than declared");
        frameRemaining = Math.min(opts.maxRequestFrameBytes, bodyRemaining);
        await writeHeader(frameRemaining);
      }

      const n = Math.min(frameRemaining, chunk.length - offset);
      await writeAll(stream, chunk.subarray(offset, offset + n));
      offset += n;
      frameRemaining -= n;
      bodyRemaining -= n;
    }
  };

  if (opts.bodyBytes !== undefined) {
    await writeRawBody(writeBodyChunk, bytes);
  } else {
    await writeArrayBody(writeBodyChunk, opts.arrayElements);
  }
  if (bodyRemaining !== 0) throw new Error(`body writer ended ${bodyRemaining} bytes early`);
  stream.end();
}

function createNullArrayScanner(stats) {
  let state = 0;
  let invalid = false;

  return {
    start() {
      state = 0;
      invalid = false;
    },
    push(chunk, offset, length) {
      const end = offset + length;
      for (let i = offset; i < end; i++) {
        const byte = chunk[i];
        if (invalid) continue;

        if (state === 0) {
          if (byte === 91) state = 1;
          else invalid = true;
        } else if (state === 1) {
          if (byte === 93) state = 7;
          else if (byte === 110) state = 2;
          else invalid = true;
        } else if (state === 2) {
          if (byte === 117) state = 3;
          else invalid = true;
        } else if (state === 3) {
          if (byte === 108) state = 4;
          else invalid = true;
        } else if (state === 4) {
          if (byte === 108) {
            stats.responseArrayElements++;
            state = 5;
          } else {
            invalid = true;
          }
        } else if (state === 5) {
          if (byte === 44) state = 1;
          else if (byte === 93) state = 7;
          else invalid = true;
        } else {
          invalid = true;
        }
      }
    },
    finish() {
      if (invalid || state !== 7) stats.invalidArrayFrames++;
    },
  };
}

function createFrameParser({ inspectArrayFrames = false } = {}) {
  const header = Buffer.alloc(4);
  let headerOffset = 0;
  let bodyRemaining = 0;
  const stats = {
    responseFrames: 0,
    responseBodyBytes: 0,
    maxResponseFrameBodyBytes: 0,
    responseArrayElements: 0,
    invalidArrayFrames: 0,
    stdoutBytes: 0,
  };
  const arrayScanner = inspectArrayFrames ? createNullArrayScanner(stats) : undefined;

  const startFrame = (len) => {
    stats.responseFrames++;
    stats.responseBodyBytes += len;
    stats.maxResponseFrameBodyBytes = Math.max(stats.maxResponseFrameBodyBytes, len);
    bodyRemaining = len;
    if (arrayScanner) arrayScanner.start();
    if (len === 0 && arrayScanner) arrayScanner.finish();
  };

  const consumeBody = (chunk, offset, length) => {
    if (arrayScanner) arrayScanner.push(chunk, offset, length);
    bodyRemaining -= length;
    if (bodyRemaining === 0 && arrayScanner) arrayScanner.finish();
  };

  return {
    stats,
    push(chunk) {
      stats.stdoutBytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        if (bodyRemaining > 0) {
          const n = Math.min(bodyRemaining, chunk.length - offset);
          consumeBody(chunk, offset, n);
          offset += n;
          continue;
        }

        const n = Math.min(4 - headerOffset, chunk.length - offset);
        chunk.copy(header, headerOffset, offset, offset + n);
        headerOffset += n;
        offset += n;

        if (headerOffset === 4) {
          const len = header.readUInt32LE(0);
          headerOffset = 0;
          startFrame(len);
        }
      }
    },
    finishErrors() {
      const errors = [];
      if (bodyRemaining !== 0)
        errors.push(`stdout ended ${bodyRemaining} bytes before the current frame body completed`);
      if (headerOffset !== 0) errors.push(`stdout ended with ${headerOffset} partial header bytes`);
      if (stats.invalidArrayFrames !== 0)
        errors.push(`${stats.invalidArrayFrames} response frames were not null-array JSON`);
      return errors;
    },
  };
}

function readChildRssKb(pid) {
  if (!pid) return {};

  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    const hwm = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    return {
      rssKb: rss ? Number(rss[1]) : undefined,
      hwmKb: hwm ? Number(hwm[1]) : undefined,
      source: "procfs",
    };
  } catch {
    // Non-Linux hosts fall through to ps sampling.
  }

  const ps = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.status !== 0) return {};
  const rssKb = Number(ps.stdout.trim());
  return Number.isFinite(rssKb) && rssKb > 0 ? { rssKb, source: "ps" } : {};
}

function formatMb(kb) {
  return kb === undefined ? "n/a" : (kb / 1024).toFixed(1);
}

function buildCompilerCli(repoRoot, outDir) {
  const cli = join(outDir, "js2wasm-cli.mjs");
  console.error("== Building temporary standalone js2wasm CLI ==");
  const result = spawnSync(process.execPath, ["scripts/build-standalone-cli.mjs", "--outfile", cli], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`standalone CLI build exited with status ${result.status}`);
  if (!existsSync(cli)) throw new Error(`${cli} was not produced`);
  return cli;
}

function buildWasm(repoRoot, outDir) {
  console.error("== Compiling examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi ==");
  const cli = buildCompilerCli(repoRoot, outDir);
  const result = spawnSync(
    process.execPath,
    [cli, "examples/native-messaging/nm_js2wasm_node_fs.ts", "--target", "wasi", "-o", outDir, "--quiet"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`compiler exited with status ${result.status}`);
  const wasm = join(outDir, "nm_js2wasm_node_fs.wasm");
  if (!existsSync(wasm)) throw new Error(`${wasm} was not produced`);
  return wasm;
}

function readWasmtimeVersion(wasmtime) {
  const result = spawnSync(wasmtime, ["--version"], { encoding: "utf8" });
  if (result.error) throw new Error(`wasmtime runtime is not available (${wasmtime}): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${wasmtime} --version exited with status ${result.status}`);
  return (result.stdout || result.stderr).trim();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..", "..");
  const tmp = mkdtempSync(join(tmpdir(), "js2wasm-native-messaging-stress-"));
  const bodyBytes = bodyBytesFor(opts);
  const mode = opts.bodyBytes !== undefined ? "raw-bytes" : "chrome-array";
  const started = performance.now();

  let wasm = opts.wasm;
  try {
    const wasmtimeVersion = readWasmtimeVersion(opts.wasmtime);
    if (!wasm) wasm = buildWasm(repoRoot, tmp);
    if (!existsSync(wasm)) throw new Error(`wasm file does not exist: ${wasm}`);

    console.error(`== Running under ${wasmtimeVersion} ==`);
    const child = spawn(opts.wasmtime, [...WASMTIME_FLAGS, wasm], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parser = createFrameParser({ inspectArrayFrames: opts.arrayElements !== undefined && !opts.reported64mib });
    let stderrBytes = 0;
    let stderrPreview = "";
    let spawnError;
    let writeError;
    let firstRssKb;
    let peakSampledRssKb = 0;
    let peakHwmKb;
    let rssSource = "n/a";
    let rssSamples = 0;
    const guardErrors = [];
    let guardTerminated = false;

    child.once("error", (err) => {
      spawnError = err;
    });
    child.stdin.on("error", (err) => {
      if (!writeError) writeError = err;
    });
    child.stdout.on("data", (chunk) => parser.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrPreview.length < 4096) stderrPreview += chunk.toString("utf8", 0, 4096 - stderrPreview.length);
    });

    const sample = () => {
      const rss = readChildRssKb(child.pid);
      if (rss.source) rssSource = rss.source;
      if (rss.rssKb !== undefined) {
        if (firstRssKb === undefined) firstRssKb = rss.rssKb;
        peakSampledRssKb = Math.max(peakSampledRssKb, rss.rssKb);
        rssSamples++;
        if (
          opts.maxRssDeltaMb !== undefined &&
          firstRssKb !== undefined &&
          rss.rssKb > firstRssKb + opts.maxRssDeltaMb * 1024 &&
          !guardTerminated
        ) {
          guardTerminated = true;
          guardErrors.push(
            `sampled RSS exceeded guard: ${formatMb(rss.rssKb)} MiB > first + ${opts.maxRssDeltaMb} MiB`,
          );
          child.kill("SIGTERM");
        }
      }
      if (rss.hwmKb !== undefined) peakHwmKb = Math.max(peakHwmKb ?? 0, rss.hwmKb);
    };
    sample();
    const sampler = setInterval(sample, opts.sampleMs);
    const timeout = setTimeout(() => {
      guardTerminated = true;
      guardErrors.push(`timeout exceeded: ${opts.timeoutMs} ms`);
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    timeout.unref?.();

    const closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      await writeNativeMessage(child.stdin, opts, bodyBytes);
    } catch (err) {
      writeError = err;
    }

    const close = await closePromise;
    clearInterval(sampler);
    clearTimeout(timeout);
    sample();

    const elapsedMs = Math.round(performance.now() - started);
    const errors = parser.finishErrors();
    errors.push(...guardErrors);
    if (spawnError) errors.push(String(spawnError.message || spawnError));
    if (writeError) errors.push(String(writeError.message || writeError));
    if (close.code !== 0) errors.push(`${opts.wasmtime} exited with status ${close.code}`);
    if (close.signal) errors.push(`${opts.wasmtime} exited via signal ${close.signal}`);
    if (parser.stats.maxResponseFrameBodyBytes > opts.maxResponseFrameBytes && !opts.allowLargeResponseFrame) {
      errors.push(
        `response frame exceeded chunk budget: ${parser.stats.maxResponseFrameBodyBytes} > ${opts.maxResponseFrameBytes}`,
      );
    }
    if (opts.bodyBytes !== undefined && parser.stats.responseBodyBytes !== bodyBytes) {
      errors.push(`response body byte total mismatch: ${parser.stats.responseBodyBytes} !== ${bodyBytes}`);
    }
    if (
      opts.arrayElements !== undefined &&
      !opts.reported64mib &&
      parser.stats.responseArrayElements !== opts.arrayElements
    ) {
      errors.push(
        `response array element total mismatch: ${parser.stats.responseArrayElements} !== ${opts.arrayElements}`,
      );
    }

    console.log("native_messaging_stress_result");
    console.log(`wasmtime_version=${JSON.stringify(wasmtimeVersion)}`);
    console.log(`mode=${mode}`);
    if (opts.arrayElements !== undefined) console.log(`array_elements=${opts.arrayElements}`);
    console.log(`request_body_bytes=${bodyBytes}`);
    console.log(`request_frame_budget_bytes=${opts.maxRequestFrameBytes}`);
    console.log(`response_frames=${parser.stats.responseFrames}`);
    console.log(`response_body_bytes=${parser.stats.responseBodyBytes}`);
    if (opts.arrayElements !== undefined) console.log(`response_array_elements=${parser.stats.responseArrayElements}`);
    console.log(`max_response_frame_body_bytes=${parser.stats.maxResponseFrameBodyBytes}`);
    console.log(`chunk_budget_bytes=${opts.maxResponseFrameBytes}`);
    console.log(`stdout_bytes=${parser.stats.stdoutBytes}`);
    console.log(`stderr_bytes=${stderrBytes}`);
    console.log(`rss_source=${rssSource}`);
    console.log(`rss_first_mb=${formatMb(firstRssKb)}`);
    console.log(`rss_peak_sampled_mb=${formatMb(peakSampledRssKb || undefined)}`);
    console.log(`rss_peak_hwm_mb=${formatMb(peakHwmKb)}`);
    console.log(
      `rss_peak_delta_sampled_mb=${
        firstRssKb === undefined || !peakSampledRssKb ? "n/a" : ((peakSampledRssKb - firstRssKb) / 1024).toFixed(1)
      }`,
    );
    console.log(`rss_limit_delta_mb=${opts.maxRssDeltaMb ?? "n/a"}`);
    console.log(`rss_samples=${rssSamples}`);
    console.log(`timeout_ms=${opts.timeoutMs}`);
    console.log(`elapsed_ms=${elapsedMs}`);
    if (opts.keep) console.log(`work_dir=${tmp}`);
    if (stderrPreview.trim().length > 0) console.log(`stderr_preview=${JSON.stringify(stderrPreview.trim())}`);

    if (errors.length > 0) {
      for (const error of errors) console.error(`FAIL: ${error}`);
      process.exitCode = 1;
    }
  } finally {
    if (!opts.keep) rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err.message || err}`);
  process.exitCode = 1;
});
