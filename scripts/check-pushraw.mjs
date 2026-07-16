#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2953 — BackendEmitter.pushRaw escape-hatch ratchet.
//
// The default gate is change-scoped: compare src/ir/lower.ts with this
// change-set's own git base and reject every newly-added `pushRaw(` call that
// does not carry `// pushraw-ok(#NNNN)` on the same or immediately preceding
// line. Tagged additions are explicit, reviewable debt; untagged additions are
// never allowed, even when another raw site is removed in the same change.
//
// The committed baseline is the whole-tree fallback and count dashboard. It
// records the untagged legacy residue, while tagged sites are excluded from the
// debt ceiling. `--update-on-decrease` can therefore bank removal of a legacy
// site even if the same change adds a reviewed, tagged escape hatch.
//
// Usage:
//   node scripts/check-pushraw.mjs
//   node scripts/check-pushraw.mjs --all
//   node scripts/check-pushraw.mjs --update
//   node scripts/check-pushraw.mjs --update-on-decrease
//   node scripts/check-pushraw.mjs --json

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { baseBlob, resolveChangeBase } from "./lib/change-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const TARGET = "src/ir/lower.ts";
const TARGET_PATH = join(REPO_ROOT, TARGET);
const BASELINE_PATH = join(HERE, "pushraw-baseline.json");

const PUSHRAW_RE = /\bpushRaw\s*\(/g;
const TAG_RE = /\/\/\s*pushraw-ok\(#([1-9]\d*)\)(?:\s*:\s*[^\r\n]+)?/;

function tagOn(line) {
  const match = line?.match(TAG_RE);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Return every textual `pushRaw(` call and its adjacent justification. */
export function scanPushRaw(source) {
  const lines = source.split(/\r?\n/);
  const sites = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    PUSHRAW_RE.lastIndex = 0;
    for (const match of line.matchAll(PUSHRAW_RE)) {
      const issue = tagOn(line) ?? tagOn(lines[index - 1]);
      sites.push({
        line: index + 1,
        column: match.index + 1,
        issue,
        tagged: issue !== undefined,
        source: line.trim(),
      });
    }
  }

  return {
    sites,
    total: sites.length,
    tagged: sites.filter((site) => site.tagged).length,
    untagged: sites.filter((site) => !site.tagged).length,
  };
}

/** Parse the new-side line numbers from a zero-context unified diff. */
export function addedLineNumbers(diff) {
  const added = new Set();
  let newLine;

  for (const line of diff.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (newLine === undefined || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.add(newLine);
      newLine++;
    } else if (line.startsWith(" ")) {
      newLine++;
    }
    // A removed line has no position on the new side.
  }

  return added;
}

/** Pure fixture evaluator used by the focused #2953 tests. */
export function evaluatePushRawChange(baseSource, currentSource, addedLines) {
  const base = scanPushRaw(baseSource);
  const current = scanPushRaw(currentSource);
  const added = current.sites.filter((site) => addedLines.has(site.line));
  const untaggedAdded = added.filter((site) => !site.tagged);
  const growth = current.total - base.total;
  const unattributedGrowth = Math.max(0, growth - added.length);

  return {
    ok: untaggedAdded.length === 0 && unattributedGrowth === 0,
    base,
    current,
    added,
    untaggedAdded,
    growth,
    unattributedGrowth,
  };
}

function gitDiff(base) {
  return execFileSync("git", ["diff", "--unified=0", "--no-ext-diff", "--no-renames", base, "--", TARGET], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return undefined;
  }
}

function baselineFor(scan) {
  return {
    generated: new Date().toISOString().slice(0, 10),
    path: TARGET,
    total: scan.total,
    tagged: scan.tagged,
    untagged: scan.untagged,
  };
}

function writeBaseline(scan) {
  writeFileSync(BASELINE_PATH, JSON.stringify(baselineFor(scan), null, 2) + "\n", "utf-8");
}

function formatSite(site) {
  return `  ${TARGET}:${site.line}:${site.column}  ${site.source}`;
}

function failChanged(result) {
  const lines = ["pushRaw ratchet FAILED (#2953):"];
  if (result.untaggedAdded.length > 0) {
    lines.push("", "New BackendEmitter escape hatches require an issue tag:");
    lines.push(...result.untaggedAdded.map(formatSite));
  }
  if (result.unattributedGrowth > 0) {
    lines.push("", `Could not attribute ${result.unattributedGrowth} added call site(s) to the working-tree diff.`);
  }
  lines.push(
    "",
    "Route the operation through a typed BackendEmitter method. If raw emission",
    "is temporarily unavoidable, add a reviewed justification on the same or",
    "immediately preceding line:",
    "",
    "  // pushraw-ok(#3296): rejected by non-Wasm backend legality",
    "  emitter.pushRaw(out, op);",
  );
  console.error(lines.join("\n"));
  process.exitCode = 1;
}

function run() {
  const args = new Set(process.argv.slice(2));
  const update = args.has("--update");
  const updateOnDecrease = args.has("--update-on-decrease");
  const auditAll = args.has("--all");
  const json = args.has("--json");
  const currentSource = readFileSync(TARGET_PATH, "utf-8");
  const current = scanPushRaw(currentSource);

  if (json) {
    console.log(JSON.stringify({ path: TARGET, ...current }, null, 2));
    return;
  }

  if (update) {
    writeBaseline(current);
    console.log(
      `pushRaw baseline updated — total=${current.total}, tagged=${current.tagged}, untagged=${current.untagged}.`,
    );
    return;
  }

  if (!auditAll && !updateOnDecrease) {
    const { base, how } = resolveChangeBase(REPO_ROOT);
    if (base) {
      const baseSource = baseBlob(REPO_ROOT, base, TARGET) ?? "";
      const result = evaluatePushRawChange(baseSource, currentSource, addedLineNumbers(gitDiff(base)));
      if (!result.ok) {
        failChanged(result);
        return;
      }
      console.log(
        `pushRaw ratchet: OK — ${current.total} call sites ` +
          `(${result.growth >= 0 ? "+" : ""}${result.growth} vs ${how}; ` +
          `${result.added.length} added, ${result.added.filter((site) => site.tagged).length} tagged).`,
      );
      return;
    }
  }

  const baseline = loadBaseline();
  if (!baseline || baseline.path !== TARGET || !Number.isInteger(baseline.untagged)) {
    console.error(`pushRaw ratchet: missing/invalid ${BASELINE_PATH}; run with --update to seed it.`);
    process.exitCode = 1;
    return;
  }
  if (current.untagged > baseline.untagged) {
    console.error(
      `pushRaw ratchet FAILED (#2953): untagged escape hatches grew ` + `${baseline.untagged} -> ${current.untagged}.`,
    );
    process.exitCode = 1;
    return;
  }
  if (updateOnDecrease && current.untagged < baseline.untagged) {
    writeBaseline(current);
    console.log(
      `pushRaw baseline ratcheted down — untagged ${baseline.untagged} -> ${current.untagged} ` +
        `(total=${current.total}, tagged=${current.tagged}).`,
    );
    return;
  }
  console.log(
    `pushRaw ratchet: OK (whole-tree${auditAll ? " --all" : ""}) — ` +
      `total=${current.total}, tagged=${current.tagged}, untagged=${current.untagged} ` +
      `(baseline untagged=${baseline.untagged}).`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) run();
