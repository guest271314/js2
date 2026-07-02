---
id: 2842
title: "Stale test: issue-1886 \"classifies every buffer in the native-messaging host as linear-safe\""
status: ready
sprint: Backlog
priority: low
area: tests
task_type: test
related: [389, 1886, 2832, 2778]
---

# Stale `issue-1886.test.ts` native-messaging-host linear-safe assertion

## Problem

`tests/issue-1886.test.ts` has a case — `"classifies every buffer in the
native-messaging host as linear-safe"` — that runs the single-file linear-Uint8
`analyze()` over `examples/native-messaging/nm_js2wasm_node_fs.ts` and asserts it
sees a fixed set of buffer names (`header` / `one` / `tmp` / `buf` / `src`).

That example was refactored (#2778/#2832) to delegate to the shared
`nm_js2wasm_sync_framing` core, so a single-file `analyze()` of `nm_js2wasm_node_fs.ts`
no longer sees those locals — the assertion is **stale and fails identically on
`origin/main`** (confirmed by sdev-2840 with the fix reverted).

It is **not CI-gated** (`quality` runs lint/typecheck/`check:*`, not vitest; the
`linear-tests` job globs only `tests/linear-*.test.ts` and is non-required), so it
went unnoticed.

## Fix

Update the test to the post-refactor reality — either point `analyze()` at the
shared `nm_js2wasm_sync_framing` core (where the buffer locals now live), or
rewrite the assertion against a current host's actual buffer set. Keep it
asserting the linear-safe classification it was written to guard, just against
the right source.

## Acceptance

`npm test -- tests/issue-1886.test.ts` passes; the linear-safe classification of
the native-messaging host buffers is still meaningfully asserted.

## Status note (reconcile 2026-07-02)

No implementation PR has merged for this issue. The only merged PR referencing
it (PR #2327, `chore(plan): close #2829; file #2842/#2843 cleanups`) merely
FILED this issue — do not mistake it for a fix. Stays `ready`.
