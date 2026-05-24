// #1530 — Native Messaging host example compiles to a valid WASI module.
//
// The example under examples/native-messaging/host.ts demonstrates reading a
// Chrome Native Messaging framed message off stdin (fd=0 via readStdin), routing
// debug to stderr (fd=2 via console.error), and emitting a JSON response on
// stdout (fd=1). This test pins down that the example still compiles to a valid
// WASI binary that imports only wasi_snapshot_preview1 — so a refactor of the
// WASI codegen path can't silently break the documented example.
//
// It does NOT assert on the *content* the host writes to stdout: per the
// example's README, runtime-string output and the binary length prefix have
// documented gaps (filed as follow-up issues). This test guards compilation
// and module validity only.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "host.ts");

describe("#1530 Native Messaging host example", () => {
  it("compiles examples/native-messaging/host.ts under --target wasi", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("imports stdin (fd_read) and stdout (fd_write) WASI syscalls, no env imports", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("fd_read"); // readStdin()
    expect(result.wat).toContain("fd_write"); // console.log / console.error
    // Standalone: no JS host env.* imports leak in.
    expect(result.wat).not.toContain('(import "env"');
  });

  it("produces a binary that WebAssembly accepts", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // Throws on an invalid module; passing means the structure/types are sound.
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });
});
