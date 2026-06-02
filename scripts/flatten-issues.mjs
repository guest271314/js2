#!/usr/bin/env node
// Flatten every numbered issue file from
//   plan/issues/{sprints/<N>,backlog,wont-fix}/<id>[-slug].md
// to the stable flat location
//   plan/issues/<id>-<slug>.md
// and rewrite every in-repo link to the old paths. (#1616)
//
// Sprint membership is carried by the `sprint:` frontmatter field (backfilled
// by scripts/backfill-issue-sprint-frontmatter.mjs before this runs), so the
// directory no longer encodes it. NOTE (post-flatten): sprint docs were later
// moved from `sprints/<N>/sprint.md` to `sprints/<N>.md`; this one-shot
// migration script is historical and not re-run, so its `sprint.md` filter
// below is kept as-is for the record.
//
// Idempotent: re-running finds nothing to move (files already flat) and the
// link rewrite is a no-op on already-rewritten links.
//
// Usage: node scripts/flatten-issues.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_REL = "plan/issues";
const dryRun = process.argv.includes("--dry-run");

const NON_ISSUE_BASENAMES = new Set([
  "1034-report.md",
  "82-findings.md",
  "backlog.md",
  "index.md",
  "log.md",
  "analysis-2026-03-25.md",
  "sprint-1.md",
  "sprint-2.md",
  "sprint-3.md",
  "SCHEMA.md",
]);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function isIssueBasename(name) {
  if (NON_ISSUE_BASENAMES.has(name)) return false;
  if (name === "sprint.md") return false;
  return /^\d+[a-z]?(?:[-_].+)?\.md$/i.test(name);
}

function idFromBasename(name) {
  return name.match(/^(\d+[a-z]?)/i)?.[1].toLowerCase() ?? null;
}

function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "issue"
  );
}

