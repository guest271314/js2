#!/usr/bin/env node
// next-issue-id.mjs — print the next free plan/issues/<id> that is NOT used on
// the local working tree OR ANY pushed branch (origin/*).
//
// Why: issue ids are allocated by "next free off main", but multiple agents on
// separate branches each pick the same number because none of their new issues
// are on main yet — this collided on 1742 THREE times in one session. Scanning
// every pushed branch (not just main) closes most of that window. Returns
// max(all ids)+1 (monotonic — never reuses a gap that might be reserved on a
// branch this scan can't see, e.g. an un-pushed worktree).
//
// Usage:  node scripts/next-issue-id.mjs        -> prints e.g. 1745
//         pnpm run new:issue-id
//
// NOTE: there is still a small window between "pick id" and "push". Pair this
// with the pre-push #1616 integrity check, which hard-blocks a dup/mismatch
// before it can reach CI.

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";

const ids = new Set();
const ID_RE = /(?:^|\/)(\d+)[a-z]?-[^/]*\.md$/;

function addFrom(text) {
  for (const line of text.split("\n")) {
    const m = line.match(ID_RE);
    if (m) ids.add(Number(m[1]));
  }
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

try {
  sh("git fetch origin --quiet");
} catch {
  /* offline */
}

try {
  addFrom(readdirSync("plan/issues").join("\n"));
} catch {
  /* skip */
}

try {
  const refs = sh("git for-each-ref --format='%(refname)' refs/remotes/origin").split("\n").filter(Boolean);
  for (const ref of refs) {
    try {
      addFrom(sh(`git ls-tree -r ${ref} --name-only -- plan/issues`));
    } catch {
      /* skip */
    }
  }
} catch {
  /* no remotes */
}

// Exclude outlier ids separated from the main body by a large gap. A single
// stray out-of-range file (e.g. a mis-typed `6406`/`6407` when the real range
// is ~1800) must not poison `max + 1` and hand out a 6408 — that mis-allocation
// is exactly what #1858 hit. Real issue numbering increments by 1 and never
// jumps more than a few dozen, so anything beyond GAP above the running max is
// treated as a stray and ignored (logged to stderr for visibility).
const GAP = 1000;
const sorted = [...ids].sort((a, b) => a - b);
let max = 0;
const ignored = [];
for (const id of sorted) {
  if (max > 0 && id - max > GAP) {
    ignored.push(...sorted.filter((x) => x >= id));
    break;
  }
  max = id;
}
if (ignored.length) {
  process.stderr.write(
    `next-issue-id: ignoring ${ignored.length} out-of-range stray id(s) ` +
      `(>${GAP} above the contiguous body): ${ignored.join(", ")}\n`,
  );
}
process.stdout.write(`${max + 1}\n`);
