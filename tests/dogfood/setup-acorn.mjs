// Deterministic acorn acquisition for the dogfood harness (#1710).
//
// Project-lead decision (2026-05-29): acquire acorn via a PINNED npm-pack
// tarball, NOT a vendored source copy and NOT an unpinned live fetch. The
// tarball is committed under fixtures/ so the harness reproduces from a clean
// checkout with NO run-time network. This module:
//   1. verifies the committed tarball matches the pinned sha1 (canonical npm
//      `dist.shasum`) — fail loud on any drift,
//   2. extracts it once into `.acorn/` (gitignored) next to this file,
//   3. returns absolute paths to the extracted entry module.
//
// The SAME extracted module is used both as the compiled-acorn *source*
// (`dist/acorn.mjs` → fed to compile()) and as the node-acorn *oracle*
// (`import()`-ed directly), guaranteeing zero version skew: any AST divergence
// is a compiler bug, never a parser-version mismatch.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @returns {{name:string,version:string,tarball:string,shasum:string,integrity:string,entryModule:string}} */
export function loadPin() {
  return JSON.parse(readFileSync(join(HERE, "acorn-pin.json"), "utf-8"));
}

function sha1(buf) {
  return createHash("sha1").update(buf).digest("hex");
}

/**
 * Ensure the pinned acorn tarball is extracted and integrity-checked.
 * Idempotent: re-extracts only if the extraction dir is missing.
 *
 * @param {{force?: boolean}} [opts]
 * @returns {{root:string, entryModulePath:string, version:string, pin:object}}
 */
export function setupAcorn(opts = {}) {
  const pin = loadPin();
  const tarballPath = resolve(HERE, pin.tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(
      `[dogfood] pinned acorn tarball missing at ${tarballPath} — it must be committed (see acorn-pin.json).`,
    );
  }

  // Integrity gate: the committed tarball must match the pinned canonical sha1.
  const buf = readFileSync(tarballPath);
  const got = sha1(buf);
  if (got !== pin.shasum) {
    throw new Error(
      `[dogfood] acorn tarball integrity mismatch.\n` +
        `  expected sha1 ${pin.shasum} (canonical npm dist.shasum for ${pin.name}@${pin.version})\n` +
        `  got      sha1 ${got}\n` +
        `Refuse to run with an unverified parser source.`,
    );
  }

  const root = join(HERE, ".acorn");
  const entryModulePath = join(root, pin.entryModule);

  if (opts.force && existsSync(root)) rmSync(root, { recursive: true, force: true });

  if (!existsSync(entryModulePath)) {
    mkdirSync(root, { recursive: true });
    // `tar` is available in the CI/container image; extract deterministically.
    execFileSync("tar", ["-xzf", tarballPath, "-C", root], { stdio: "pipe" });
    if (!existsSync(entryModulePath)) {
      throw new Error(
        `[dogfood] extraction did not produce ${pin.entryModule} under ${root}; ` + `check the tarball layout.`,
      );
    }
  }

  return { root, entryModulePath, version: pin.version, pin };
}
