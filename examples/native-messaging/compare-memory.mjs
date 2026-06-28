#!/usr/bin/env node
// Reproduce the #389 Native Messaging memory scenario across wasmtime versions
// and host implementations, with echo-correctness checking.
//
// For each (host source × wasmtime binary) and each `--sizes` entry it compiles
// the source to standalone WASI, streams `--frames` Chrome-framed messages of
// that many MiB each (a comma-laden `JSON.stringify(Array(N))` body — the shape
// produced by `port.postMessage(Array(209715*64))`), reassembles the framed
// stdout, and reports peak RSS, whether every response frame is valid JSON
// within the 1 MiB cap and the elements reassemble to the input (the actual
// native-messaging contract — Chrome JSON-parses each frame), and wall time.
// One table is printed per size.
//
// Every .ts source is ALSO transpiled to .js (TS types stripped, JSDoc @param
// types kept so js2wasm still types it) and compiled, so the table shows both
// the .ts host and its .js form behave identically. Disable with --no-js.
//
// Examples:
//   # default: 3 frames at both 1 MiB and 64 MiB, .ts + .js, wasmtime on PATH
//   node examples/native-messaging/compare-memory.mjs
//
//   # compare two pinned wasmtime builds against both host versions
//   node examples/native-messaging/compare-memory.mjs --frames 3 --sizes 1,64 \
//     --wasmtime 44.0.2=/path/to/wasmtime-44 \
//     --wasmtime 45.0.0=/path/to/wasmtime-45
//
//   # auto-download the linux build for the host arch
//   node examples/native-messaging/compare-memory.mjs --download 44.0.2,45.0.0
//
// Sources default to nm_js2wasm_node_fs.ts (this repo's host) and, if present,
// nm_js2wasm_node_fs_guest.ts. Override with --source LABEL=FILE (repeatable).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";

const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,tail-call=y,exceptions=y"];
const FRAME_CHUNK = 1024 * 1024; // Chrome's host->extension per-message cap
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

function parseArgs(argv) {
  const opts = {
    frames: 3,
    sizes: null, // MiB list; default applied after parsing
    guardMb: 6144,
    sampleMs: 15,
    wasmtimes: [], // {label, path}
    sources: [], // {label, file}
    download: [],
    js: true,
    keep: false,
  };
  const toSizes = (s) =>
    s
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => n > 0);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a === "--frames") opts.frames = Number(argv[++i]);
    else if (a.startsWith("--sizes")) opts.sizes = toSizes(val());
    else if (a === "--mib") opts.sizes = [Number(argv[++i])];
    else if (a === "--no-js") opts.js = false;
    else if (a === "--guard-mb") opts.guardMb = Number(argv[++i]);
    else if (a === "--sample-ms") opts.sampleMs = Number(argv[++i]);
    else if (a.startsWith("--wasmtime")) {
      const [label, path] = val().split("=");
      opts.wasmtimes.push({ label, path: resolve(path) });
    } else if (a.startsWith("--source")) {
      const [label, file] = val().split("=");
      opts.sources.push({ label, file: resolve(file) });
    } else if (a.startsWith("--download")) {
      opts.download = val()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--keep") opts.keep = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .filter((l) => l.startsWith("//"))
          .join("\n"),
      );
      process.exit(0);
    } else throw new Error(`unknown option: ${a}`);
  }
  if (!opts.sizes || opts.sizes.length === 0) opts.sizes = [1, 64];
  return opts;
}

// Strip a label down to a filesystem-safe key for temp dirs / filenames.
function keyOf(label) {
  return label.replace(/[^a-z0-9]+/gi, "_");
}

// Transpile a .ts host to .js with TS type annotations removed but comments
// (JSDoc @param types) KEPT — js2wasm reads those JSDoc types, so the .js form
// compiles to the same typed Wasm as the .ts. esbuild strips JSDoc, which would
// drop the types and mis-compile (e.g. number params), so use the TS transpiler.
function transpileToJs(tsFile, outDir, key) {
  const src = readFileSync(tsFile, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
    },
  }).outputText;
  const dest = join(outDir, `${key}.js`);
  writeFileSync(dest, out);
  return dest;
}

function hostArch() {
  return process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
}

