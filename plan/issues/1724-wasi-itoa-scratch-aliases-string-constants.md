---
id: 1724
title: "WASI number formatting corrupts string constants (itoa scratch aliases data segments)"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: wasi, native-strings, number-to-string
goal: real-world-compat, spec-completeness
sprint: 57
parent: 389
related: [389, 1618, 1651, 1723]
reporter: guest271314
---
# #1724 — WASI number formatting corrupts string constants (silent data corruption)

## Problem

Reported by guest271314 against the Native Messaging host (parent #389), tested
in WASI/standalone mode. The host's debug line mutated its OWN string literal
across loop iterations:

```
[host] received 65 chars ...     (correct, 1st)
[host] re61ived 10 chars ...     ← "ce" overwritten by "61"
[host] re16ived 6 chars ...
[host] re12ived 5 chars ...
```

The digits of the *previously-formatted* number overwrote the `"ce"` inside the
literal `"received"` in the template `` `[host] received ${n} chars` ``. This is
**silent data corruption** — the highest-severity class of bug — and is general,
not native-messaging-specific.

### Minimal repro (independent of host.ts)

```ts
export function main(): void {
  let i = 0;
  while (i < 5) {
    const n = 60 + i;
    console.error(`[host] received ${n} chars`);
    i = i + 1;
  }
}
```

Compiled with `--target wasi`, stderr was:
```
[host] received 60 chars[host] re60ived 61 chars[host] re61ived 62 chars...
```
The `"received"` literal is clobbered at byte offsets 9/10 (its `c`/`e`).

## Root cause

The WASI integer-formatting helper `__wasi_write_i32` (and its `_stderr`
variant) wrote its itoa digit buffer using `global.get $__wasi_bump_ptr` as the
scratch base. That global **initialises to 1024**:

```
(global $__wasi_bump_ptr (mut i32) (i32.const 1024))
```

But string-literal data segments are *also* bump-allocated from offset **1024**
upward (`wasiAllocStringData` in `src/codegen/expressions/builtins.ts` starts at
1024 and grows). The bump pointer is never advanced past the data segments, so:

- data segment `"[host] received "` occupies bytes **1024..1039**
- itoa scratch = `buf_start(1024) .. buf_start+11(1035)`, digits written
  right-to-left into ~1033..1035

Formatting a number wrote its ASCII digits straight into the middle of the first
string literal (`c`@1033, `e`@1034 → `6`,`0`). The two regions shared base 1024.

This is the same family as #1618 (stdin buffer aliasing data segments, fixed by
moving stdin to page 1) — the data/scratch collision was simply never closed for
the itoa path.

## Fix

`src/codegen/expressions/builtins.ts` — `ensureWasiWriteI32Helper`:
anchor the itoa scratch to the reserved low-scratch region instead of the bump
pointer:

```ts
const WASI_ITOA_SCRATCH = 16; // above iovec(0..7)/nwritten(8..11), below
                              // Math.random's offset-64 scratch, < 1024
// buf_start = WASI_ITOA_SCRATCH  (was: global.get $__wasi_bump_ptr → 1024)
```

Offset 16 lives inside the 0..1023 area `registerWasiImports` reserves below the
first data segment (which starts at 1024). It is above the iovec/nwritten that
`__wasi_write_string` populates at memory[0..11], and `__wasi_write_string` sets
its iovec at memory[0] *after* the digits are staged here and points the iovec
back at this buffer, so there is no overlap during the write. 16 bytes covers the
worst case (11 digits of a 32-bit int + sign).

The f64 formatter routes through the i32 formatter (`i32.trunc_sat_f64_s; call
__wasi_write_i32`), so fixing i32 fixes both.

## Tests

`tests/issue-1724.test.ts` — drives compiled WASI modules through a custom
fd_write capture and asserts:
- the `"received"` literal survives 5 interleaved number formats byte-for-byte
  (and never matches `/re\d/`),
- zero / negative / INT_MAX / large ints don't touch the surrounding literal,
- a number written between two literals leaves both intact.

## Result

Fixed. stderr is now `[host] received 60 chars\n[host] received 61 chars\n...`
with the literal intact across all iterations.

## Notes

- Does NOT share a root cause with #1723 (writeMessage cast failure). #1723 is a
  `ref.cast` of a ConsString + a fixed-staging-buffer overflow; #1724 is an
  itoa-scratch / data-segment memory aliasing. They were fixed together in one
  PR but are independent bugs.
