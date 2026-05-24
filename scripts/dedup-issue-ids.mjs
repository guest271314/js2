#!/usr/bin/env node
// One-shot: resolve the duplicate issue IDs blocking the flat layout (#1616).
//
// Two operations, per the signed-off decision table:
//   RM       — git rm a stale same-issue duplicate copy.
//   RENUMBER — git mv a genuine collision to a fresh id, rewrite its `id:`
//              frontmatter, add `renumbered_from:`, rename any tests/issue-<old>*
//              file, and fix in-repo `#<old>` link references where they point
//              at the renumbered issue.
//
// Fresh ids are allocated from FREE_POOL_BASE upward in the order listed.
// Idempotent enough to re-run after a fetch+merge: it skips RMs whose source
// is already gone and RENUMBERs whose source is already gone.
//
// Usage: node scripts/dedup-issue-ids.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const FREE_POOL_BASE = 1619;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}
function abs(rel) {
  return join(ROOT, rel);
}

// ── Decision table ─────────────────────────────────────────────────────────
// Class A: remove the stale copy.
const RM = [
  "plan/issues/sprints/47/1278.md", // number-only stub; keep 1278-update-stale-lodash…
  "plan/issues/backlog/1130-array-methods-getter-observing-property.md", // keep sprints/55 (escalated)
  "plan/issues/backlog/1154-test262-worker-array-prototype-poisoning.md", // keep sprints/50 (done)
  "plan/issues/backlog/1307-ci-test262-global-concurrency.md", // keep sprints/50 (done)
  "plan/issues/sprints/50/1310-vm-sandbox-test262-isolation.md", // keep 1310-vm-sandbox-isolation-test262
  "plan/issues/sprints/50/1292-lodash-tier2-stress-test.md", // keep sprints/48 (richer/original)
];

// Class B + new #1617 + the spec-gap off-by-one block.
// `keptId` is informational (the surviving file for that number). `src` is the
// file being renumbered; it receives a fresh id from the pool, in list order.
const RENUMBER = [
  // ── Standalone Class-B collisions ──
  { src: "plan/issues/sprints/48/1295-lodash-init-start-function-throw.md", oldId: 1295 },
  { src: "plan/issues/sprints/56/1323-iterator-result-struct-runtime-wiring.md", oldId: 1323 },
  { src: "plan/issues/sprints/52/1392-refresh-benchmarks-browser-runtime-hang.md", oldId: 1392 },
  { src: "plan/issues/sprints/52/1396-forof-dstr-externref-array-default.md", oldId: 1396 },
  { src: "plan/issues/backlog/1522-codegen-invalid-wasm-type-coercion-boundaries.md", oldId: 1522 },
  { src: "plan/issues/backlog/1552-tagged-union-value-rep-retire-box-unbox-typeof.md", oldId: 1552 },
  { src: "plan/issues/sprints/53/779-820-cluster-decomposition.md", oldId: 779 },
  { src: "plan/issues/backlog/1353-spec-backlog-memory-model.md", oldId: 1353 },
  // #1352 three-way: keep backlog/regexp-exec (completed-task identity), renumber set-methods.
  { src: "plan/issues/sprints/50/1352-spec-gap-set-methods-set-like-arg.md", oldId: 1352 },
  // New live #1617: keep rendercal (work+test), renumber dev-1530 stub.
  { src: "plan/issues/backlog/1617-wasi-raw-byte-stdout.md", oldId: 1617 },
  // ── Spec-gap off-by-one block: renumber the losing twin of each slug ──
  // (kept ids: 1334,1336-1350,1352; these are the duplicate-batch twins)
  { src: "plan/issues/sprints/50/1335-spec-gap-object-defineproperty-descriptor-attributes.md", oldId: 1335 },
  { src: "plan/issues/sprints/50/1335-spec-gap-object-assign-getter-iteration.md", oldId: 1335 },
  { src: "plan/issues/sprints/50/1337-spec-gap-object-create-properties-map.md", oldId: 1337 },
  { src: "plan/issues/sprints/50/1338-spec-gap-function-bind-tostring-internals.md", oldId: 1338 },
  { src: "plan/issues/sprints/50/1339-spec-gap-array-from-of-construct.md", oldId: 1339 },
  { src: "plan/issues/sprints/50/1340-spec-gap-aggregate-suppressed-error-iterable.md", oldId: 1340 },
  { src: "plan/issues/sprints/50/1341-spec-gap-iterator-helpers-wasm-compile.md", oldId: 1341 },
  { src: "plan/issues/sprints/50/1341-spec-gap-json-stringify-replacer-tojson.md", oldId: 1341 },
  { src: "plan/issues/sprints/50/1343-spec-gap-boolean-symbol-coercion.md", oldId: 1343 },
  { src: "plan/issues/sprints/50/1344-spec-gap-date-prototype-formatters.md", oldId: 1344 },
  { src: "plan/issues/sprints/50/1345-spec-gap-generator-prototype-receiver-checks.md", oldId: 1345 },
  { src: "plan/issues/sprints/50/1346-spec-gap-reflect-internal-method-mirror.md", oldId: 1346 },
  { src: "plan/issues/sprints/50/1347-spec-gap-yield-in-try-finally.md", oldId: 1347 },
  { src: "plan/issues/sprints/50/1348-spec-gap-for-of-iterator-close-on-throw.md", oldId: 1348 },
  { src: "plan/issues/sprints/50/1349-spec-gap-class-static-init-and-private-fields.md", oldId: 1349 },
  { src: "plan/issues/sprints/50/1350-spec-gap-bigint-typed-paths.md", oldId: 1350 },
  { src: "plan/issues/sprints/50/1351-spec-gap-arraybuffer-resizable-and-typedarray-detached.md", oldId: 1351 },
  { src: "plan/issues/sprints/50/1351-spec-gap-set-methods-set-like-arg.md", oldId: 1351 },
  // ── Anchor collisions: two distinct kept slugs share a number. Renumber the
  //    lower-information member; keep the spec-gap-series / work-bearing one. ──
  { src: "plan/issues/sprints/50/1334-ecmascript-spec-compliance-audit.md", oldId: 1334 }, // keep spec-gap-object-defineproperty@1334
  { src: "plan/issues/sprints/50/1336-spec-gap-object-create-properties-map.md", oldId: 1336 }, // keep object-assign@1336 (IMPL+TEST)
  { src: "plan/issues/sprints/50/1342-spec-gap-boolean-symbol-coercion.md", oldId: 1342 }, // keep json-stringify-replacer@1342 (IMPL+TEST)
];

