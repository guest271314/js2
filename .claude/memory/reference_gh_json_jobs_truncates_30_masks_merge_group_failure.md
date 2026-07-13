---
name: reference_gh_json_jobs_truncates_30_masks_merge_group_failure
description: "gh run view --json jobs truncates at 30 jobs; a merge_group run with >30 shards can show 'all jobs success' while a later aggregator job actually FAILED — do not read run health from a truncated jobs list"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

`gh run view <id> -R <repo> --json jobs` returns at most **30 jobs**. The
test262-sharded merge_group runs have ~114 shard jobs + a trailing "merge shard
reports" aggregator. So `--json jobs --jq '[.jobs[]|select(.conclusion=="failure")]'`
can return `[]` ("no failed jobs") on a run whose conclusion is `failure` —
because the failing aggregator job is **past the 30-item truncation window**.

**How this misled a diagnosis (2026-07-05):** #2661's merge_group parked; the
lead read `--json jobs` → 0 failed jobs → hypothesized a **cancellation
artifact** (new PR rebuilt the group, cancelled the in-flight run) rather than a
real regression. WRONG. A proper diagnosis (diag-2661) found the "merge shard
reports" aggregator (a real job, ran 27s) genuinely FAILED the standalone
host-free floor (`pass=20653 < floor=20902`, −299), and a local A/B confirmed
220/220 deterministic failures. The truncation nearly caused a real merged-baseline
regression to be re-admitted as a "false park."

**How to apply:** never conclude "no real failure / it was cancelled" from a
truncated `--json jobs` list on a large merge_group run.
- Check the run **conclusion** itself (`--json conclusion`), not just the jobs slice.
- Pull the **aggregator/floor report artifact** (merge-shard-reports / test262-regressions-report) directly — the host_free_pass floor delta is the authoritative signal.
- A `conclusion=failure` with `[]` failed jobs in the first 30 is a TRUNCATION smell, not a cancellation signal. Cancellations show `conclusion=cancelled`, not `failure`.
- For real vs flake on a standalone floor move: a controlled local A/B (`runTest262File(...,"standalone")` on the flipped candidates, base vs HEAD) is definitive; a host_free_pass FLOOR drop is almost never a flake.

Related: [[project_standalone_floor_only_on_merge_group]], [[reference_standalone_floor_object_identity_and_real_vs_drift]].
