// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1759 — process.stdout/stderr.write of a numeric template must stay on the
// WASI/native string path. The old lowering routed number spans through the
// JS-host native-string extern bridge, which emitted invalid `call undefined`
// bodies under --target wasi / standalone.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

const PROCESS_DECL = `declare const process: {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};`;

async function runWasi(source: string): Promise<{ stdout: string; stderr: string; wat: string; imports: string[] }> {
  const result = await compile(source, { fileName: "issue-1759.ts", target: "wasi" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.wat).not.toMatch(/call\s+undefined/);

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const stdoutBytes: number[] = [];
  const stderrBytes: number[] = [];
  const ref: { mem?: WebAssembly.Memory } = {};
  const wasi = buildWasiPolyfill();
  const wasiImports = new Proxy(wasi as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "fd_write") {
        return (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
          const dv = new DataView(ref.mem!.buffer);
          let total = 0;
          for (let i = 0; i < iovsLen; i++) {
            const ptr = dv.getUint32(iovs + i * 8, true);
            const len = dv.getUint32(iovs + i * 8 + 4, true);
            const out = fd === 2 ? stderrBytes : fd === 1 ? stdoutBytes : undefined;
            if (out) {
              for (let j = 0; j < len; j++) out.push(dv.getUint8(ptr + j));
            }
            total += len;
          }
          dv.setUint32(nwritten, total, true);
          return 0;
        };
      }
      return target[prop as string];
    },
  });

  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasiImports });
  ref.mem = (instance.exports as Record<string, unknown>).memory as WebAssembly.Memory;
  wasi.setMemory(ref.mem);
  (instance.exports as Record<string, () => void>).main?.();

  return {
    stdout: Buffer.from(stdoutBytes).toString("latin1"),
    stderr: Buffer.from(stderrBytes).toString("latin1"),
    wat: result.wat,
    imports,
  };
}

async function readStandaloneTemplate(): Promise<string> {
  const result = await compile(
    `
      export function len(): number {
        const n = 7;
        return \`n=\${n}\`.length;
      }
      export function at(i: number): number {
        const n = 7;
        return \`n=\${n}\`.charCodeAt(i);
      }
    `,
    { fileName: "issue-1759-standalone.ts", target: "standalone" },
  );
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.wat).not.toMatch(/call\s+undefined/);
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  expect(imports.filter((i) => i.includes("__str_from_mem") || i.includes("__str_to_mem"))).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { len(): number; at(i: number): number };
  let out = "";
  for (let i = 0; i < exports.len(); i++) out += String.fromCharCode(exports.at(i));
  return out;
}

describe("#1759 — numeric template write stays valid under WASI/native strings", () => {
  it("writes stdout numeric templates through fd=1", async () => {
    const out = await runWasi(`
      ${PROCESS_DECL}
      export function main(): void {
        const n = 7;
        const x = 3.14;
        process.stdout.write(\`n=\${n}; x=\${x}\\n\`);
      }
    `);
    expect(out.stdout).toBe("n=7; x=3.14\n");
    expect(out.stderr).toBe("");
  });

  it("writes stderr numeric templates through fd=2", async () => {
    const out = await runWasi(`
      ${PROCESS_DECL}
      export function main(): void {
        const n = -17;
        process.stderr.write(\`err=\${n}\\n\`);
      }
    `);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("err=-17\n");
  });

  it("does not emit the JS-host string extern bridge or number_toString import", async () => {
    const out = await runWasi(`
      ${PROCESS_DECL}
      export function main(): void {
        const n = 7;
        process.stdout.write(\`n=\${n}\\n\`);
      }
    `);
    expect(out.imports).not.toContain("env::number_toString");
    expect(out.imports).not.toContain("env::__str_from_mem");
    expect(out.imports).not.toContain("env::__str_to_mem");
    expect(out.imports).not.toContain("env::__str_extern_len");
    expect(out.wat).not.toContain("__str_from_extern");
    expect(out.wat).not.toContain("__str_to_extern");
  });

  it("keeps the standalone numeric template concat path valid too", async () => {
    await expect(readStandaloneTemplate()).resolves.toBe("n=7");
  });
});
