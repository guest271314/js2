// #2647 (P2-a.0) — plumb `--allow-fs` into the #1772 no-provider capability gate.
//
// PR #2014 landed the #1772 P2-a "no provider" gate in
// `src/codegen/node-fs-api.ts::tryCompileNodeFsCall` with `allowFs` HARDCODED
// `false` to keep the slice atomic. So even when the JS-host filesystem provider
// is available, a path-based `node:fs` member (`readFileSync(path)`) under
// `--target wasi` always errored.
//
// This slice threads the real `--allow-fs` flag (already plumbed CLI → opts →
// `ctx.allowFs`) into the gate's capability query:
//   - WITH `allowFs: true`, the capability map's `providersFor` yields
//     `["js-host-fs"]`, so a path-based member is satisfiable → the gate is a
//     no-op (compiles green).
//   - WITHOUT it, the precise #1772 "no provider under --target wasi" error still
//     fires.
//   - fd-based `readSync`/`writeSync` are satisfiable regardless of the flag.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const NO_PROVIDER_RE = /needs a filesystem provider, unavailable under `--target wasi`/;

const readFileSyncSrc = `
import { readFileSync } from "node:fs";
export function main(): void {
  const data = readFileSync("/etc/hostname");
}
`;

describe("#2647 — plumb --allow-fs into the node:fs no-provider gate", () => {
  it("WITHOUT --allow-fs, the #1772 no-provider error still fires under --target wasi", async () => {
    const result = await compile(readFileSyncSrc, {
      fileName: "x.ts",
      target: "wasi",
      link: ["node:fs"],
    });
    expect(result.success).toBe(false);
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).toMatch(NO_PROVIDER_RE);
    expect(msgs).toMatch(/readFileSync/);
    expect(msgs).toMatch(/--allow-fs/);
  });

  it("WITH --allow-fs (allowFs: true), a path-based readFileSync(path) is satisfiable — no no-provider error", async () => {
    const result = await compile(readFileSyncSrc, {
      fileName: "x.ts",
      target: "wasi",
      link: ["node:fs"],
      allowFs: true,
    });
    // The capability map resolves the path-based member through the `js-host-fs`
    // provider, so the gate is a no-op — the precise #1772 error must NOT appear.
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).not.toMatch(NO_PROVIDER_RE);
  });

  it("the flag toggles the gate WITHOUT --link node:fs too (gate keys off --target wasi)", async () => {
    // allowFs off → error fires.
    const off = await compile(readFileSyncSrc, { fileName: "x.ts", target: "wasi" });
    const offMsgs = (off.errors ?? []).map((e) => e.message).join("\n");
    expect(offMsgs).toMatch(NO_PROVIDER_RE);

    // allowFs on → gate is a no-op.
    const on = await compile(readFileSyncSrc, { fileName: "x.ts", target: "wasi", allowFs: true });
    const onMsgs = (on.errors ?? []).map((e) => e.message).join("\n");
    expect(onMsgs).not.toMatch(NO_PROVIDER_RE);
  });

  it("fd-based readSync/writeSync compile green regardless of --allow-fs", async () => {
    const src = `
import { readSync, writeSync } from "node:fs";
export function main(): void {
  const buf = new Uint8Array(4);
  const r = readSync(0, buf, { offset: 0, length: 4 });
  let n = 0;
  while (n < r) { const w = writeSync(1, buf, n); if (w <= 0) break; n = n + w; }
}
`;
    for (const allowFs of [false, true]) {
      const result = await compile(src, {
        fileName: "x.ts",
        target: "wasi",
        link: ["node:fs"],
        allowFs,
      });
      expect(result.success).toBe(true);
    }
  });

  it("is byte-neutral for a non-fs program when --allow-fs is toggled", async () => {
    // A program that never touches node:fs must compile to identical bytes with
    // and without --allow-fs — the flag only gates the node:fs path-based members.
    const src = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const off = await compile(src, { fileName: "x.ts", target: "wasi" });
    const on = await compile(src, { fileName: "x.ts", target: "wasi", allowFs: true });
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    expect(Buffer.from(on.binary!)).toEqual(Buffer.from(off.binary!));
  });
});
