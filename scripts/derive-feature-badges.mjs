#!/usr/bin/env node
//
// derive-feature-badges.mjs — make the landing-page feature-support badges
// reflect the REAL test262 pass rates instead of hand-authored guesses.
//
// Background
// ----------
// `website/index.html` has a "Goal: 100% ECMAScript compatibility" section
// with ~80 feature rows. Each row carries a hardcoded badge:
//   ✓ full (green) · ⚠ partial (amber) · ✗ none (red).
// Those badges were written by hand and drifted from reality (Generators
// were marked ✓ at a 43% test262 pass rate; Promise was marked ✗ "not
// supported" at 77%, etc.). The page prose claims the status is "derived
// from ECMAScript Test262 pass rates" — this script makes that true.
//
// What it does
// ------------
// Every `.feat-row[data-t262-paths="a/b,c/d"]` declares one or more depth-2
// test262 path prefixes. We sum pass/(total-skip) across those paths from the
// authoritative, freshly-promoted baseline and rewrite the row's badge tone
// using the SAME thresholds the live overlay already uses (toneFor in
// index.html): ratio >= 0.90 -> full(✓), >= 0.50 -> partial(⚠), else none(✗).
// Because the baked badge and the runtime overlay share thresholds, the
// `NN%` overlay (#1583) now only ever appears on a genuinely-green badge.
//
// With `--refresh-data` we also rewrite the served
// `website/public/.../test262-report.json` and `test262-categories.json` from
// the same source (kept format-stable: 2-space pretty). This is OFF by default
// because deploy-pages.yml already copies the fresh baseline into those served
// files before every Pages build, so the live `N / T` counts are current
// without it — the badge derivation is the substantive fix here.
//
// Escape hatch
// ------------
// A row may opt OUT of auto-derivation by adding `data-badge-lock` to its
// `.feat-row` div. Use this only for a deliberate qualitative judgment that
// the raw category ratio misrepresents (e.g. a feature whose test262 category
// passes only because of a JS host import, or one that is AOT-impossible by
// design). Locked rows keep their hand-authored badge and are listed in the
// run summary so the set stays visible/reviewable.
//
// Usage
//   node scripts/derive-feature-badges.mjs                 # bake badges into index.html
//   node scripts/derive-feature-badges.mjs --check         # exit 1 if badges are stale (CI guard)
//   node scripts/derive-feature-badges.mjs --refresh-data  # also rewrite served report/categories JSON
//
// Wired into scripts/run-pages-build.mjs before scripts/build-pages.js.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INDEX_HTML = resolve(ROOT, "website", "index.html");
const PUBLIC_BENCH = resolve(ROOT, "website", "public", "benchmarks", "results");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
// Opt-in: deploy-pages.yml already refreshes the served report before the Pages
// build, so the served-data rewrite is off by default to avoid churning the
// committed JSON blobs. `--no-refresh-data` is still accepted as a no-op alias.
const REFRESH_DATA = args.has("--refresh-data") && !args.has("--no-refresh-data") && !CHECK_ONLY;

// Match the page's runtime toneFor()/badge-class mapping exactly so a baked
// badge is identical to what the live overlay would compute.
const TONES = [
  { min: 0.9, cls: "full", glyph: "✓" },
  { min: 0.5, cls: "partial", glyph: "⚠" },
  { min: 0, cls: "none", glyph: "✗" },
];
const toneFor = (ratio) => TONES.find((t) => ratio >= t.min);

// --- locate the authoritative, freshest baseline -------------------------
// Preference: test262-current.json (promoted on every push to main, always
// present in CI checkouts, carries .categories) -> root report -> served copy.
const CATEGORY_SOURCES = [
  resolve(ROOT, "benchmarks", "results", "test262-current.json"),
  resolve(ROOT, "benchmarks", "results", "test262-report.json"),
  resolve(PUBLIC_BENCH, "test262-report.json"),
];