function downloadWasmtime(version, cacheDir) {
  const v = version.startsWith("v") ? version : `v${version}`;
  const dir = `wasmtime-${v}-${hostArch()}-linux`;
  const dest = join(cacheDir, dir, "wasmtime");
  if (existsSync(dest)) return dest;
  const url = `https://github.com/bytecodealliance/wasmtime/releases/download/${v}/${dir}.tar.xz`;
  console.error(`== downloading ${url} ==`);
  const tarball = join(cacheDir, `${dir}.tar.xz`);
  const dl = spawnSync("curl", ["-sL", url, "-o", tarball], { stdio: "inherit" });
  if (dl.status !== 0) throw new Error(`download failed for ${version}`);
  const ex = spawnSync("tar", ["xf", tarball, "-C", cacheDir], { stdio: "inherit" });
  if (ex.status !== 0) throw new Error(`extract failed for ${version}`);
  if (!existsSync(dest)) throw new Error(`${dest} not found after extract`);
  return dest;
}

function wasmtimeVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return (r.stdout || r.stderr || "").trim();
}

function buildCli(outDir) {
  const cli = join(outDir, "js2wasm-cli.mjs");
  if (existsSync(cli)) return cli;
  console.error("== building standalone js2wasm CLI ==");
  const r = spawnSync(process.execPath, ["scripts/build-standalone-cli.mjs", "--outfile", cli], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("CLI build failed");
  return cli;
}

function compile(cli, source, outDir, key) {
  const dir = join(outDir, key);
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, [cli, source, "--target", "wasi", "-o", dir, "--quiet"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (r.status !== 0) throw new Error(`compile failed for ${source}`);
  const base = source.replace(/.*\//, "").replace(/\.ts$/, "");
  const wasm = join(dir, `${base}.wasm`);
  if (!existsSync(wasm)) throw new Error(`${wasm} not produced`);
  return wasm;
}

function jsonArrayBody(bytes) {
  const n = Math.max(0, Math.floor((bytes - 2) / 5)); // '[' + 'null'(,'null')* + ']'
  const buf = Buffer.from("[" + "null" + ",null".repeat(Math.max(0, n - 1)) + "]", "utf8");
  return { buf, elements: n }; // n `null` elements
}

function rssKb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

// Reassemble framed stdout (4-byte LE length + body, repeated). Each frame must
// be a complete, valid JSON value (Chrome rejects anything else) within the
// 1 MiB cap; the flattened array elements must equal what was sent. This is the
// real native-messaging contract — NOT byte-for-byte equality, since a >1 MiB
// array is re-chunked into several `[...]` frames whose elements concatenate.
function makeFrameSink() {
  const head = Buffer.alloc(4);
  let headOff = 0;
  let bodyRemaining = 0;
  let frameBuf = null;
  let frameOff = 0;
  let bodyBytes = 0;
  let frames = 0;
  let elements = 0;
  let maxFrameBody = 0;
  let allValid = true;
  return {
    push(buf) {
      let off = 0;
      while (off < buf.length) {
        if (bodyRemaining > 0) {
          const n = Math.min(bodyRemaining, buf.length - off);
          buf.copy(frameBuf, frameOff, off, off + n);
          frameOff += n;
          bodyBytes += n;
          bodyRemaining -= n;
          off += n;
          if (bodyRemaining === 0) {
            try {
              const v = JSON.parse(frameBuf.toString("utf8"));
              if (Array.isArray(v)) elements += v.length;
              else allValid = false; // a frame must be a JSON array here
            } catch {
              allValid = false; // raw byte-chunk frames land here
            }
            frameBuf = null;
          }
          continue;
        }
        const n = Math.min(4 - headOff, buf.length - off);
        buf.copy(head, headOff, off, off + n);
        headOff += n;
        off += n;
        if (headOff === 4) {
          bodyRemaining = head.readUInt32LE(0);
          headOff = 0;
          frames++;
          maxFrameBody = Math.max(maxFrameBody, bodyRemaining);
          if (bodyRemaining === 0)
            allValid = false; // empty body is not valid JSON
          else {
            frameBuf = Buffer.allocUnsafe(bodyRemaining);
            frameOff = 0;
          }
        }
      }
    },
    result(expectedElements) {
      return {
        bodyBytes,
        frames,
        maxFrameBody,
        elements,
        valid: allValid && elements === expectedElements && maxFrameBody <= FRAME_CHUNK,
      };
    },
  };
}

async function runOne(bin, version, wasm, body, elements, frames, opts) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const child = spawn(bin, [...WASMTIME_FLAGS, wasm], { stdio: ["pipe", "pipe", "pipe"] });
  const sink = makeFrameSink();
  let first,
    peak = 0,
    killed = false;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (c) => sink.push(c));
  child.stderr.on("data", () => {});
  const sampler = setInterval(() => {
    const r = rssKb(child.pid);
    if (r !== undefined) {
      if (first === undefined) first = r;
      peak = Math.max(peak, r);
      if (r / 1024 > opts.guardMb && !killed) {
        killed = true;
        child.kill("SIGKILL");
      }
    }
  }, opts.sampleMs);
  const t0 = performance.now();
  (async () => {
    for (let i = 0; i < frames; i++) {
      if (!child.stdin.writable) break;
      child.stdin.write(header);
      await new Promise((r) => child.stdin.write(body, () => r()));
    }
    try {
      child.stdin.end();
    } catch {}
  })();
  const code = await new Promise((r) => child.once("close", (c) => r(c)));
  clearInterval(sampler);
  const wall = Math.round(performance.now() - t0);
  const { bodyBytes, frames: outFrames, valid } = sink.result(elements * frames);
  return {
    version,
    peakMb: peak / 1024,
    deltaMb: (peak - (first ?? peak)) / 1024,
    outMib: bodyBytes / 1048576,
    outFrames,
    valid,
    wall,
    code,
    killed,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const work = mkdtempSync(join(tmpdir(), "nm-compare-"));
  const cacheDir = join(REPO_ROOT, ".tmp", "wasmtime-cache");
  mkdirSync(cacheDir, { recursive: true });
  try {
    // Resolve wasmtime binaries.
    for (const v of opts.download) opts.wasmtimes.push({ label: v, path: downloadWasmtime(v, cacheDir) });
    if (opts.wasmtimes.length === 0) opts.wasmtimes.push({ label: "PATH", path: "wasmtime" });

    // Resolve sources.
    if (opts.sources.length === 0) {
      opts.sources.push({ label: "ours", file: join(SCRIPT_DIR, "nm_js2wasm_node_fs.ts") });
      const guest = join(SCRIPT_DIR, "nm_js2wasm_node_fs_guest.ts");
      if (existsSync(guest)) opts.sources.push({ label: "his", file: guest });
    }

    const cli = buildCli(work);

    // Expand each source into the .ts host plus its transpiled .js form.
    const variants = [];
    for (const s of opts.sources) {
      variants.push({ label: s.label, file: s.file, key: keyOf(s.label) });
      if (opts.js && s.file.endsWith(".ts")) {
        const key = `${keyOf(s.label)}_js`;
        variants.push({ label: `${s.label} (.js)`, file: transpileToJs(s.file, work, key), key });
      }
    }
    const wasms = variants.map((v) => ({ label: v.label, wasm: compile(cli, v.file, work, v.key) }));
    const versions = opts.wasmtimes.map((w) => ({ ...w, ver: wasmtimeVersion(w.path) }));

    for (const mib of opts.sizes) {
      const { buf: body, elements } = jsonArrayBody(mib * 1048576); // per-frame body ~mib MiB
      console.log(`\n# ${opts.frames} x ${(body.length / 1048576).toFixed(0)} MiB JSON-array frames (Array shape)\n`);
      console.log("| host | wasmtime | peak RSS | Δ RSS | echoed | frames | validJSON? | wall |");
      console.log("|---|---|---:|---:|---:|---:|:--:|---:|");
      for (const { label, wasm } of wasms) {
        for (const v of versions) {
          const r = await runOne(v.path, v.ver, wasm, body, elements, opts.frames, opts);
          const tag = r.killed ? " ⚠KILLED" : r.code !== 0 ? ` ⚠exit=${r.code}` : "";
          console.log(
            `| ${label} | ${v.label} | ${r.peakMb.toFixed(0)} MB | ${r.deltaMb.toFixed(0)} MB | ` +
              `${r.outMib.toFixed(0)} MiB | ${r.outFrames} | ${r.valid ? "✅" : "❌"} | ${(r.wall / 1000).toFixed(1)} s${tag} |`,
          );
        }
      }
    }
    console.log("");
  } finally {
    if (!opts.keep) rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`FAIL: ${e.message || e}`);
  process.exitCode = 1;
});
