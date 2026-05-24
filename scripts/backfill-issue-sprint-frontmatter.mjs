#!/usr/bin/env node
// Backfill the `sprint:` YAML-frontmatter field into every issue file that
// lacks one, deriving the value from the file's current directory:
//   plan/issues/sprints/<N>/  → sprint: <N>
//   plan/issues/backlog/       → sprint: Backlog
//   plan/issues/wont-fix/      → sprint: Backlog  (+ ensure status: wont-fix)
//
// The repo is migrating to a flat plan/issues/<id>-<slug>.md layout (#1616)
// where sprint membership lives ONLY in this field, never in the directory.
// This script is the one-shot path-driven backfill run before that flatten;
// after the flatten there are no per-sprint dirs left to scan, so it becomes
// a historical no-op.
//
// Usage: node scripts/backfill-issue-sprint-frontmatter.mjs [--dry-run]
//
// Safe to run repeatedly: idempotent. Doesn't touch files that already have
// any `sprint:` line in frontmatter (even if the value disagrees with the
// directory — author intent wins).

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const issuesRoot = join(repoRoot, "plan", "issues");
const sprintsRoot = join(issuesRoot, "sprints");
const backlogRoot = join(issuesRoot, "backlog");
const wontFixRoot = join(issuesRoot, "wont-fix");

const dryRun = process.argv.includes("--dry-run");

// Each entry: { dir, sprint: <string value to write>, wontFix?: true }
function listSourceDirs() {
  const dirs = [];
  let sprintNames = [];
  try {
    sprintNames = readdirSync(sprintsRoot).filter((name) => /^\d+$/.test(name));
  } catch {}
  for (const name of sprintNames) {
    dirs.push({ dir: join(sprintsRoot, name), sprint: name });
  }
  dirs.push({ dir: backlogRoot, sprint: "Backlog" });
  dirs.push({ dir: wontFixRoot, sprint: "Backlog", wontFix: true });
  return dirs;
}

function isIssueFileName(name) {
  // Issue files match <id>.md or <id>-<slug>.md (id numeric, optional letter
  // suffix like 1169n). Excludes sprint.md, index.md, backlog.md, retros, etc.
  if (/^(sprint|index|backlog|log|SCHEMA)\.md$/i.test(name)) return false;
  if (name === "1578-test262-analysis.md") return false; // analysis doc, not an issue (no frontmatter)
  return /^\d+[a-z]?(?:[-_].+)?\.md$/i.test(name);
}

/**
 * Insert `sprint: <value>` into the YAML frontmatter of `text` if a sprint
 * key is not already present, and (when `wontFix`) ensure `status: wont-fix`.
 * Returns the (possibly modified) text and whether a change was made.
 */
function ensureSprintFrontmatter(text, sprintValue, wontFix) {
  if (!text.startsWith("---\n")) return { text, changed: false };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { text, changed: false };
  let fm = text.slice(4, end);
  let changed = false;

  // sprint: insert after `id:` if absent.
  if (!/^sprint\s*:/m.test(fm)) {
    const idMatch = fm.match(/^(id\s*:[^\n]*\n)/m);
    if (idMatch) {
      fm = fm.replace(idMatch[1], `${idMatch[1]}sprint: ${sprintValue}\n`);
    } else {
      fm = `${fm.endsWith("\n") ? fm : fm + "\n"}sprint: ${sprintValue}\n`;
    }
    changed = true;
  }

  // wont-fix: ensure status reflects it (set or rewrite).
  if (wontFix) {
    const statusMatch = fm.match(/^status\s*:[^\n]*$/m);
    if (statusMatch) {
      if (!/^status\s*:\s*wont-fix\s*$/m.test(fm)) {
        fm = fm.replace(statusMatch[0], "status: wont-fix");
        changed = true;
      }
    } else {
      const idMatch = fm.match(/^(id\s*:[^\n]*\n)/m);
      if (idMatch) fm = fm.replace(idMatch[1], `${idMatch[1]}status: wont-fix\n`);
      else fm = `${fm.endsWith("\n") ? fm : fm + "\n"}status: wont-fix\n`;
      changed = true;
    }
  }

  if (!changed) return { text, changed: false };
  return { text: `---\n${fm}${text.slice(end)}`, changed: true };
}

let totalChecked = 0;
let totalChanged = 0;
const changedBySprintForLog = new Map();

for (const { sprint, dir, wontFix } of listSourceDirs()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of names) {
    if (!isIssueFileName(name)) continue;
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    totalChecked++;
    const text = readFileSync(file, "utf-8");
    const { text: next, changed } = ensureSprintFrontmatter(text, sprint, wontFix);
    if (!changed) continue;
    totalChanged++;
    const list = changedBySprintForLog.get(sprint) ?? [];
    list.push(name);
    changedBySprintForLog.set(sprint, list);
    if (!dryRun) writeFileSync(file, next);
  }
}

const verb = dryRun ? "would update" : "updated";
console.log(`${verb} ${totalChanged} of ${totalChecked} issue files`);
for (const [sprint, files] of [...changedBySprintForLog.entries()].sort((a, b) =>
  String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }),
)) {
  console.log(`  sprint ${sprint}: ${files.length} file${files.length === 1 ? "" : "s"}`);
}
if (dryRun) console.log("(dry run — re-run without --dry-run to apply)");
