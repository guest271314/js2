---
id: 1652
title: "Fix native-messaging README build command (npx js2wasm not found on fresh clone)"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: low
task_type: docs
area: [docs, examples]
sprint: 55
related: [1530, 1590]
---
# Fix native-messaging README build command

## The bug

`examples/native-messaging/README.md` "Build to `.wasm`" section instructed
the user to run:

```
npx js2wasm examples/native-messaging/host.ts --target wasi -o examples/native-messaging/out
```

This FAILS on a fresh clone with `sh: 1: js2wasm: not found`. The package is
`@loopdive/js2`; its `js2wasm` bin points at `./dist/cli.js`, which does NOT
exist until `pnpm run build` is run (and even then resolves only via `npm
link` or an npm publish). A user who just cloned and ran `pnpm install` has no
`js2wasm` on PATH.

## The fix

The "Build to `.wasm`" block now LEADS with the from-source invocation, which
works immediately after `pnpm install` with zero build step:

```
mkdir -p examples/native-messaging/out
npx tsx src/cli.ts examples/native-messaging/host.ts --target wasi -o examples/native-messaging/out
```

A short note documents the `js2wasm` bin as the alternative once the package is
built (`pnpm run build`) or installed from npm. The `run.sh` "build it first"
error hint carried the same stale `npx js2wasm` command and was fixed to match.

Out of scope (left unchanged): `host.ts`, `manifest.json`, the smoke test, and
`run.sh`'s `wasmtime` runtime invocation.

## Context

Part of the first-5-min UX thread (#1590) — a fresh-clone user following the
example README should hit zero "command not found" walls. Related to the IR /
example-surface work tracked under #1530.

## Test Results

Verified from a fresh worktree after the doc change:

```
$ mkdir -p examples/native-messaging/out
$ npx tsx src/cli.ts examples/native-messaging/host.ts --target wasi -o examples/native-messaging/out
… examples/native-messaging/out/host.wasm  (7438 bytes)
```

The module compiles and emits `host.wasm` with no build step. The `out/` dir is
gitignored and not committed.
