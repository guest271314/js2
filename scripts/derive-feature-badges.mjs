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
// #2665 — EVERY feature row is now derived, not just the ~27 rows that
// happened to carry a `data-t262-paths` attribute. Each row is matched by
// its `.feat-name` text to a feature in `website/public/feature-examples.json`
// — the canonical per-feature aggregation produced by
// `website/dashboard/build-data.js`, which buckets every test262 result into
// exactly one feature (first-match-wins on the shared
// `scripts/feature-test-categories.json` map) and records `passCount` /
// `totalCount` / `testCategories`. Those are the same numbers the per-feature
// detail page and the runtime overlay use, and — unlike the depth-2
// `test262-current.json` category totals — they resolve fine-grained features
// (e.g. `built-ins/Array/prototype/includes`, `annexB/.../String/prototype/anchor`)
// without double-counting shared path prefixes.
//
// The badge tone is rewritten and the feature's `testCategories` are injected
// as the row's `data-t262-paths` so the runtime overlay (live `N / T` counts,
// `NN%` chip, test262 source links) and the build-time bake agree by
// construction. Matching by name means a newly-added catalog row is
// auto-covered the moment its name matches a feature entry — no per-row
// attribute upkeep, and no rows silently left on a stale hand-authored status.
//
// What it does
// ------------
// Rewrite each row's badge tone using the SAME thresholds the runtime overlay
// uses (hydrateFeatureBadges in index.html):
//   ratio >= 0.90        -> full(✓)
//   0 < ratio < 0.90     -> partial(⚠)
//   ratio == 0, total>0  -> none(✗)
//   totalCount == 0      -> NO measurable test262 data (TC39 proposal not in
//                           the baseline, Annex B with no shard, or an unmapped
//                           category). The hand-authored badge is left as-is so
//                           the gap is visible rather than mis-toned. Audited
//                           in #2665.
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
//   node scripts/derive-feature-badges.mjs            # bake badges + paths into index.html
//   node scripts/derive-feature-badges.mjs --check    # exit 1 if badges/paths are stale (CI guard)
//
// Wired into scripts/run-pages-build.mjs AFTER build-planning-artifacts (which
// runs build-data.js -> refreshes feature-examples.json) and BEFORE
// build-pages.js, and run post-merge in test262-sharded.yml (which refreshes
// feature-examples.json first) so the badges and the committed baseline land in
// ONE atomic commit. The legacy `--refresh-data` / `--no-refresh-data` flags
// are accepted as no-ops for backward compatibility.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INDEX_HTML = resolve(ROOT, "website", "index.html");
const FEATURE_EXAMPLES = resolve(ROOT, "website", "public", "feature-examples.json");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");

// Match the page's runtime toneFor()/badge-class mapping exactly so a baked
// badge is identical to what the live overlay would compute (#2665):
// any pass > 0 is at least "partial".
const TONES = [
  { min: 0.9, cls: "full", glyph: "✓" },
  { min: Number.EPSILON, cls: "partial", glyph: "⚠" },
  { min: 0, cls: "none", glyph: "✗" },
];
const toneFor = (ratio) => TONES.find((t) => ratio >= t.min);