function titleFrom(text) {
  const fm = text.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  if (fm) return fm[1];
  const h = text.match(/^#\s+(?:Issue\s+)?#?[\w-]+\s*[—:-]*\s*(.+)$/m);
  return h ? h[1] : "issue";
}

// ── Discover source files ─────────────────────────────────────────────────
// git ls-files keeps us to tracked files and lets `git mv` preserve history.
const tracked = git(["ls-files", ISSUES_REL]).split("\n").filter(Boolean);

const moves = []; // { src (rel), dst (rel) }
for (const rel of tracked) {
  const name = basename(rel);
  if (!isIssueBasename(name)) continue;
  const dir = dirname(rel);
  // Only move files that live under a sprints/<N>, backlog, or wont-fix dir.
  if (!/plan\/issues\/(sprints\/\d+|backlog|wont-fix)$/.test(dir)) continue;
  const id = idFromBasename(name);
  if (!id) continue;
  const text = readFileSync(join(ROOT, rel), "utf8");
  // Preserve an existing slug; derive one for number-only files.
  let slug = name.replace(/^(\d+[a-z]?)(?:[-_](.+))?\.md$/i, (_, _id, s) => s || "");
  if (!slug) slug = slugify(titleFrom(text));
  const dst = `${ISSUES_REL}/${id}-${slug}.md`;
  if (rel === dst) continue; // already flat
  moves.push({ src: rel, dst });
}

// Guard against target collisions (would indicate unresolved duplicate IDs).
const dstSeen = new Map();
for (const m of moves) {
  if (dstSeen.has(m.dst)) {
    console.error(`ERROR: two sources map to ${m.dst}:`);
    console.error(`  ${dstSeen.get(m.dst)}`);
    console.error(`  ${m.src}`);
    console.error("Resolve duplicate IDs (Commit 1) before flattening.");
    process.exit(1);
  }
  if (existsSync(join(ROOT, m.dst)) && !moves.some((x) => x.src === m.dst)) {
    console.error(`ERROR: target already exists and is not itself being moved: ${m.dst}`);
    process.exit(1);
  }
  dstSeen.set(m.dst, m.src);
}

// ── Perform the moves ──────────────────────────────────────────────────────
for (const m of moves) {
  if (dryRun) continue;
  git(["mv", m.src, m.dst]);
}

// ── Build link-rewrite map and rewrite tracked *.md ────────────────────────
// old relative-to-ROOT path (any of the forms below) → new flat path.
const renameMap = new Map(moves.map((m) => [m.src, m.dst]));

// For each tracked markdown file (excluding test262/), rewrite link occurrences.
const trackedMd = git(["ls-files", "*.md"])
  .split("\n")
  .filter((f) => f && !f.startsWith("test262/"));

// A link to an old issue path can appear as:
//   plan/issues/sprints/50/1234-slug.md      (repo-absolute)
//   issues/sprints/50/1234-slug.md           (no plan/ prefix)
//   ../sprints/50/1234-slug.md  / ../../...   (relative, any depth)
//   ../1234-slug.md  (within plan/issues already)
// Strategy: match a generic `<dir>/<basename>.md` where <dir> ends in a
// sprints/<N>, backlog, or wont-fix segment, then look the basename up in a map
// of old → new. Basenames are globally unique after dedup (commit 1), so the
// basename alone resolves the new flat path. This avoids a 1,600-branch regex.
const newByOldBasename = new Map(); // "1234-slug.md" -> "plan/issues/1234-slug.md"
for (const [src, dst] of renameMap) {
  newByOldBasename.set(basename(src), dst);
}

// Also index flat-target issues by their SLUG (basename minus the id prefix),
// so a link whose id was renumbered in commit 1 (e.g. an old
// 779-820-cluster-decomposition.md → 1625-820-cluster-decomposition.md, or
// backlog/1617-wasi-raw-byte-stdout.md → 1628-…) still resolves. Slugs are
// descriptive and unique; ambiguous slugs are dropped to avoid mis-linking.
const slugOf = (name) => name.replace(/^\d+[a-z]?[-_]?/, "").replace(/\.md$/, "");
const flatBySlug = new Map(); // slug -> dst | null (null = ambiguous)
const addSlug = (dst) => {
  const s = slugOf(basename(dst));
  if (!s) return;
  flatBySlug.set(s, flatBySlug.has(s) ? null : dst);
};
for (const dst of renameMap.values()) addSlug(dst);
for (const rel of tracked) {
  const name = basename(rel);
  if (isIssueBasename(name) && dirname(rel) === ISSUES_REL) addSlug(rel);
}

// Match the directory chain leading into a sprints-N / backlog / wont-fix
// segment, then the issue basename. Group 1 = full prefix (for absolute-vs-
// relative decision), group 2 = basename.
const linkRe =
  /((?:\.{1,2}\/)*(?:plan\/)?issues\/(?:sprints\/\d+|backlog|wont-fix)\/)(\d+[a-z]?(?:[-_][^)\s"'#]*)?\.md)/g;

let linkFilesChanged = 0;
for (const f of trackedMd) {
  const abs = join(ROOT, f);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  let changed = false;
  const next = text.replace(linkRe, (whole, prefix, base) => {
    // Prefer an exact old-basename match; fall back to slug-based lookup so a
    // link to a commit-1-renumbered file (old id, same slug) still resolves.
    let dst = newByOldBasename.get(base);
    if (!dst) {
      const s = slugOf(base);
      const bySlug = s ? flatBySlug.get(s) : undefined;
      if (bySlug) dst = bySlug; // null (ambiguous) falls through to no-op
    }
    if (!dst) return whole;
    changed = true;
    // Repo-absolute form (started with plan/issues/ or issues/, no ../) → keep
    // absolute. Relative form (../...) → recompute relative to the linking file.
    if (!prefix.startsWith("..")) return dst;
    const fromDir = dirname(f);
    let relLink = relative(fromDir, dst).replace(/\\/g, "/");
    if (!relLink.startsWith(".")) relLink = "./" + relLink;
    return relLink;
  });
  if (changed && next !== text) {
    if (!dryRun) writeFileSync(abs, next);
    linkFilesChanged++;
  }
}

console.log(`flatten-issues — ${dryRun ? "DRY RUN" : "applied"}`);
console.log(`  moved: ${moves.length} issue files`);
console.log(`  link files rewritten: ${linkFilesChanged}`);
if (moves.length && dryRun) {
  console.log("  sample moves:");
  for (const m of moves.slice(0, 5)) console.log(`    ${m.src} → ${m.dst}`);
}
