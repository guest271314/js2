// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2956 L1 — linear-IR parity ratchet (acceptance criterion 3, a clone of the
 * #1376 `check:ir-fallbacks` shape for the LINEAR overlay).
 *
 * Compiles the fixed corpus (`website/playground/examples/*.ts`) with
 * `--target linear` with the overlay explicitly ON (`JS2WASM_LINEAR_IR=1`), reads each
 * module's `LinearIrResult` report, and aggregates:
 *
 *   - `compiled`  — functions the overlay lowered via IR + LinearEmitter
 *   - per-reason demotion buckets (`illegal:instr-*`, `illegal:valtype-*`,
 *     `build`, `verify`, `lifted-closures`, …)
 *
 * Gate semantics vs `scripts/linear-ir-baseline.json`:
 *   - `compiled` must NOT DECREASE (parity progress banks; a drop means an
 *     IR-claimed-and-lowered function fell back to the direct path).
 *   - No demotion bucket may INCREASE.
 *   Decreasing buckets / increasing compiled succeed; run with `--update`
 *   to refresh the committed baseline in the same PR (visible in review).
 *
 * The overlay is default-on since L4. This script still pins `=1` so a caller's
 * ambient rollback setting cannot silently turn the ratchet into a direct-path
 * compile.
 *
 * Usage:
 *   pnpm run check:linear-ir              # gate against baseline
 *   pnpm run check:linear-ir -- --update  # refresh the committed baseline
 *   pnpm run check:linear-ir -- --json    # machine-readable output
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The overlay gate reads the env at compile time — set it before importing
// the compiler so any module-load-time capture also sees it.
process.env.JS2WASM_LINEAR_IR = "1";

const { compile } = await import("../src/index.js");
const { getLastLinearIrReport } = await import("../src/ir/backend/linear-integration.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/linear-ir-baseline.json");
const CORPUS_ROOTS = [join(REPO_ROOT, "website/playground/examples")];

interface Baseline {
  readonly compiled: number;
  readonly buckets: Record<string, number>;
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
}

const files: string[] = [];
for (const root of CORPUS_ROOTS) walk(root, files);
files.sort();

let compiledTotal = 0;
const buckets = new Map<string, number>();
const perFile: { file: string; compiled: string[]; rejected: { func: string; reason: string }[] }[] = [];

for (const file of files) {
  const source = readFileSync(file, "utf-8");
  try {
    await compile(source, { target: "linear", fileName: file });
  } catch {
    // A compile crash is a direct-path concern, not the overlay's — the
    // overlay demotes internally and never throws out of generateLinearModule.
  }
  const report = getLastLinearIrReport();
  if (!report) continue;
  compiledTotal += report.compiled.length;
  for (const rej of report.rejected) {
    buckets.set(rej.reason, (buckets.get(rej.reason) ?? 0) + 1);
  }
  if (report.compiled.length > 0 || report.rejected.length > 0) {
    perFile.push({
      file: file.slice(REPO_ROOT.length + 1),
      compiled: [...report.compiled],
      rejected: report.rejected.map((r) => ({ func: r.func, reason: r.reason })),
    });
  }
}

const current: Baseline = {
  compiled: compiledTotal,
  buckets: Object.fromEntries([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))),
};

const args = process.argv.slice(2);
const update = args.includes("--update");
const json = args.includes("--json");

if (json) {
  console.log(JSON.stringify({ current, perFile }, null, 2));
}

if (update || !existsSync(BASELINE_PATH)) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `linear-ir ratchet: baseline ${update ? "updated" : "seeded"} — compiled=${current.compiled}, buckets=${JSON.stringify(current.buckets)}`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
const failures: string[] = [];

if (current.compiled < baseline.compiled) {
  failures.push(`IR-compiled function count DECREASED: ${baseline.compiled} → ${current.compiled}`);
}
for (const [reason, count] of Object.entries(current.buckets)) {
  const base = baseline.buckets[reason] ?? 0;
  if (count > base) {
    failures.push(`demotion bucket '${reason}' INCREASED: ${base} → ${count}`);
  }
}

if (failures.length > 0) {
  console.error("linear-ir ratchet: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "If the change is intended (e.g. a claim intentionally re-scoped), run `pnpm run check:linear-ir -- --update` and commit the refreshed baseline.",
  );
  process.exit(1);
}

const improved =
  current.compiled > baseline.compiled ||
  Object.entries(baseline.buckets).some(([reason, base]) => (current.buckets[reason] ?? 0) < base);
console.log(
  `linear-ir ratchet: OK — compiled=${current.compiled} (baseline ${baseline.compiled}), buckets=${JSON.stringify(current.buckets)}${improved ? " [improved — consider --update to bank it]" : ""}`,
);
