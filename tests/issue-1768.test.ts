// #1768 — allowJs Native Messaging sendMessage-shaped code must emit valid WASI Wasm.
//
// guest271314 reported that a TypeScript Native Messaging host compiled to
// valid WASI Wasm, but the equivalent plain JavaScript produced an invalid
// module in `sendMessage` (`unknown global: global index out of bounds`, and
// before pulling, `type mismatch: expected externref, found f64`). The JS input
// path is first-class, so keep this regression as allowJs/.js source.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "nm_js2wasm_node_fs.ts");

async function compileWasiJs(source: string, linkNodeFs = false) {
  return await compile(source, {
    fileName: "nm_js2wasm_node_fs.js",
    allowJs: true,
    target: "wasi",
    optimize: 0,
    ...(linkNodeFs ? { link: ["node:fs"] } : {}),
  });
}

function runWasiCaptureStdout(binary: Uint8Array): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const captured: number[] = [];
  const wasi = {
    fd_read(): number {
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = new DataView(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1) {
          for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
        }
        total += len;
      }
      view.setUint32(nwritten, total, true);
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
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    wasi_snapshot_preview1: wasi,
    env: {},
  });
  ref.mem = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)();
  return Uint8Array.from(captured);
}

describe("#1768 allowJs Native Messaging sendMessage validates under --target wasi", () => {
  it("validates the full native-messaging host after TypeScript-to-JavaScript transpilation", async () => {
    const source = ts.transpileModule(readFileSync(hostPath, "utf-8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        removeComments: false,
      },
    }).outputText;

    // #2631 — the example now imports node:fs readSync/writeSync, lowered via the
    // node:fs shim under --link node:fs (the transpiled JS keeps the import).
    const result = await compileWasiJs(source, /* linkNodeFs */ true);
    expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    expect(result.wat).not.toContain('(import "env"');
  });

  it("validates and runs sendMessage with Uint8Array subarray/indexOf/set/stdout.write", async () => {
    const source = `
      function sendMessage(message) {
        let prepend = null;
        let append = null;
        const open = message.indexOf(91);
        const close = message.indexOf(93);

        if (open !== 0) {
          prepend = 91;
        }
        if (close === -1) {
          append = 93;
        }

        const bodyStart = open === -1 ? 0 : open;
        const body = message.subarray(bodyStart, message.length);
        const prefixLength = prepend === null ? 0 : 1;
        const suffixLength = append === null ? 0 : 1;
        const responseLength = prefixLength + body.length + suffixLength;
        const output = new Uint8Array(4 + responseLength);

        output[0] = responseLength & 255;
        output[1] = (responseLength >> 8) & 255;
        output[2] = (responseLength >> 16) & 255;
        output[3] = (responseLength >> 24) & 255;

        let cursor = 4;
        if (prepend !== null) {
          output[cursor] = prepend;
          cursor = cursor + 1;
        }

        output.set(body, cursor);
        cursor = cursor + body.length;

        if (append !== null) {
          output[cursor] = append;
        }

        process.stdout.write(output);
      }

      export function main() {
        const message = new Uint8Array([123, 34, 111, 107, 34, 58, 49, 125]);
        sendMessage(message);
      }
    `;

    const result = await compileWasiJs(source);
    expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    expect(result.wat).not.toContain('(import "env"');

    const out = runWasiCaptureStdout(result.binary);
    expect(Array.from(out)).toEqual([10, 0, 0, 0, 91, 123, 34, 111, 107, 34, 58, 49, 125, 93]);
  });
});
