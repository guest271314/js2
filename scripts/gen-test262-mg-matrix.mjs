#!/usr/bin/env node
// gen-test262-mg-matrix.mjs — computes the merge_group-CONSOLIDATED test262
// shard matrix (#3431).
//
// Why merge_group has its own matrix: the queue previously allowed five
// speculative groups to build concurrently. At 114 jobs per group that meant
// up to 570 shard jobs competing for the 120-runner pool; enqueue/dequeue churn
// also invalidated descendant groups and restarted work that could never land.
// The active main ruleset was therefore changed to `max_entries_to_build: 1`.
// With only one stable group in flight, throughput now comes from parallelism
// *inside* that group rather than from keeping the per-group matrix small.
//
// The pool has 120 four-core runners and every shard intentionally uses all
// four cores (`COMPILER_POOL_SIZE=4`). Reserve 14 runners for the overlapping
// CI quality/equivalence jobs, the differential workflow, the Test262 gate,
// and short-lived orchestration jobs. The remaining 106 runners are assigned
// to Test262, so a serial queue entry can use the fleet without starving its
// other required checks.
//
// js-host and standalone get DIFFERENT counts because their measured work is
// not equal. The first 34/19 run after #3470 (merge_group run 29807524490,
// 2026-07-21) started all 53 jobs within one second and measured the `Run shard`
// steps as:
//   js-host:    24,071 runner-seconds total, 818 s max (34 jobs)
//   standalone: 11,284 runner-seconds total, 654 s max (19 jobs)
// The 2.13 work ratio is matched by 72/34 = 2.12. At perfect distribution that
// is about 334 vs. 332 seconds of measured shard work per runner, plus setup
// and tail skew. Both lanes therefore target the same ~6-8 minute window while
// retaining ample margin under the 25-minute job timeout.
//
// The host lane is costlier primarily because both lanes still compile the
// honest full in-Wasm harness, while the host target emits JS/Wasm interop glue.
// In run 29807524490 host compilation totaled 77.7M ms vs. 42.3M ms for
// standalone; execution was only 2.4M vs. 0.7M ms. Host also reaches more
// passing tests and therefore performs more strict-mode recompilations.
//
// The underlying partition (assignBalancedChunk, test262-shared.ts) is a
// pure function of (chunkIndex, totalChunks): it re-derives the FULL test262
// corpus and greedily bin-packs it into `totalChunks` bins by historical
// duration, so it produces a strict, non-overlapping, full-coverage
// partition for ANY totalChunks >= 1 — changing the shard count here cannot
// drop or duplicate tests. See tests/issue-3431-mg-matrix.test.ts for a
// dry-run check of this script's output shape, and
// tests/test262-chunk-dynamic.test.ts for the runtime entry point each
// matrix cell invokes (index/total supplied via env vars instead of being
// baked into a per-shard filename).

export const MERGE_GROUP_RUNNER_CAPACITY = 120;
export const MERGE_GROUP_RESERVED_RUNNERS = 14;
export const JS_HOST_CHUNKS = 72;
export const STANDALONE_CHUNKS = 34;

/**
 * @param {string} targetName matrix job-name suffix, e.g. "js-host"
 * @param {string} test262Target TEST262_TARGET env value, e.g. "gc"
 * @param {string} resultPrefix TEST262_RESULT_PREFIX env value
 * @param {number} chunkTotal number of shards for this target
 */
export function buildTargetEntries(targetName, test262Target, resultPrefix, chunkTotal) {
  const entries = [];
  for (let i = 0; i < chunkTotal; i++) {
    entries.push({
      target_name: targetName,
      test262_target: test262Target,
      result_prefix: resultPrefix,
      chunk_index: i,
      chunk_total: chunkTotal,
      // 1-based label to match the existing test262-chunkN naming convention
      // used by the static (pull_request/push/workflow_dispatch) matrix.
      chunk_label: i + 1,
    });
  }
  return entries;
}

export function buildMergeGroupMatrix() {
  return [
    ...buildTargetEntries("js-host", "gc", "test262", JS_HOST_CHUNKS),
    ...buildTargetEntries("standalone", "standalone", "test262-standalone", STANDALONE_CHUNKS),
  ];
}

function main() {
  const matrix = { include: buildMergeGroupMatrix() };
  const json = JSON.stringify(matrix);
  if (process.argv.includes("--github-output")) {
    // Single-line JSON — safe for a GITHUB_OUTPUT `key=value` assignment.
    console.log(`matrix=${json}`);
  } else {
    console.log(JSON.stringify(matrix, null, 2));
  }
}

// Only run when executed directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
