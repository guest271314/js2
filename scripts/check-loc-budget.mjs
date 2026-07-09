// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/check-loc-budget.mjs — LOC-regrowth ratchet (#3102).
//
// WHY THIS EXISTS
// ---------------
// Splitting the codegen god-files never sticks: every past split regrew because
// nothing structurally stops new code from landing in the biggest file.
// `src/codegen/index.ts` went 14,344 (#1013 split, Apr 10) → 6,368 (#1172 audit,
// Apr 25) → 16,565 (Jul 9). In the 12 days to 2026-07-09 four files absorbed
// +7.1k LOC. See plan/log/compiler-consolidation-plan.md §1.2.
//
// This gate is the regrowth brake, modelled exactly on the IR-fallback ratchet
// (#1376, scripts/check-ir-fallbacks.ts) and the oracle ratchet (#1930):
//
//   - A committed baseline (scripts/loc-budget-baseline.json) records a per-file
//     line ceiling for every `src/**/*.ts` file currently over the threshold,
//     plus a coarse total-`src`-LOC ceiling.
//   - The gate FAILS when a baselined file exceeds its ceiling (regrowth) or a
//     non-baselined file crosses the threshold (a new god-file), or total src
//     LOC exceeds the total ceiling.
//   - It GRANDFATHERS everything at its current size — it blocks *growth*, never
//     demands immediate shrinkage, so it merges with zero refactoring.
//   - `--update-on-decrease` banks shrinkage: when a PR lowers any ceiling it
//     rewrites the (lower) baseline so the next PR can't silently regrow it.
//     Growth still fails. Decreases are staged on disk only; the PR author
//     commits the diff (same convention as the IR/oracle ratchets).
//   - `--update` force-reseeds from current sizes, for the rare PR that
//     deliberately grows a file (visible in review via the committed baseline).
//
// Line count matches `wc -l` (newline count) so the baseline is reproducible
// with `find src -name '*.ts' ! -name '*.d.ts' | xargs wc -l`.
//
// USAGE
//   pnpm run check:loc-budget                          # gate against baseline
//   pnpm run check:loc-budget -- --update              # force-reseed the baseline
//   pnpm run check:loc-budget -- --update-on-decrease  # gate, bank decreases
//   pnpm run check:loc-budget -- --json                # machine-readable snapshot

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/loc-budget-baseline.json");
const SRC_ROOT = join(REPO_ROOT, "src");

// A file crossing this many lines becomes a tracked god-file. 1,500 LOC is the
// point past which a single-file module stops being reviewable in one sitting.
const THRESHOLD = 1500;
// Headroom for the coarse total-`src`-LOC ceiling above the current total. The
// per-file ceilings are the real teeth; this is a runaway backstop against
// sprawl that hides below the threshold across many small files.
const TOTAL_HEADROOM = 75000;

