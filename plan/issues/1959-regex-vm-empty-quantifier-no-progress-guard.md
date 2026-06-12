---
id: 1959
title: "native RegExp VM: empty-body quantifier loops burn the 1M-step cap and silently report no-match (/(?:a?)*/ fails)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: regexp
goal: standalone-mode
related: [1909, 1911, 1912, 1539, 1960]
origin: "2026-06-10 deep-audit sweep (strings agent): verified on main, standalone backend"
---

# #1959 — RegExp quantifier lowering lacks the RepeatMatcher empty-iteration progress guard

## Problem

ES2024 [§22.2.2.3.1 RepeatMatcher](https://tc39.es/ecma262/#sec-runtime-semantics-repeatmatcher-abstract-operation):
if min=0 and an iteration consumes nothing, the iteration fails (loop exits).
The compiled VM has no such guard: a nullable quantifier body loops pushing
backtrack frames until the 1,000,000-step cap, and the cap exhaustion is
reported as **"no match"** — a silent wrong answer plus a multi-second perf
cliff at every scan position.

## Repro (verified on main, `--target standalone`)

```ts
export function test(): boolean { return /(?:a?)*/.test("b"); }
```

wasm: `false` (≈3s runtime) — node: `true` (empty match at 0).
`/(a?)*x/.test("bbb")` returns the right value but takes ~1s.

## Root cause

`src/codegen/regex/compile.ts:123-137` — `star` lowers to
`L1: SPLIT body,exit; body; JMP L1` with no empty-iteration progress check.
Step-cap exhaustion: `runAt` returns null = "no match"
(`src/codegen/regex/vm.ts:85`, mirrored in the Wasm VM at
`src/codegen/native-regex.ts:753-758`).

## Fix direction

Standard PROGRESS/empty-check opcode: at loop re-entry compare sp with the sp
recorded at iteration start; if equal, fail that iteration (take the exit
arm). Eliminates both the wrong result and the step-cap burn. Apply to
star/plus/repeat with nullable bodies. Separately consider making cap
exhaustion a thrown error rather than a silent no-match.

## Acceptance criteria

- `/(?:a?)*/.test("b") === true`, fast
- `/(a?)*x/.test("bbb")` fast
- Greedy/lazy quantifier backtracking unregressed (RegExp test262 buckets
  net non-negative)

## Dupe check

#1909/#1911/#1912/#1914 catalog refusals/unsupported features; #1539 covers
empty-match lastIndex advance and split separators — nothing about the
quantifier-empty-body loop in the VM.

## Resolution (2026-06-12)

Added a `PROGRESS` opcode (`ReOp.PROGRESS = 13`) implementing the RepeatMatcher
empty-iteration guard. The compiler allocates one **scratch capture slot** per
nullable star/plus, appended after the real capture slots (`nScratch` on
`CompiledRegex` / the `$NativeRegExp` struct). The loop records `sp` at each
iteration's entry via `SAVE scratch`; after the body, `PROGRESS scratch` fails
the iteration when `sp` is unchanged (empty match), so backtracking takes the
quantifier's exit arm instead of re-entering forever.

- **Nullability** decided at compile time by `canMatchEmpty` (over-approximating
  — unknown shapes default to nullable, only adding a cheap guard). Non-nullable
  quantifiers allocate no scratch slot and emit the original tight encoding, so
  the common case is byte-for-byte unchanged.
- **Plus** keeps its mandatory first match unguarded (min=1) and lowers the
  remaining repetitions as a guarded star, so an empty first match (e.g.
  `(a?)+` on `"b"`) still succeeds.
- Threaded `nScratch` through the caps-array sizing at every VM entry point:
  the search/exec path plus the `__regex_replace` / `__regex_split` /
  `__regex_match_all` helpers (caps array is now `2*nGroups + nScratch`).

### Files

- `src/codegen/regex/bytecode.ts` — `ReOp.PROGRESS`, `CompiledRegex.nScratch`
- `src/codegen/regex/compile.ts` — `canMatchEmpty`, scratch allocation, guarded
  star/plus lowering
- `src/codegen/regex/vm.ts` — reference VM `PROGRESS` dispatch + `nScratch` slot
- `src/codegen/native-regex.ts` — Wasm VM `progressArm()` dispatch; `nScratch`
  param on replace/split/match_all
- `src/codegen/regexp-standalone.ts` — `nScratch` struct field + `pushNSlots`

## Test Results

All match Node `RegExp` semantics on the standalone backend:

- `/(?:a?)*/.test("b")` → empty match at 0, <1 ms (was ~3 s "no match")
- `/(a?)*x/.test("bbbbbbbbbbbbbbbbbbbb")` → false, <1 ms (was step-cap burn)
- `/(?:a?)*/` on `"aab"` → `[0,2]`; `/(a*)*/` on `"aaa"` → `[0,3]`;
  `/(a*)+/` on `""` → `[0,0]`
- Non-nullable controls (`a*`, `a+`, `(ab)+`, `[0-9]+`) unregressed
- `tests/issue-1959.test.ts` (15 cases) green; `regex-bytecode.test.ts` (277),
  `issue-1539-standalone-regex-replace.test.ts` (17) green

(Pre-existing unrelated failure: `issue-1539-standalone-regex.test.ts` "refuses
unicode flag (u)" fails on clean main too — the `u` flag is no longer refused
but that refusal test wasn't updated; not touched here.)
