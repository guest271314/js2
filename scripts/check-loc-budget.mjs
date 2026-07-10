// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/check-loc-budget.mjs — LOC-regrowth ratchet (#3102, reworked #3131).
//
// WHY THIS EXISTS
// ---------------
// Splitting the codegen god-files never sticks: every past split regrew because
// nothing structurally stops new code from landing in the biggest file.
// `src/codegen/index.ts` went 14,344 (#1013 split, Apr 10) → 6,368 (#1172 audit,
// Apr 25) → 16,565 (Jul 9). In the 12 days to 2026-07-09 four files absorbed
// +7.1k LOC. See plan/log/compiler-consolidation-plan.md §1.2.
//
// CHANGE-SCOPED AND SELF-CONTAINED (merge-queue AND merge-conflict safe).
// When a diff base is resolvable (see scripts/lib/change-scope.mjs), the gate
// derives everything from git: a change-set fails only when it GROWS a src
// file that was already over the threshold at its own base, newly pushes a
// file over the threshold, or is net-additive beyond the total headroom. The
// committed baseline (scripts/loc-budget-baseline.json) is NOT consulted on
// this path — and PRs must NOT commit changes to it. #3131 removed the
// per-PR `--update` bump: because that bump was a whole-tree snapshot, every
// merge to main re-conflicted every open PR on the one shared file (the churn
// that held the #2835 stack — 4 re-merges for a +12 LOC PR). The baseline is
// refreshed post-merge on main only (promote-baseline / baseline-summary-sync
// are the sole writers) and serves the `--all` audit plus the no-git fallback.
//
//   - FAILS when the change-set grows a file that was over the threshold at
//     the base (regrowth), newly crosses the threshold (a new god-file), or
//     adds more than the total headroom net.
//   - GRANDFATHERS everything at its base size — blocks *growth of what you
//     touch*, never demands shrinkage; merges with zero refactoring.
//   - BANKS shrinkage automatically: once a shrink merges, every later
//     change-set's base already contains the smaller file.
//   - INTENTIONAL growth is granted per change-set, not via the shared file:
//     list the path(s) under a `loc-budget-allow:` frontmatter key in the
//     change-set's own plan/issues/*.md file (visible in the diff; no shared
//     file ⇒ no cross-PR conflicts). `total` allows a >headroom net delta.
//   - `--all` ignores change-scoping and audits the whole tree against the
//     committed baseline (local use).
//   - `--update` reseeds the committed baseline from current sizes — POST-
//     MERGE/main use only; it now skips the write when nothing but the
//     `generated` date would change.
//   - `--update-on-decrease` banks shrinkage into the committed baseline
//     (lowers, never raises) — kept for the post-merge writer and local use.
//
// Line count matches `wc -l` (newline count) so the baseline is reproducible
// with `find src -name '*.ts' ! -name '*.d.ts' | xargs wc -l`.
//
// USAGE
//   pnpm run check:loc-budget                           # gate the change-set
//   pnpm run check:loc-budget -- --all                  # audit the whole tree
//   pnpm run check:loc-budget -- --update               # reseed (post-merge/main only)
//   pnpm run check:loc-budget -- --update-on-decrease   # gate, bank decreases
//   pnpm run check:loc-budget -- --json                 # machine-readable snapshot

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChangeBase, changedPaths, baseBlob, changeSetAllowances } from "./lib/change-scope.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/loc-budget-baseline.json");
const SRC_ROOT = join(REPO_ROOT, "src");

// A file crossing this many lines becomes a tracked god-file. 1,500 LOC is the
// point past which a single-file module stops being reviewable in one sitting.
const THRESHOLD = 1500;
// Runaway backstop: the most net LOC a single change-set may add across src
// without an explicit `total` allowance. The per-file rules are the real
// teeth; this catches sprawl hiding below the threshold across many files.
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