/** Recursively list `.ts` files under `src` (excluding `.d.ts`), sorted. */
function listSrcFiles() {
  const out = [];
  const stack = [SRC_ROOT];
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

/** Count lines the way `wc -l` does: number of `\n` bytes. */
function countLines(filePath) {
  const buf = readFileSync(filePath);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return n;
}

/** Repo-relative path with forward slashes, so the baseline is OS-independent. */
function relPath(filePath) {
  return relative(REPO_ROOT, filePath).split(sep).join("/");
}

/** Current line count per src file + total. */
function measure() {
  const files = {};
  let total = 0;
  for (const p of listSrcFiles()) {
    const lines = countLines(p);
    files[relPath(p)] = lines;
    total += lines;
  }
  return { files, total };
}

/** Build a fresh baseline: per-file ceilings for files over THRESHOLD + total ceiling. */
function seedBaseline(measured) {
  const files = {};
  for (const [path, lines] of Object.entries(measured.files).sort()) {
    if (lines > THRESHOLD) files[path] = lines;
  }
  return {
    generated: new Date().toISOString().slice(0, 10),
    threshold: THRESHOLD,
    totalCeiling: measured.total + TOTAL_HEADROOM,
    files,
  };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeBaseline(baseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}

function main() {
  const args = new Set(process.argv.slice(2));
  const mode = args.has("--update")
    ? "update"
    : args.has("--update-on-decrease")
      ? "update-on-decrease"
      : args.has("--json")
        ? "json"
        : "gate";

  const measured = measure();

  if (mode === "json") {
    process.stdout.write(JSON.stringify(measured, null, 2) + "\n");
    return;
  }

  if (mode === "update") {
    const next = seedBaseline(measured);
    writeBaseline(next);
    process.stdout.write(
      `Reseeded ${relPath(BASELINE_PATH)}: ${Object.keys(next.files).length} files > ${THRESHOLD} LOC, ` +
        `total ceiling ${next.totalCeiling} (current ${measured.total}).\n`,
    );
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    process.stderr.write(`No baseline at ${relPath(BASELINE_PATH)}. Run with --update to create it.\n`);
    process.exit(1);
  }
  const threshold = baseline.threshold ?? THRESHOLD;
  const baseFiles = baseline.files ?? {};

  const regrown = []; // baselined file over its recorded ceiling
  const newGiants = []; // non-baselined file crossing the threshold
  let anyDecrease = false;

  for (const [path, lines] of Object.entries(measured.files)) {
    if (path in baseFiles) {
      const ceiling = baseFiles[path];
      if (lines > ceiling) regrown.push({ path, ceiling, lines, delta: lines - ceiling });
      else if (lines < ceiling) anyDecrease = true;
    } else if (lines > threshold) {
      newGiants.push({ path, lines, delta: lines - threshold });
    }
  }
  // A baselined file that dropped below the threshold (removed from the reseed)
  // is also a decrease worth banking.
  for (const path of Object.keys(baseFiles)) {
    const cur = measured.files[path];
    if (cur === undefined || cur <= threshold) anyDecrease = true;
  }
  const totalCeiling = baseline.totalCeiling ?? measured.total + TOTAL_HEADROOM;
  const totalOver = measured.total > totalCeiling;
  if (measured.total < totalCeiling) anyDecrease = true;

  const failed = regrown.length > 0 || newGiants.length > 0 || totalOver;

  if (failed) {
    process.stderr.write("\nLOC budget gate FAILED (#3102):\n");
    if (regrown.length > 0) {
      process.stderr.write(`\n  Regrown files (over their recorded ceiling):\n`);
      for (const r of regrown.sort((a, b) => b.delta - a.delta)) {
        process.stderr.write(`    ${r.path}: ${r.lines} > ${r.ceiling} (+${r.delta})\n`);
      }
    }
    if (newGiants.length > 0) {
      process.stderr.write(`\n  New god-files (crossed the ${threshold} LOC threshold):\n`);
      for (const g of newGiants.sort((a, b) => b.lines - a.lines)) {
        process.stderr.write(`    ${g.path}: ${g.lines} (> ${threshold}, +${g.delta})\n`);
      }
    }
    if (totalOver) {
      process.stderr.write(`\n  Total src LOC ${measured.total} exceeds ceiling ${totalCeiling}.\n`);
    }
    process.stderr.write(
      `\nAdd code to the subsystem module, not the barrel/driver. See\n` +
        `plan/log/compiler-consolidation-plan.md. If the growth is genuinely intended,\n` +
        `run \`pnpm run check:loc-budget -- --update\` and commit the refreshed baseline\n` +
        `(visible in review).\n`,
    );
    process.exit(1);
  }

  if (mode === "update-on-decrease" && anyDecrease) {
    const next = seedBaseline(measured);
    // Preserve headroom but bank the shrink: total ceiling tracks current down.
    next.totalCeiling = Math.min(totalCeiling, measured.total + TOTAL_HEADROOM);
    writeBaseline(next);
    process.stdout.write(
      `\nLOC budget gate: ratcheted baseline (total src ${measured.total}, ceiling ${next.totalCeiling}). ` +
        `Staged update to ${relPath(BASELINE_PATH)} — commit it with the PR.\n`,
    );
    return;
  }

  process.stdout.write(
    `\nLOC budget gate: OK — no regrowth. ` +
      `${Object.keys(baseFiles).length} files tracked, total src ${measured.total}/${totalCeiling}.\n`,
  );
}

main();
