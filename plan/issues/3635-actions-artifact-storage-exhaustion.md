---
id: 3635
title: "~985k Actions artifacts accumulated — storage exhaustion, likely cause of the artifact 403s"
status: ready
created: 2026-07-25
priority: high
horizon: s
feasibility: easy
area: ci
goal: ci-hardening
related: [3634, 2547, 2519]
---

# #3635 — ~985k Actions artifacts; storage exhaustion

## The measurement

`GET repos/loopdive/js2/actions/artifacts` reports **`total_count = 984,897`**, with **0
expired** on the sampled page. The most recent 100 artifacts total **120 MB** (~1.2 MB
average).

**DO NOT QUOTE A TOTAL SIZE FROM THAT AVERAGE.** The sampled page is biased — those names
are small `issue-tests-partial-*` files at ~0 MB each, whereas the test262 report/group
artifacts are 15-30 MB. A naive scale gives ~1.2 TB but the true figure could be well
either side. Read the real number from **Settings → Billing → Actions/Packages storage**;
the REST billing endpoints need `admin:org` (the container token has only `gist, read:org,
repo, workflow`).

## Why this is the explanation for the "used up minutes" report

Public repos get **unlimited standard-runner minutes**, and this repo uses only standard
runners — verified: **61× `ubuntu-latest`, 2× `ubuntu-24.04`, zero larger-runner labels**.
All three relevant repos are public (`loopdive/js2`, `ttraenkler/js2`,
`loopdive/js2wasm-baselines`). So it was never minutes.

**Actions artifact STORAGE is billed and enforced regardless of repo visibility.**

## Why it accumulated

The sharded test262 matrix produces **114 jobs per merge_group run**, most uploading
artifacts, and the queue runs many times a day. With default 90-day retention and nothing
pruning, this compounds continuously.

## Suspected knock-on — VERIFY, do not assume

A quota-exceeded state can surface as a 403 on artifact operations. Two failures on
2026-07-24/25 fit that shape:

- **#3566's false park**: `Failed to ListArtifacts: (403) Forbidden` on *"Download shard
  artifacts"*, which skipped the verdict step entirely and parked a healthy PR.
- **The six consecutive baseline-promote failures** (#3634), which also touch
  artifact/storage operations.

If storage exhaustion is the cause, those are **not independent bugs** and #3634's
retry/alerting is treating a symptom. Confirm by checking whether the 403s stop once
storage is reclaimed.

## Fix

1. **Set a short artifact retention** for this repo (Settings → Actions → Artifact and log
   retention). Default is 90 days; for a 114-artifact-per-run matrix, days rather than
   months. Shard artifacts have no value once the merged report exists.
2. Add explicit **`retention-days:`** to the heavy upload steps in `test262-sharded.yml` so
   they self-expire regardless of the repo default.
3. **Bulk-delete the backlog** (`DELETE /repos/{o}/{r}/actions/artifacts/{id}`) — needs
   care and rate-limiting at ~985k objects.
4. **Re-check whether the artifact 403s and promote failures stop** once reclaimed.

## Ruled out (probably) but worth confirming

The org has **41 private repos** sharing the account quota. Nearly all are dormant (last
pushed 2020-2025); the only recent ones are `company-website` (2026-05-20),
`html-device-mockup` (2026-02-25), `cloudflare-worker-openai` (2025-07-26). Private-repo
Actions **do** consume minutes, so glance at their recent run activity before concluding
this is entirely artifacts.
