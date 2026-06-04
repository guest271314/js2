import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Real-world WASI command-line programs (`--target wasi`).
 *
 * test262 targets a JS engine; it never covers compiling to a standalone WASI
 * module that talks to the host via `wasi_snapshot_preview1` (fd_write,
 * proc_exit, args, …). These pin down that ordinary "CLI tool" source lowers
 * to the WASI ABI and produces a valid, instantiable module.
 */
describe("real-world: WASI command-line programs", () => {
  it("lowers console.log to fd_write and produces a valid module", async () => {
    const result = await compile(
      `
        export function main(): void {
          let sum = 0;
          for (let i = 1; i <= 10; i++) sum += i;
          console.log("sum:", sum);
        }
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("fd_write");
    expect(result.wat).not.toContain("console_log");
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("exports memory and _start for the WASI runtime", async () => {
    const result = await compile(`console.log("hello, wasi");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain('(export "memory"');
    expect(result.wat).toContain('(export "_start"');
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("reads process.argv as a valid WASI module", async () => {
    const result = await compile(
      `
        declare const process: { argv: string[] };
        export function argc(): number {
          return process.argv.length;
        }
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("lowers process.exit to proc_exit", async () => {
    const result = await compile(
      `
        declare const process: { exit(code: number): void };
        console.log("bye");
        process.exit(0);
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("proc_exit");
  });

  // KNOWN BUG (#6407): process.exit(N) under --target wasi currently emits an
  // invalid module — the exit-code argument is compiled as an i32 but then an
  // `i32.trunc_sat_f64_s` (which expects f64) is pushed on top of it
  // (src/codegen/expressions/calls.ts:3180-3186). `it.fails` keeps this
  // documented and *passing* while the bug stands; it will flip to a hard
  // failure once codegen is fixed, prompting removal of the `.fails` modifier.
  // The existing wasi-target.test.ts only checks WAT text, so it never caught
  // this.
  it.fails("process.exit currently produces an invalid binary (known codegen bug)", async () => {
    const result = await compile(
      `
        declare const process: { exit(code: number): void };
        process.exit(0);
      `,
      { target: "wasi" },
    );
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("does not emit WASI imports under the default gc target", async () => {
    const result = await compile(`console.log("hello");`);
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("wasi_snapshot_preview1");
    expect(result.wat).not.toContain("fd_write");
  });
});