function loadBaseline() {
  for (const file of CATEGORY_SOURCES) {
    if (!existsSync(file)) continue;
    try {
      const payload = JSON.parse(readFileSync(file, "utf8"));
      const cats = payload?.categories;
      if (Array.isArray(cats) && cats.length > 0) return { file, payload, cats };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function ratioForPaths(byPath, paths) {
  let pass = 0;
  let total = 0;
  let foundAny = false;
  const missing = [];
  for (const p of paths) {
    const cat = byPath.get(p);
    if (!cat) {
      missing.push(p);
      continue;
    }
    foundAny = true;
    pass += Number(cat.pass ?? 0);
    total += Number(cat.total ?? 0) - Number(cat.skip ?? 0);
  }
  return { pass, total, foundAny, missing };
}

// Rewrite the badge span that immediately follows a feat-row opening tag.
// The opening tag may span multiple lines; the badge is always the first
// child, separated only by whitespace.
const ROW_BADGE_RE =
  /(<div\b[^>]*\bdata-t262-paths="([^"]+)"[^>]*>)(\s*)<span class="feat-badge (full|partial|none)">([^<]*)<\/span>/g;

function deriveBadges(html, byPath) {
  const changes = [];
  const noData = [];
  const locked = [];
  let mapped = 0;

  const next = html.replace(ROW_BADGE_RE, (match, openTag, pathsAttr, gap, curCls, _glyph) => {
    mapped += 1;
    const paths = pathsAttr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (/\bdata-badge-lock\b/.test(openTag)) {
      locked.push({ paths, cls: curCls });
      return match; // leave hand-authored badge untouched
    }

    const { pass, total, foundAny, missing } = ratioForPaths(byPath, paths);
    if (!foundAny || total <= 0) {
      // Mapping resolves to no data — leave the static badge so a stale
      // mapping is visible rather than silently mis-toned.
      noData.push({ paths, missing });
      return match;
    }

    const ratio = pass / total;
    const tone = toneFor(ratio);
    if (tone.cls !== curCls) {
      changes.push({ paths, from: curCls, to: tone.cls, pass, total, pct: Math.round(ratio * 100) });
    }
    return `${openTag}${gap}<span class="feat-badge ${tone.cls}">${tone.glyph}</span>`;
  });

  return { next, changes, noData, locked, mapped };
}

function countUnmappedRows(html) {
  // feat-rows with a badge but no data-t262-paths (purely hand-authored).
  const allRows = (html.match(/<div class="feat-row"/g) || []).length;
  const mappedRows = (html.match(/data-t262-paths=/g) || []).length;
  return Math.max(0, allRows - mappedRows);
}

// --- served-data refresh (keeps live N/T counts consistent) --------------
function refreshServedData(baseline) {
  const written = [];
  const reportDest = resolve(PUBLIC_BENCH, "test262-report.json");
  // The served report must keep the full report schema. If the chosen source
  // already IS a report (has .summary), copy it verbatim; otherwise fall back
  // to the root report file which shares the schema.
  let reportPayload = null;
  if (baseline.payload?.summary) {
    reportPayload = baseline.payload;
  } else {
    const rootReport = resolve(ROOT, "benchmarks", "results", "test262-report.json");
    if (existsSync(rootReport)) {
      try {
        reportPayload = JSON.parse(readFileSync(rootReport, "utf8"));
      } catch {
        reportPayload = null;
      }
    }
  }
  if (reportPayload?.categories?.length) {
    const serialized = `${JSON.stringify(reportPayload, null, 2)}\n`;
    if (!existsSync(reportDest) || readFileSync(reportDest, "utf8") !== serialized) {
      writeFileSync(reportDest, serialized);
      written.push("test262-report.json");
    }
  }

  // The standalone categories fallback file: {timestamp, baseline_*, mode, categories}.
  const catsDest = resolve(PUBLIC_BENCH, "test262-categories.json");
  const catsPayload = {
    timestamp: baseline.payload?.timestamp ?? null,
    baseline_generated_at: baseline.payload?.baseline_generated_at ?? null,
    baseline_sha: baseline.payload?.baseline_sha ?? null,
    mode: baseline.payload?.mode ?? null,
    categories: baseline.cats,
  };
  const catsSerialized = `${JSON.stringify(catsPayload, null, 2)}\n`;
  if (!existsSync(catsDest) || readFileSync(catsDest, "utf8") !== catsSerialized) {
    writeFileSync(catsDest, catsSerialized);
    written.push("test262-categories.json");
  }
  return written;
}

// --- run ------------------------------------------------------------------
const baseline = loadBaseline();
if (!baseline) {
  console.warn("[derive-feature-badges] no test262 baseline with categories found — skipping (badges left as-is)");
  process.exit(0);
}

const byPath = new Map();
for (const cat of baseline.cats) {
  const key = cat?.path ?? cat?.name;
  if (typeof key === "string") byPath.set(key, cat);
}

const html = readFileSync(INDEX_HTML, "utf8");
const { next, changes, noData, locked, mapped } = deriveBadges(html, byPath);
const unmapped = countUnmappedRows(html);

const rel = baseline.file.replace(`${ROOT}/`, "");
console.log(`[derive-feature-badges] source: ${rel} (${baseline.cats.length} categories)`);
console.log(
  `[derive-feature-badges] rows: ${mapped} mapped · ${unmapped} unmapped (hand-authored) · ${locked.length} locked · ${noData.length} no-data`,
);

if (CHECK_ONLY) {
  if (changes.length > 0) {
    console.error(`[derive-feature-badges] --check FAILED: ${changes.length} badge(s) are stale vs real test262 data:`);
    for (const c of changes) {
      console.error(`  - ${c.from} -> ${c.to}  (${c.pct}%  ${c.pass}/${c.total})  [${c.paths.join(", ")}]`);
    }
    console.error("  Run `node scripts/derive-feature-badges.mjs` to refresh.");
    process.exit(1);
  }
  console.log("[derive-feature-badges] --check OK: all mapped badges match real test262 pass rates");
  process.exit(0);
}

if (changes.length > 0) {
  writeFileSync(INDEX_HTML, next);
  console.log(`[derive-feature-badges] updated ${changes.length} badge(s) in website/index.html:`);
  for (const c of changes) {
    console.log(`  - ${c.from} -> ${c.to}  (${c.pct}%  ${c.pass}/${c.total})  [${c.paths.join(", ")}]`);
  }
} else {
  console.log("[derive-feature-badges] all mapped badges already match real test262 data — no changes");
}

if (noData.length > 0) {
  console.warn(`[derive-feature-badges] ${noData.length} mapped row(s) had no category data (badge left as-is):`);
  for (const n of noData)
    console.warn(`  - [${n.paths.join(", ")}]${n.missing.length ? `  missing: ${n.missing.join(", ")}` : ""}`);
}
if (locked.length > 0) {
  console.log(`[derive-feature-badges] ${locked.length} locked row(s) kept hand-authored badge:`);
  for (const l of locked) console.log(`  - ${l.cls}  [${l.paths.join(", ")}]`);
}

if (REFRESH_DATA) {
  const written = refreshServedData(baseline);
  if (written.length > 0) {
    console.log(`[derive-feature-badges] refreshed served data: ${written.join(", ")}`);
  } else {
    console.log("[derive-feature-badges] served data already current");
  }
}