// Normalise a name for matching: HTML-decode the entities the catalog uses and
// collapse whitespace, so "Functions &amp; closures" === "Functions & closures".
function normName(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function loadFeatures() {
  if (!existsSync(FEATURE_EXAMPLES)) return null;
  try {
    const payload = JSON.parse(readFileSync(FEATURE_EXAMPLES, "utf8"));
    if (Array.isArray(payload?.features) && payload.features.length > 0) return payload.features;
  } catch {
    /* fall through */
  }
  return null;
}

// Rewrite the badge span (always the first child) of each feat-row and inject
// the feature's `testCategories` as `data-t262-paths`. The opening tag may span
// multiple lines and already carry data-* attributes; the `.feat-name` follows
// the badge.
const ROW_RE =
  /(<div class="feat-row"([^>]*)>)(\s*)<span class="feat-badge (full|partial|none)">([^<]*)<\/span>([\s\S]*?<span class="feat-name">([^<]*)<\/span>)/g;

function setPathsAttr(openTag, attrs, paths) {
  const want = paths.join(",");
  if (/\bdata-t262-paths="/.test(attrs)) {
    return openTag.replace(/(\bdata-t262-paths=")[^"]*(")/, `$1${want}$2`);
  }
  if (!want) return openTag;
  return openTag.replace(/(<div class="feat-row")/, `$1 data-t262-paths="${want}"`);
}

function derive(html, byName) {
  const changes = [];
  const noData = [];
  const locked = [];
  const unmatched = [];
  let derived = 0;
  let pathsTouched = 0;

  const next = html.replace(ROW_RE, (match, openTag, attrs, gap, curCls, glyph, tail, rawName) => {
    const name = normName(rawName);
    const feature = byName.get(name);
    if (!feature) {
      unmatched.push(name);
      return match;
    }

    const paths = Array.isArray(feature.testCategories) ? feature.testCategories.filter(Boolean) : [];
    let newOpen = setPathsAttr(openTag, attrs, paths);
    if (newOpen !== openTag) pathsTouched += 1;

    if (/\bdata-badge-lock\b/.test(openTag)) {
      locked.push({ name, cls: curCls });
      return `${newOpen}${gap}<span class="feat-badge ${curCls}">${glyph}</span>${tail}`;
    }

    const pass = Number(feature.passCount ?? 0);
    const total = Number(feature.totalCount ?? 0);
    if (total <= 0) {
      noData.push({ name, cats: paths.length });
      return `${newOpen}${gap}<span class="feat-badge ${curCls}">${glyph}</span>${tail}`;
    }

    derived += 1;
    const ratio = pass / total;
    const tone = toneFor(ratio);
    if (tone.cls !== curCls) {
      changes.push({ name, from: curCls, to: tone.cls, pass, total, pct: Math.round(ratio * 100) });
    }
    return `${newOpen}${gap}<span class="feat-badge ${tone.cls}">${tone.glyph}</span>${tail}`;
  });

  return { next, changes, noData, locked, unmatched, derived, pathsTouched };
}

// --- run ------------------------------------------------------------------
const features = loadFeatures();
if (!features) {
  console.warn(
    "[derive-feature-badges] website/public/feature-examples.json not found or empty — skipping (badges left as-is)",
  );
  process.exit(0);
}

const byName = new Map();
for (const f of features) {
  if (typeof f?.name === "string") byName.set(normName(f.name), f);
}

const html = readFileSync(INDEX_HTML, "utf8");
const { next, changes, noData, locked, unmatched, derived, pathsTouched } = derive(html, byName);
const htmlChanged = next !== html;

console.log(`[derive-feature-badges] source: website/public/feature-examples.json (${features.length} features)`);
console.log(
  `[derive-feature-badges] rows: ${derived} derived · ${noData.length} no-data (kept static) · ${locked.length} locked · ${unmatched.length} unmatched`,
);

if (CHECK_ONLY) {
  if (htmlChanged) {
    if (changes.length > 0) {
      console.error(
        `[derive-feature-badges] --check FAILED: ${changes.length} badge(s) are stale vs real test262 data:`,
      );
      for (const c of changes) {
        console.error(`  - ${c.from} -> ${c.to}  (${c.pct}%  ${c.pass}/${c.total})  [${c.name}]`);
      }
    }
    if (pathsTouched > 0) {
      console.error(
        `[derive-feature-badges] --check FAILED: ${pathsTouched} row(s) have a stale/missing data-t262-paths`,
      );
    }
    console.error("  Run `node scripts/derive-feature-badges.mjs` to refresh.");
    process.exit(1);
  }
  console.log("[derive-feature-badges] --check OK: badges and data-t262-paths match real test262 data");
  process.exit(0);
}

if (htmlChanged) {
  writeFileSync(INDEX_HTML, next);
  console.log(
    `[derive-feature-badges] updated website/index.html: ${changes.length} badge(s), ${pathsTouched} data-t262-paths attr(s)`,
  );
  for (const c of changes) {
    console.log(`  - ${c.from} -> ${c.to}  (${c.pct}%  ${c.pass}/${c.total})  [${c.name}]`);
  }
} else {
  console.log("[derive-feature-badges] badges and data-t262-paths already current — no changes");
}

if (noData.length > 0) {
  console.warn(`[derive-feature-badges] ${noData.length} matched row(s) had no test262 data (badge left as-is):`);
  for (const n of noData) console.warn(`  - ${n.name}  (categories: ${n.cats})`);
}
if (locked.length > 0) {
  console.log(`[derive-feature-badges] ${locked.length} locked row(s) kept hand-authored badge:`);
  for (const l of locked) console.log(`  - ${l.cls}  [${l.name}]`);
}
if (unmatched.length > 0) {
  console.warn(`[derive-feature-badges] ${unmatched.length} catalog row(s) had no feature-examples match:`);
  for (const n of unmatched) console.warn(`  - ${n}`);
}
