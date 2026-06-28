// #1772 Phase 1 — same-binary dual-provider compatibility proof.
//
// One compiled `node:fs`-importing wasm binary runs under TWO providers:
//   (a) the pure-WASI `node-fs.wat` shim under wasmtime, and
//   (b) the `edge.js` adapter under native Node (delegating to real `node:fs`),
// and produces BYTE-IDENTICAL output for the same stdin frames. This is the
// concrete proof that the `node:fs` host-import ABI (docs/architecture/
// node-fs-abi.md, #1772 Phase 0) is provider-agnostic by construction.
//
// The wasm binary is compiled ONCE here; both arms consume the same bytes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EDGE_RUNNER = join(REPO, "examples", "native-messaging", "run-edge.mjs");

// A framed-echo host: read a 4-byte LE length prefix + body off fd 0, echo both
// back to fd 1. Uses the Node-shaped readSync(options) / writeSync(offset)
// signatures so the SAME source also runs unmodified under real `node`.
const FRAMED_ECHO = `
import { readSync, writeSync } from "node:fs";
function readExact(buf: Uint8Array, n: number): boolean {
  let got = 0;
  while (got < n) {
    const r = readSync(0, buf, { offset: got, length: n - got });
    if (r <= 0) return false;
    got = got + r;
  }
  return true;
}
function writeAll(out: Uint8Array): void {
  let n = 0;
  while (n < out.length) {
    const w = writeSync(1, out, n);
    if (w <= 0) return;
    n = n + w;
  }
}
export function main(): void {
  const header = new Uint8Array(4);
  if (!readExact(header, 4)) return;
  const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
  const body = new Uint8Array(len);
  if (!readExact(body, len)) return;
  writeAll(header);
  writeAll(body);
}
`;

// A frame with non-printable / high bytes, so a UTF-8-collapsing provider would
// diverge: len=5 (LE) + body [0x00, 0xff, 0x0a, 0x7f, 0x80].
const FRAME = Uint8Array.from([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
const EXPECTED = Array.from(FRAME); // strict echo: header + body verbatim

function hasWasmtime(): boolean {
  try {
    execFileSync("wasmtime", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("#1772 — node:fs same-binary dual-provider compatibility", () => {
  let tmp: string;
  let userBinary: Uint8Array;

  beforeAll(async () => {
    const result = await compile(FRAMED_ECHO, {
      fileName: "nm.ts",
      target: "wasi",
      link: ["node:fs"],
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    userBinary = result.binary;
    tmp = mkdtempSync(join(tmpdir(), "edge-dual-"));
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // Provider (b): edge.js under native Node, delegating to real node:fs over
  // real fds. Spawn run-edge.mjs as a child so fd 0/1 are real pipes; feed FRAME
  // on stdin and capture the framed echo on stdout.
  it("provider (b): edge.js under native Node echoes the frame byte-for-byte", () => {
    const wasmPath = join(tmp, "nm_edge.wasm");
    writeFileSync(wasmPath, userBinary);
    const stdout = execFileSync(process.execPath, [EDGE_RUNNER, wasmPath], {
      input: Buffer.from(FRAME),
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(Array.from(stdout)).toEqual(EXPECTED);
  });

  // Provider (a): node-fs.wat shim under wasmtime, from the SAME binary.
  it.runIf(hasWasmtime())(
    "provider (a): node-fs.wat under wasmtime echoes the same bytes; both providers agree",
    () => {
      const wasmPath = join(tmp, "nm_js2wasm_wasi_p1.wasm");
      const shimPath = join(tmp, "node-fs.wasm");
      writeFileSync(wasmPath, userBinary);
      writeFileSync(shimPath, buildNodeFsShim());

      // js2wasm emits a WasmGC module, so enable the GC/function-references/
      // tail-call/exceptions proposals (mirrors examples/native-messaging/
      // smoke-test.sh's WASMTIME_FLAGS).
      const wasmtimeOut = execFileSync(
        "wasmtime",
        [
          "run",
          "-W",
          "gc=y,function-references=y,tail-call=y,exceptions=y",
          "--preload",
          `node:fs=${shimPath}`,
          "--invoke",
          "main",
          wasmPath,
        ],
        { input: Buffer.from(FRAME), maxBuffer: 4 * 1024 * 1024 },
      );

      const edgeOut = execFileSync(process.execPath, [EDGE_RUNNER, wasmPath], {
        input: Buffer.from(FRAME),
        maxBuffer: 4 * 1024 * 1024,
      });

      // The core claim: identical output from the SAME binary under both providers.
      expect(Array.from(wasmtimeOut)).toEqual(EXPECTED);
      expect(Array.from(edgeOut)).toEqual(Array.from(wasmtimeOut));
    },
  );
});
