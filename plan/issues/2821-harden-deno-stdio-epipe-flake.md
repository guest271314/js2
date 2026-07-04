---
id: 2821
title: "Harden the flaky EPIPE in tests/issue-2684-deno-stdio.test.ts"
status: done
sprint: 69
priority: medium
area: tests
task_type: test
related: [389, 2684]
completed: 2026-06-29
---

# Harden the flaky EPIPE in `tests/issue-2684-deno-stdio.test.ts`

## Problem

`tests/issue-2684-deno-stdio.test.ts` drives a `--target wasi` Deno
Native-Messaging host through real `wasmtime` via `execFileSync`, streaming the
framed input over `{ input }` (a parent-owned stdin pipe). It intermittently
fails with `EPIPE` on the write to wasmtime's stdin, more often under box load.

This is a **test-harness flake, not a host/compiler bug.** The host
round-trips deterministically — it passed 20× back-to-back under load on
wasmtime v44 and v46. The `EPIPE` is the vitest/`execFileSync` harness racing
wasmtime's stdin pipe: a pure-WASI command that hits EOF (`readSync` → `null`)
or finishes echoing can close fd 0 *before* the parent finishes writing the
input frame, so the parent's write end breaks (`EPIPE`). Box load widens the
race window.

## Fix

Test-infra robustness only — no host or codegen change.

Feed wasmtime's stdin from a **regular file** (written to the temp dir, opened
read-only, handed to the child as fd 0 via `stdio: [inFd, "pipe", "inherit"]`)
instead of streaming `input` over a parent-owned pipe. A file fd has no
parent-side write end, so there is no pipe to break — EOF is the natural end of
the file and the race is eliminated. `execFileSync` is synchronous, so the
wasmtime invocations remain serialized (one spawn at a time, never
oversubscribed).

Assertion semantics are unchanged: the same byte-exact round-trip checks run
against the real wasmtime execution; only the stdin plumbing changed.

## Verification

- `npm test -- tests/issue-2684-deno-stdio.test.ts` run repeatedly (10×, and
  under background load) passes every time with no `EPIPE`.
- The test still exercises the real wasmtime round-trip (it is not weakened into
  a no-op).
