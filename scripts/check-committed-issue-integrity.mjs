#!/usr/bin/env node
// Check issue metadata from a committed git tree, independent of the working tree.

import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

const ref = process.argv[2] || "HEAD";

const NON_ISSUE_BASENAMES = new Set([
  "1034-report.md",
  "82-findings.md",
  "1578-test262-analysis.md",
  "backlog.md",
  "index.md",
  "log.md",
  "analysis-2026-03-25.md",
  "sprint-1.md",
  "sprint-2.md",
  "sprint-3.md",
]);

const EXPLICIT_ISSUE_BASENAMES = new Set(["512-illegal-cast-closures.md"]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function isIssueFile(file) {
  const name = basename(file);
  if (NON_ISSUE_BASENAMES.has(name)) return false;
  if (EXPLICIT_ISSUE_BASENAMES.has(name)) return true;
  // Frozen `<N>.md` and pre-freeze `<N>-<slug>.md` (e.g. `73-plan.md`) sprint
  // docs are planning artifacts, not issues — else `73-plan.md` collides with #73.
  if (dirname(file) === "plan/issues/sprints" && /^\d+(?:-[\w-]+)?\.md$/.test(name)) return false;
  return /^\d+[a-z]?(?:[-_].+)?\.md$/i.test(name);
}

function filenameIssueId(file) {
  return (
    basename(file)
      .match(/^(\d+[a-z]?)/i)?.[1]
      .toLowerCase() || ""
  );
}

function frontmatter(text) {
  return text.match(/^---\n([\s\S]*?)\n---\n?/)?.[1] || "";
}

function readScalar(fm, key) {
  const line = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim() || "";
  return line.replace(/^["']|["']$/g, "").trim();
}

function readInlineArray(fm, key) {
  const raw = readScalar(fm, key);
  const match = raw.match(/^\[(.*)\]$/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean);
}

function showFile(file) {
  return git(["show", `${ref}:${file}`]);
}

let files = [];
try {
  files = git(["ls-tree", "-r", "--name-only", ref, "--", "plan/issues"])
    .split("\n")
    .filter((file) => file && isIssueFile(file));
} catch (error) {
  console.error(`Unable to inspect issue files at ${ref}: ${error.message}`);
  process.exit(1);
}

const byId = new Map();
const duplicates = new Map();
const idMismatches = [];
const edges = [];

for (const file of files) {
  const text = showFile(file);
  const fm = frontmatter(text);
  const fileId = filenameIssueId(file);
  const id = (readScalar(fm, "id") || fileId).toLowerCase();
  if (!id) continue;

  if (fileId && id !== fileId) {
    idMismatches.push({ file, filename: fileId, frontmatter: id });
  }
  if (byId.has(id)) {
    if (!duplicates.has(id)) duplicates.set(id, [byId.get(id)]);
    duplicates.get(id).push(file);
  } else {
    byId.set(id, file);
  }

  for (const dep of readInlineArray(fm, "depends_on")) {
    edges.push({ file, dep });
  }
}

const dangling = edges.filter(({ dep }) => !byId.has(dep));

if (duplicates.size || idMismatches.length || dangling.length) {
  console.log(`Committed issue integrity failed for ${ref}:`);
  if (duplicates.size) {
    console.log(`\nDUPLICATE IDs (${duplicates.size}):`);
    for (const [id, entries] of duplicates) {
      console.log(`  #${id}:`);
      for (const file of entries) console.log(`    ${file}`);
    }
  }
  if (idMismatches.length) {
    console.log(`\nFILENAME/FRONTMATTER ID MISMATCH (${idMismatches.length}):`);
    for (const { file, filename, frontmatter } of idMismatches) {
      console.log(`  ${file}: filename prefix=${filename}, frontmatter id=${frontmatter}`);
    }
  }
  if (dangling.length) {
    console.log(`\nDANGLING depends_on (${dangling.length}):`);
    for (const { file, dep } of dangling) console.log(`  ${file} -> #${dep} (not found in ${ref})`);
  }
  process.exit(1);
}

console.log(`Committed issue integrity OK for ${ref} (${byId.size} issues indexed).`);