// ── Execute RMs ────────────────────────────────────────────────────────────
let rmDone = 0;
for (const rel of RM) {
  if (!existsSync(abs(rel))) {
    console.log(`  RM skip (already gone): ${rel}`);
    continue;
  }
  if (!dryRun) git(["rm", "--quiet", rel]);
  rmDone++;
  console.log(`  RM ${rel}`);
}

// ── Execute RENUMBERs ──────────────────────────────────────────────────────
let nextId = FREE_POOL_BASE;
const renumberMap = []; // { oldId, newId, src, dst }
for (const r of RENUMBER) {
  if (!existsSync(abs(r.src))) {
    console.log(`  RENUMBER skip (source gone): ${r.src}`);
    continue;
  }
  const newId = nextId++;
  // Build the new basename: <newId>-<old-slug>.md (keep slug). Strip only the
  // leading `<id>-` or `<id>.`, preserving slugs that themselves start with a
  // number (e.g. 779-820-cluster… → slug "820-cluster…").
  const base = r.src.split("/").pop();
  const slug = base.replace(/^\d+[a-z]?[-.]/, "").replace(/\.md$/, "");
  const newBase = slug ? `${newId}-${slug}.md` : `${newId}.md`;
  const dstRel = r.src.replace(/[^/]+$/, newBase);
  renumberMap.push({ oldId: r.oldId, newId, src: r.src, dst: dstRel });

  if (!dryRun) {
    git(["mv", r.src, dstRel]);
    // Rewrite frontmatter id + add renumbered_from.
    let text = readFileSync(abs(dstRel), "utf8");
    text = text.replace(/^id:\s*.+$/m, `id: ${newId}`);
    if (/^renumbered_from:/m.test(text)) {
      text = text.replace(/^renumbered_from:\s*.+$/m, `renumbered_from: ${r.oldId}`);
    } else {
      // Insert after the id line, matching ORDERED_KEYS placement (after goal/sprint).
      text = text.replace(/^(id:\s*\d+[a-z]?\n)/m, `$1renumbered_from: ${r.oldId}\n`);
    }
    writeFileSync(abs(dstRel), text);
  }
  console.log(`  RENUMBER #${r.oldId} → #${newId}: ${r.src} → ${dstRel}`);
}

// ── Rename associated test files + rewrite #<old> link refs ────────────────
// Only for renumbered issues whose old id has a dedicated test file AND where
// the renumbered file (not the kept twin) is the one the test belongs to.
// Per sign-off: tests/issue-1352.test.ts → tests/issue-<set-methods-new>.test.ts.
const TEST_RENAMES = [];
for (const m of renumberMap) {
  // set-methods (#1352) test file follows the renumbered set-methods issue.
  if (m.oldId === 1352 && m.src.includes("set-methods")) {
    TEST_RENAMES.push({
      old: "tests/issue-1352.test.ts",
      new: `tests/issue-${m.newId}.test.ts`,
      oldId: 1352,
      newId: m.newId,
    });
  }
}
for (const t of TEST_RENAMES) {
  if (!existsSync(abs(t.old))) {
    console.log(`  TEST skip (gone): ${t.old}`);
    continue;
  }
  if (!dryRun) {
    git(["mv", t.old, t.new]);
    let text = readFileSync(abs(t.new), "utf8");
    text = text.replaceAll(`#${t.oldId}`, `#${t.newId}`).replaceAll(`issue-${t.oldId}`, `issue-${t.newId}`);
    writeFileSync(abs(t.new), text);
  }
  console.log(`  TEST RENAME ${t.old} → ${t.new}`);
}

console.log(`\ndedup-issue-ids — ${dryRun ? "DRY RUN" : "applied"}`);
console.log(`  removed: ${rmDone}`);
console.log(`  renumbered: ${renumberMap.length}  (ids ${FREE_POOL_BASE}..${nextId - 1})`);
console.log(`  test files renamed: ${TEST_RENAMES.length}`);
