---
id: 2843
title: "Uint8Array.subarray WASI-write illegal cast (issue-1655)"
status: ready
sprint: Backlog
priority: low
area: codegen
task_type: bug
related: [389, 1655, 2835]
---

# `Uint8Array.subarray` WASI write → `illegal cast`

## Problem

A pre-existing failure surfaced during the #2835 i8-pack work (sdev-2835p2): one
`tests/issue-1655` case — a `Uint8Array.subarray` followed by a WASI write —
fails at runtime with an `illegal cast`. It reproduces **identically on a clean
`origin/main` worktree** (with and without the #2835 change), so it is **not** a
regression from the byte-buffer packing — it is a standalone, pre-existing bug in
the `subarray`-view → WASI-write path.

## Investigate / fix

Trace the `subarray` view's backing + the cast emitted on the WASI write path
(`fd_write` / the linear-Uint8 or byte-buffer write helpers). A `subarray`
returns a view sharing the parent's backing at an offset; the WASI write likely
casts the view to a concrete array type that doesn't match the (now packed `i8`,
post-#2835) byte-buffer rep or the view wrapper. Confirm whether it predates
#2835 entirely (it does, per the clean-main repro) and fix the cast.

## Acceptance

The `issue-1655` `Uint8Array.subarray` WASI-write case passes; no regression to
other `subarray`/typed-array WASI paths.

## Status note (reconcile 2026-07-02)

No implementation PR has merged for this issue. The only merged PR referencing
it (PR #2327, `chore(plan): close #2829; file #2842/#2843 cleanups`) merely
FILED this issue — do not mistake it for a fix. Stays `ready`.
