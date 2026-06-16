#!/usr/bin/env node
/**
 * Check for duplicate `id:` fields across plan/issues/*.md files.
 * Exits 1 if duplicates are found (for use as a pre-push or pre-commit hook).
 *
 * Usage:
 *   node scripts/check-issue-ids.mjs              # check workspace files
 *   node scripts/check-issue-ids.mjs --staged     # check git-staged files only (pre-commit)
 *   node scripts/check-issue-ids.mjs --committed  # check committed tree (HEAD)
 */

import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const mode = args.includes("--staged") ? "staged" : args.includes("--committed") ? "committed" : "workspace";

/**
 * Extract the issue ID from a filename: "1799-foo.md" → "1799", "779a-bar.md" → "779a".
 * Sub-issues (779a, 779b, ...) share a parent numeric ID but have distinct filename IDs.
 * We key deduplication on the filename ID so sub-issues are never flagged as duplicates.
 */
function filenameId(fname) {
  return fname.match(/^(\d+[a-z]?)/i)?.[1]?.toLowerCase() ?? null;
}

const NON_ISSUE = new Set(["backlog.md", "index.md", "log.md", "SCHEMA.md"]);

/** @returns {Map<string, string[]>} filename-id → [filePath, ...] */
function collectFromWorkspace() {
  const dir = new URL("../plan/issues", import.meta.url).pathname;
  const map = new Map();
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith(".md") || NON_ISSUE.has(fname)) continue;
    const fpath = join(dir, fname);
    if (!statSync(fpath).isFile()) continue;
    const id = filenameId(fname);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(fname);
  }
  return map;
}

function collectFromStaged() {
  // Get staged plan/issues/*.md files
  const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.startsWith("plan/issues/") && f.endsWith(".md"));

  // Start with committed tree, then overlay staged changes
  const map = collectFromCommitted();

  for (const fpath of staged) {
    try {
      const fname = fpath.replace("plan/issues/", "");
      if (NON_ISSUE.has(fname)) continue;
      const id = filenameId(fname);
      if (!id) continue;
      // Remove any prior entry for this file (covers renames)
      for (const [k, v] of map) {
        const idx = v.indexOf(fname);
        if (idx !== -1) v.splice(idx, 1);
        if (v.length === 0) map.delete(k);
      }
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(fname);
    } catch {}
  }
  return map;
}

function collectFromCommitted() {
  let listing;
  try {
    listing = execSync("git ls-tree --name-only HEAD plan/issues/", { encoding: "utf8" });
  } catch {
    return new Map(); // no commits yet
  }
  const map = new Map();
  for (const line of listing.split("\n")) {
    const fname = line.trim();
    if (!fname.endsWith(".md") || NON_ISSUE.has(fname)) continue;
    const id = filenameId(fname);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(fname);
  }
  return map;
}

const map =
  mode === "staged" ? collectFromStaged() : mode === "committed" ? collectFromCommitted() : collectFromWorkspace();

const dupes = [...map.entries()].filter(([, v]) => v.length > 1);

if (dupes.length === 0) {
  if (!args.includes("--quiet")) {
    console.log(`✓ No duplicate issue IDs found (${map.size} issues, mode=${mode})`);
  }
  process.exit(0);
} else {
  console.error(`✗ --check FAILED: ${dupes.length} duplicate ID${dupes.length > 1 ? "s" : ""}`);
  for (const [id, files] of dupes.sort((a, b) => +a[0] - +b[0])) {
    console.error(`  #${id}:`);
    for (const f of files) console.error(`    plan/issues/${f}`);
  }
  console.error("");
  console.error("Fix: rename the newer file to use a fresh ID (next after the current max).");
  process.exit(1);
}
