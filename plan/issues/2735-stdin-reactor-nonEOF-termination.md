---
id: 2735
title: "WASI process.stdin reactor HANGS when stdin stays open — no non-EOF termination trigger (process.exit/.destroy/in-band shutdown)"
status: done
created: 2026-06-27
completed: 2026-06-27
assignee: ttraenkler/sdev-2735-stdin-exit
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: n/a
language_feature: wasi, process.stdin, event-loop
goal: standalone-wasi
related: [389, 2632, 2123, 2683]
sprint: 66
---

# #2735 — stdin reactor non-EOF termination

## Problem

`nm_node_process.ts --target wasi` HANGS when stdin stays open — the real
Native-Messaging case, where the peer keeps the port (pipe) OPEN for the
lifetime of the connection and signals end-of-conversation IN BAND (a
zero-length frame) rather than by closing the pipe. The program blocks forever
in `poll_oneoff` (0 CPU — cleanly blocked, NOT a busy-wait), because the #2632
fd-readiness reactor's ONLY termination trigger is stdin EOF.

This is distinct from `--target node` and from #2646.

## Root cause (verified)

`buildRunLoopBodyWithFdReactor` (`src/codegen/async-scheduler.ts`) exits only when
`pending = (nextTimer != I64_MAX) | fd0_active` becomes false. `fd0_active`
(`state.stdinFdActiveGlobalIdx`) was cleared in EXACTLY ONE place — the 0-byte
`fd_read` (EOF) in `buildStdinDrainBody`. So the program could ONLY terminate via
stdin EOF. `process.stdin.pause()` (`src/process-stdin-prelude.ts`) just flips a
`paused` flag; there was no `.destroy()` and `process.exit()`'s WASI lowering
(`proc_exit`) was not paired with a subscription drop. The example's zero-length
"clean shutdown" frame set `stopped=true` but never dropped the fd0 subscription,
so the reactor kept blocking.

Exit-on-EOF was already CORRECT and is untouched; the fix ADDS a non-EOF
termination trigger.

## Fix

1. **Reactor escape hatch** (`async-scheduler.ts`): new `emitStdinStop()` (backs the
   `__wasiStdinStop()` intrinsic) clears `__stdin_fd_active` (mirrors the EOF
   clear), so the next `pending` test falls through and `_start` returns cleanly
   even though stdin never reached EOF. `isStdinReactorActive()` lets callers gate
   on the reactor being active. `__wasiStdinStop` added to the
   `needsStdinReactor` detection list in `codegen/index.ts`; the intrinsic is
   lowered in `expressions/calls.ts`.
2. **Wire it** (`process-stdin-prelude.ts`): the library `Readable` gains a faithful
   `destroy()` → `__wasiStdinStop()` (drops the subscription, emits `'close'`
   once, suppresses further events; `pause()` alone still keeps stdin subscribed
   so a data-listening program stays alive — Node parity). The WASI `process.exit`
   lowering now drops the fd0 subscription (when the reactor is active) BEFORE
   `proc_exit(code)`; a `process.exit`-only program (no stdin) is NOT forced to
   wire the reactor.
3. **Example** (`examples/native-messaging/nm_node_process.ts`): on the zero-length
   shutdown frame, call `process.stdin.destroy()`; header documents the standalone
   clean-shutdown-without-EOF path.

## Tests

`tests/issue-2735-stdin-nonEOF-termination.test.ts` (wasmtime-gated runtime cases +
always-on compile cases): open-stdin + in-band shutdown frame exits cleanly and
echoes byte-exact; `process.exit()` with stdin held open exits cleanly; EOF cases
stay green; `nm_node_process.ts` still imports only `wasi_snapshot_preview1`; a
`process.exit`-only program does not wire the reactor. A control program with no
escape hatch was verified to hang (the gap the prior suite missed: it only fed
bounded buffers that close stdin/EOF).

## Validation

- New test (6 cases) green; `native-messaging-comparison`, `issue-2632-phase2/3`,
  `wasi-stdin`, `issue-1411` suites green.
- tsc + lint clean; prettier applied.
