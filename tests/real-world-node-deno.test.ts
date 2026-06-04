import { describe, expect, it } from "vitest";
import { compileValid, hostImportNames } from "./real-world-helpers.js";

/**
 * Real-world server-runtime APIs: Node.js and Deno.
 *
 * Neither runtime's API surface is part of the ECMAScript spec, so test262
 * never covers `process`, `Buffer`, `node:*` builtins, or the `Deno.*`
 * namespace. These assert that idiomatic Node/Deno source compiles to a valid
 * Wasm module and routes the runtime calls through the host-import boundary.
 */
describe("real-world: Node.js APIs", () => {
  it("compiles node:path imports", async () => {
    await compileValid(`
      import { join, basename, extname } from "node:path";
      export function describe(p: string): string {
        return join(basename(p), extname(p));
      }
    `);
  });

  it("compiles node:fs readFileSync (with allowFs)", async () => {
    await compileValid(
      `
        import { readFileSync } from "node:fs";
        export function read(p: string): string {
          return readFileSync(p, "utf8");
        }
      `,
      { allowFs: true },
    );
  });

  it("compiles node:crypto randomUUID", async () => {
    await compileValid(`
      import { randomUUID } from "node:crypto";
      export function id(): string {
        return randomUUID();
      }
    `);
  });

  it("lowers process.env access to a host import", async () => {
    const result = await compileValid(`
      declare const process: { env: Record<string, string> };
      export function home(): string {
        return process.env.HOME;
      }
    `);
    expect(hostImportNames(result)).toContain("__get_process_env");
  });

  it("compiles process.stdout.write", async () => {
    await compileValid(`
      declare const process: { stdout: { write(s: string): void } };
      export function log(line: string): void {
        process.stdout.write(line);
      }
    `);
  });

  it("compiles Buffer.from(...).length", async () => {
    await compileValid(`
      export function byteLength(s: string): number {
        return Buffer.from(s, "utf8").length;
      }
    `);
  });
});

describe("real-world: Deno APIs", () => {
  it("compiles Deno.cwd()", async () => {
    await compileValid(`
      declare const Deno: { cwd(): string };
      export function pwd(): string {
        return Deno.cwd();
      }
    `);
  });

  it("compiles Deno.env.get()", async () => {
    await compileValid(`
      declare const Deno: { env: { get(key: string): string | undefined } };
      export function home(): string | undefined {
        return Deno.env.get("HOME");
      }
    `);
  });

  it("compiles Deno.readTextFile() with await", async () => {
    await compileValid(`
      declare const Deno: { readTextFile(p: string): Promise<string> };
      export async function size(p: string): Promise<number> {
        const text = await Deno.readTextFile(p);
        return text.length;
      }
    `);
  });

  it("compiles a Deno.serve() handler returning a Response", async () => {
    await compileValid(`
      declare const Deno: { serve(handler: (req: any) => any): void };
      export function start(): void {
        Deno.serve((req: any) => new Response("ok"));
      }
    `);
  });
});
