---
name: reference_standalone_harvest_rootcausemap_mislabeled
description: Standalone test262 harvest — root_cause_map buckets + their issue links are unreliable; bucket from the standalone-current.jsonl signatures instead
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

When re-bucketing standalone test262 failures, do NOT trust the committed report's
`root_cause_map.buckets` (in `public/benchmarks/results/test262-standalone-report.json`):

- **Bucket counts are inflated/mislabeled.** The report builder appends a fixed
  explanation string (e.g. "This is the late-import index-shift class (#2043)…")
  to *every* `index out of range` error, so the `late-import-index-shift` bucket
  showed **691** when the real index-shift CE count on main was ~2. The bucket
  matcher is a broad heuristic, not the actual single-cause cluster.
- **Per-bucket `issues:` links are stale** — most point to already-`done` issues
  even though the tests still fail.

Authoritative source = the **standalone** baseline JSONL, not the report and not
the default/host JSONL:
- Fetch `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl`
  (the `scripts/fetch-baseline-jsonl.mjs` helper fetches the **host/GC** one —
  `test262-current.jsonl` — which is NOT standalone; `scripts/compiler-fork-worker.mjs`
  compiles without `target:"standalone"`, so the host JSONL disagrees with standalone CEs).
- Bucket by the `error`/`error_signature` field. Real top standalone CE clusters
  (current main 2026-06-18): `Cannot convert object to primitive` ~3738 (#1917, in-flight),
  `X.prototype built-in static property value read` ~2551 (#2175 owned by se-2175,
  partly #1696), `invalid Wasm binary` ~1641 (heterogeneous codegen-correctness tail),
  `dynamic-shape object/property` ~1235 (#1472), `Array.prototype.X.call over array-like`
  ~687 (#2036 in-progress).

To repro a single standalone CE locally: `compile(wrapTest(src, parseMeta(src)).source,
{target:"standalone", skipSemanticDiagnostics:true})` and inspect `result.errors`
(severity==="error") — standalone refusals are reported on the result, NOT thrown;
only `Binary emit error`s throw. See [[reference_string_global_sentinel_guard]].

**Ad-hoc compile-harvest labels lie too (sprint 63→64, 2026-06-19).** Not just the
committed report — an agent's own ad-hoc "group failing files by error string" harvest
mis-attributes root cause the same way. Two tasks derived from such labels
(`Missing import BigInt64Array_new` ×4, `native generator non-sequential yield` ×8) were
BOTH already-done-on-main: the named import was a *symptom string*, the real CE in those
files was the #2175 `Symbol.iterator`/`Int8Array.prototype` value-read cluster. Before
tasking ANY harvest-derived lever, re-verify a representative repro STILL CEs on current
main (substrate moves constantly — #2026 etc. silently close clusters). Cheap rule that
saved the window: agents `measure-first` each assignment and report `already-on-main` →
close the task, don't implement. The authoritative cluster list above is a better compass
than a fresh ad-hoc harvest, BUT also has stale issue links — verify-still-fails first.
