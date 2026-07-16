// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/prove-emit-identity.mjs — emitted-Wasm byte-identity oracle (#2710 slice 0).
//
// WHY THIS EXISTS
// ---------------
// #2710 ("late-bind module indices") is a representation refactor: instructions
// stop holding live func/global/type *indices* and start holding stable
// *handles* that a single `resolveLayout()` dereferences to the final index at
// serialization. The migration's whole safety argument is that it reproduces the
// CURRENT final layout byte-for-byte — so EVERY slice must emit identical bytes.
//
// This harness is that proof. It compiles a fixed corpus across the target
// matrix and records `sha256(emitBinary(mod))` per `(file, target)`. Run it
// once to capture a golden baseline, make a refactor edit, then run it in
// `check` mode: any single sha mismatch pinpoints the exact `(file, target)`
// that drifted — a far sharper regression signal than test262 row counts.
//
// It is a DEVELOPER PROOF TOOL, not a committed CI gate: the baseline is a hash
// of raw emitted bytes, which legitimately changes on most unrelated PRs, so it
// is written to a gitignored location (`.tmp/` by default) and never committed.
//
// USAGE
//   npx tsx scripts/prove-emit-identity.mjs               # write baseline (.tmp/emit-identity-baseline.json)
//   npx tsx scripts/prove-emit-identity.mjs write         # explicit write
//   npx tsx scripts/prove-emit-identity.mjs check         # compare against baseline; exit 1 on any drift
//   npx tsx scripts/prove-emit-identity.mjs check --baseline /path/to/file.json
//   npx tsx scripts/prove-emit-identity.mjs --root <dir>  # add an extra corpus root (repeatable)
//
// Typical byte-identity proof (slices 1–4):
//   npx tsx scripts/prove-emit-identity.mjs        # golden baseline BEFORE the edit
//   <apply refactor edits>
//   npx tsx scripts/prove-emit-identity.mjs check  # must print "IDENTICAL" and exit 0

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// The canonical, curated, known-compilable corpus — the same root
// `check-ir-fallbacks.ts` walks. Extra roots may be added with `--root <dir>`.
//
// `scripts/emit-identity-corpus` (#3105 slice 1) holds small programs that
// compile under the `linear` target too — every website/playground example is
// DOM/Promise/class-field-oriented and CEs under the linear-memory backend, so
// without this root the `linear` target would be all-CE and prove nothing about
// the linear runtime scaffolds this issue dedups.
const DEFAULT_CORPUS_ROOTS = [
  join(REPO_ROOT, "website/playground/examples"),
  join(REPO_ROOT, "scripts/emit-identity-corpus"),
];

// The full backend matrix this refactor must keep byte-identical. `gc` is the
// default WasmGC lowering; `standalone`/`wasi` exercise the late-import +
// string-constant-global paths that are exactly the index-shift bug surface;
// `linear` (#3105 slice 1) covers the separate linear-memory backend
// (`src/codegen-linear/`) — its runtime scaffolds (map/set open-addressing,
// counter loops) are a distinct emit-idiom dedup surface that gc/standalone/wasi
// never exercise, so it must be proven independently.
const TARGETS = /** @type {const} */ (["gc", "standalone", "wasi", "linear"]);

const DEFAULT_BASELINE = join(REPO_ROOT, ".tmp/emit-identity-baseline.json");

/** Recursively list `.ts` files (excluding `.d.ts`), sorted for determinism. */
function listTsFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) stack.push(p);
      else if (s.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
    }
  }
  return out.sort();
}

/**
 * Compile one `(file, target)` and return a deterministic record. A compile
 * error (CE) is itself a stable outcome and is recorded (with the first error
 * line) so a slice that flips CE<->success is also caught as drift.
 */