/** Lines of `path` on `base` (0 if the file is new on this change-set). */
function baseLines(base, path) {
  const blob = baseBlob(REPO_ROOT, base, path);
  if (blob === undefined) return 0;
  let n = 0;
  for (let i = 0; i < blob.length; i++) if (blob[i] === "\n") n++;
  return n;
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

const isSrcTs = (p) => p.startsWith("src/") && p.endsWith(".ts") && !p.endsWith(".d.ts");

function failWith({ regrown, newGiants, totalNote }) {
  process.stderr.write("\nLOC budget gate FAILED (#3102):\n");
  if (regrown.length > 0) {
    process.stderr.write(`\n  God-files grown past their allowed size:\n`);
    for (const r of regrown.sort((a, b) => b.delta - a.delta)) {
      process.stderr.write(`    ${r.path}: ${r.lines} > ${r.ceiling} (+${r.delta})\n`);
    }
  }
  if (newGiants.length > 0) {
    process.stderr.write(`\n  New god-files (crossed the LOC threshold):\n`);
    for (const g of newGiants.sort((a, b) => b.lines - a.lines)) {
      process.stderr.write(`    ${g.path}: ${g.lines} (> ${g.threshold}, +${g.delta})\n`);
    }
  }
  if (totalNote) process.stderr.write(`\n  ${totalNote}\n`);
  process.stderr.write(
    `\nAdd code to the subsystem module, not the barrel/driver. See\n` +
      `plan/log/compiler-consolidation-plan.md. If the growth is genuinely intended,\n` +
      `grant THIS change-set an allowance: list the path(s) under a\n` +
      `\`loc-budget-allow:\` key in the YAML frontmatter of this PR's own issue\n` +
      `file (any plan/issues/*.md the PR adds or modifies), e.g.\n\n` +
      `  loc-budget-allow:\n` +
      `    - src/codegen/expressions/calls.ts\n\n` +
      `Do NOT commit changes to scripts/loc-budget-baseline.json in a PR — the\n` +
      `baseline is refreshed post-merge on main only (#3131; the per-PR bump\n` +
      `made every open PR merge-conflict on that file).\n`,
  );
  process.exit(1);
}

/**
 * Change-scoped gate (#3131): judge ONLY this change-set, against its own
 * base tree — no committed baseline involved. Returns false when the diff
 * against `base` cannot be computed (caller falls back to legacy mode).
 */
function gateScoped(measured, base, how, mode) {
  const changedAll = changedPaths(REPO_ROOT, base, "src");
  if (changedAll === undefined) return false;
  const changed = [...changedAll].filter(isSrcTs).sort();
  const allow = changeSetAllowances(REPO_ROOT, base, "loc-budget-allow");

  const regrown = [];
  const newGiants = [];
  const granted = [];
  let netDelta = 0;

  for (const path of changed) {
    const lines = measured.files[path] ?? 0; // deleted by this change-set → 0
    const prior = baseLines(base, path);
    netDelta += lines - prior;
    if (lines <= prior) continue; // shrink/unchanged never faults
    if (allow.has(path)) {
      granted.push(`    ${path}: ${prior} → ${lines} (+${lines - prior}) granted by ${allow.get(path).join(", ")}`);
      continue;
    }
    if (prior > THRESHOLD) {
      regrown.push({ path, ceiling: prior, lines, delta: lines - prior });
    } else if (lines > THRESHOLD) {
      newGiants.push({ path, lines, threshold: THRESHOLD, delta: lines - THRESHOLD });
    }
  }

  const totalOver = netDelta > TOTAL_HEADROOM && !allow.has("total");

  if (granted.length > 0) {
    process.stdout.write(
      `\nLOC budget gate: intentional growth allowed by this change-set's issue file:\n${granted.join("\n")}\n`,
    );
  }

  if (regrown.length > 0 || newGiants.length > 0 || totalOver) {
    failWith({
      regrown,
      newGiants,
      totalNote: totalOver
        ? `Change-set adds ${netDelta} net src LOC (> ${TOTAL_HEADROOM} headroom; add \`total\` to loc-budget-allow if intended).`
        : undefined,
    });
  }

  if (mode === "update-on-decrease") bankDecreases(measured, new Set(changed));

  process.stdout.write(
    `\nLOC budget gate: OK — no unallowed growth in ${changed.length} changed src file(s) ` +
      `(base: ${how}, net ${netDelta >= 0 ? "+" : ""}${netDelta} LOC).\n`,
  );
  return true;
}

/**
 * Legacy whole-tree gate against the committed baseline — used by `--all`
 * and when no git base is resolvable at all. The baseline is kept fresh by
 * the post-merge writers (promote-baseline / baseline-summary-sync).
 */
function gateLegacy(measured, mode, auditAll) {
  const baseline = loadBaseline();
  if (!baseline) {
    process.stderr.write(`No baseline at ${relPath(BASELINE_PATH)}. Run with --update to create it.\n`);
    process.exit(1);
  }
  const threshold = baseline.threshold ?? THRESHOLD;
  const baseFiles = baseline.files ?? {};

  const regrown = [];
  const newGiants = [];

  for (const [path, lines] of Object.entries(measured.files)) {
    if (path in baseFiles) {
      if (lines > baseFiles[path])
        regrown.push({ path, ceiling: baseFiles[path], lines, delta: lines - baseFiles[path] });
    } else if (lines > threshold) {
      newGiants.push({ path, lines, threshold, delta: lines - threshold });
    }
  }

  const totalCeiling = baseline.totalCeiling ?? measured.total + TOTAL_HEADROOM;
  const totalOver = measured.total > totalCeiling;

  if (regrown.length > 0 || newGiants.length > 0 || totalOver) {
    failWith({
      regrown,
      newGiants,
      totalNote: totalOver ? `Total src LOC ${measured.total} exceeds ceiling ${totalCeiling}.` : undefined,
    });
  }

  if (mode === "update-on-decrease") bankDecreases(measured, undefined);

  process.stdout.write(
    `\nLOC budget gate: OK — no regrowth in whole tree${auditAll ? " (--all)" : " (no git base — committed-baseline mode)"}. ` +
      `${Object.keys(baseFiles).length} files tracked, total src ${measured.total}/${totalCeiling}.\n`,
  );
}

/**
 * Bank shrinkage into the committed baseline: LOWER the ceilings of shrunk
 * files (never raise, so unrelated drift is not silently banked). Post-merge
 * writer / local use only — PRs must not commit the result (#3131).
 */
function bankDecreases(measured, scope) {
  const baseline = loadBaseline();
  if (!baseline) return;
  const baseFiles = baseline.files ?? {};
  const nextFiles = { ...baseFiles };
  let any = false;
  for (const [path, lines] of Object.entries(measured.files)) {
    if (scope && !scope.has(path)) continue;
    if (path in nextFiles && lines < nextFiles[path]) {
      nextFiles[path] = lines;
      any = true;
    }
  }
  if (!any) return;
  writeBaseline({
    generated: new Date().toISOString().slice(0, 10),
    threshold: baseline.threshold ?? THRESHOLD,
    totalCeiling: Math.min(baseline.totalCeiling ?? measured.total + TOTAL_HEADROOM, measured.total + TOTAL_HEADROOM),
    files: nextFiles,
  });
  process.stdout.write(
    `\nLOC budget gate: ratcheted baseline (banked per-file shrink; total src ${measured.total}). ` +
      `Updated ${relPath(BASELINE_PATH)} — post-merge/main writer only, do NOT commit this from a PR (#3131).\n`,
  );
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
  const auditAll = args.has("--all");

  const measured = measure();

  if (mode === "json") {
    process.stdout.write(JSON.stringify(measured, null, 2) + "\n");
    return;
  }

  if (mode === "update") {
    const prev = loadBaseline();
    const next = seedBaseline(measured);
    // Idempotent modulo the date: the post-merge writers run this on every
    // push to main / hourly — skip the write when only `generated` would
    // change so stable-main refreshes don't churn commits.
    if (
      prev &&
      prev.threshold === next.threshold &&
      prev.totalCeiling === next.totalCeiling &&
      JSON.stringify(prev.files) === JSON.stringify(next.files)
    ) {
      process.stdout.write(
        `Baseline ${relPath(BASELINE_PATH)} already current (only the date would change) — not rewritten.\n`,
      );
      return;
    }
    writeBaseline(next);
    process.stdout.write(
      `Reseeded ${relPath(BASELINE_PATH)}: ${Object.keys(next.files).length} files > ${THRESHOLD} LOC, ` +
        `total ceiling ${next.totalCeiling} (current ${measured.total}).\n`,
    );
    return;
  }

  if (!auditAll) {
    const { base, how } = resolveChangeBase(REPO_ROOT);
    if (base && gateScoped(measured, base, how, mode)) return;
  }
  gateLegacy(measured, mode, auditAll);
}

main();