async function probe(filePath, target) {
  const source = readFileSync(filePath, "utf-8");
  try {
    const r = await compile(source, { target });
    if (!r.success || !r.binary) {
      return { status: "ce", detail: (r.errors?.[0]?.message ?? "no binary").split("\n")[0].slice(0, 160) };
    }
    return {
      status: "ok",
      sha256: createHash("sha256").update(r.binary).digest("hex"),
      bytes: r.binary.length,
    };
  } catch (e) {
    return {
      status: "throw",
      detail: String(e?.message ?? e)
        .split("\n")[0]
        .slice(0, 160),
    };
  }
}

function recordKey(relPath, target) {
  return `${relPath}::${target}`;
}

function summarize(rec) {
  if (!rec) return "(absent)";
  if (rec.status === "ok") return `ok  sha=${rec.sha256.slice(0, 12)} bytes=${rec.bytes}`;
  return `${rec.status.toUpperCase()} ${rec.detail ?? ""}`.trim();
}

async function buildSnapshot(roots) {
  const corpus = roots.flatMap(listTsFiles);
  if (corpus.length === 0) {
    throw new Error(`empty corpus — no .ts files under: ${roots.join(", ")}`);
  }
  /** @type {Record<string, any>} */
  const records = {};
  for (const filePath of corpus) {
    const relPath = relative(REPO_ROOT, filePath);
    for (const target of TARGETS) {
      const rec = await probe(filePath, target);
      records[recordKey(relPath, target)] = rec;
      process.stdout.write(`  ${recordKey(relPath, target)}  →  ${summarize(rec)}\n`);
    }
  }
  return { generated: new Date().toISOString(), targets: [...TARGETS], records };
}

function recEq(a, b) {
  if (!a || !b) return false;
  if (a.status !== b.status) return false;
  if (a.status === "ok") return a.sha256 === b.sha256 && a.bytes === b.bytes;
  return a.detail === b.detail;
}

async function main() {
  const argv = process.argv.slice(2);
  let mode = "write";
  let baselinePath = DEFAULT_BASELINE;
  const extraRoots = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "write" || a === "check") mode = a;
    else if (a === "--baseline") baselinePath = resolve(argv[++i]);
    else if (a === "--root") extraRoots.push(resolve(argv[++i]));
    else throw new Error(`unknown arg: ${a}`);
  }
  const roots = [...DEFAULT_CORPUS_ROOTS, ...extraRoots];

  console.log(`[prove-emit-identity] mode=${mode} baseline=${relative(REPO_ROOT, baselinePath)}`);
  console.log(
    `[prove-emit-identity] roots=${roots.map((r) => relative(REPO_ROOT, r)).join(", ")} targets=${TARGETS.join(",")}`,
  );
  console.log("");

  const snapshot = await buildSnapshot(roots);
  const n = Object.keys(snapshot.records).length;

  if (mode === "write") {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`\n[prove-emit-identity] wrote ${n} (file,target) hashes → ${relative(REPO_ROOT, baselinePath)}`);
    return;
  }

  // check
  if (!existsSync(baselinePath)) {
    console.error(`\n[prove-emit-identity] no baseline at ${baselinePath} — run write mode first.`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  const base = baseline.records ?? {};
  const cur = snapshot.records;
  const allKeys = new Set([...Object.keys(base), ...Object.keys(cur)]);
  const mismatches = [];
  for (const k of [...allKeys].sort()) {
    if (!recEq(base[k], cur[k])) mismatches.push({ key: k, baseline: base[k], current: cur[k] });
  }
  if (mismatches.length === 0) {
    console.log(`\n[prove-emit-identity] IDENTICAL — all ${n} (file,target) emits match baseline. ✓`);
    return;
  }
  console.error(`\n[prove-emit-identity] DRIFT — ${mismatches.length} of ${n} (file,target) emits changed:`);
  for (const m of mismatches) {
    console.error(`  ✗ ${m.key}`);
    console.error(`      baseline: ${summarize(m.baseline)}`);
    console.error(`      current:  ${summarize(m.current)}`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
