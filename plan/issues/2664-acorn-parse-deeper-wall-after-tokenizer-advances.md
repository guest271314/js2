---
id: 2664
title: "acorn parse() still hangs at a DEEPER wall after the tokenizer advances (#2656 fixed nextToken) — 8th dogfood blocker"
status: ready
sprint: 66
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2656, 2659, 2608, 2582]
depends_on: [2656]
origin: "Surfaced by dev-2046 while fixing #2656 (PR #2055): with the ++this.field write-drop fixed, the acorn tokenizer's nextToken() now advances across successive calls (step2 → pos=5 label=name, previously an infinite hang), but full parse(\"var x = 1;\") still does not return — it hits a NEW, distinct wall deeper in the parser."
---

# #2664 — acorn `parse()` hits a deeper wall after the tokenizer advances (8th dogfood blocker)

## Context

#2656 (PR #2055) fixed `compileMemberIncDec` silently dropping `++this.field` /
`this.field--` writes on `any`/`externref` fnctor receivers. That was the
tokenizer-advance freeze: acorn's `skipSpace`/`readWord1` `while (this.pos < len)
{ ++this.pos }` loops never advanced → the **2nd** `nextToken()` hung forever
(blocker #7).

**Verified post-#2656 (full compiled acorn, current main):**
- `new Parser({ecmaVersion:2020}, "var x = 1;").nextToken(); nextToken()` now
  returns `pos=5 end=5 label=name` — the tokenizer advances across successive
  `nextToken()` calls. (probe `.tmp/acorn-verify.mts` in the
  `worktree-agent-…`/`probe-2038-acorn` worktrees.)
- BUT full `parse("var x = 1;")` STILL does not return within the watchdog
  budget — it hits a **new, distinct wall** deeper in the parser. This is NOT
  the `++this.pos` freeze (resolved) and NOT the switch-on-externref identity
  (refuted in #2656 — direct `===` RESULT=111, switch dispatch RESULT=1001).

## What we know / don't know

- **Tokenizer advance: FIXED** (nextToken #2 returns, pos progresses).
- **Where parse() now stops: NOT YET LOCALIZED.** The next investigation pass
  must pin it with the same verify-first, watchdog-bounded probe method used for
  #2656 (incremental `stepN` / piece-isolation probes; full-acorn compile is
  ~100-180s so the fix loop runs inside it).

## Candidate next-wall locations (to confirm — do NOT assume)

`parseTopLevel`'s `while (this.type !== types$1.eof)` loop calls
`parseStatement` repeatedly. With the tokenizer now advancing, suspects for the
remaining non-termination:
- a different `++this.x` / `this.x--` site on a field NOT covered by the #2656
  arm (e.g. element-access `this.arr[i]++`, or a receiver shape that still
  resolves to neither a static struct nor a boxable externref);
- `parseVarStatement` / `eat` / `expect` not consuming a token (a `this.next()`
  not firing, mirroring the #2659 read/write-asymmetry class but on a different
  field such as `this.type`, `this.start`, `this.end`, `this.lastTokEnd`);
- the eof token's `this.type === types$1.eof` guard never tripping at true
  end-of-input (the eof token identity at EOF — distinct from the mid-stream
  token identity that #2656 proved holds).

## Acceptance

- Localize (verify-first) the exact construct where compiled-acorn `parse("var x
  = 1;")` now fails to terminate, with a reduced repro where practical.
- Fix it (or carve a precise sub-issue if it splits further).
- Compiled-acorn `parse("var x = 1;")` returns a `Program` AST → the #1712
  differential-AST gate becomes runnable on the first fixture.
- Full merge_group / test262 (any codegen change here is broad-impact).

## Notes

- 7 prior dogfood blockers cleared: #1712 b1-3, #2582, #2608, #2659 (#2655 slug),
  #2656.
- Method that worked for #2656: incremental `stepN` count probes (which call N
  hangs) + piece-isolation probes (which sub-function hangs) + WAT decode of the
  pinned function, all under a watchdog so the tight Wasm loop is observable.
  Reuse it here.

## Localization 2026-06-25 (dev-2046, verify-first) — 8th wall PINNED to finishToken's this.type write

Investigated on top of the #2656 fix (== current main + PR #2055). Full-acorn
compile ~80-140s; probes in `worktree-agent-…/.tmp/`.

**The tokenizer-advance (#2656) is FIXED** but full `parse("var x = 1;")` still
hangs at a DEEPER, distinct wall — localized step by step:

1. `tokenStream` probe on `"var x = 1;"`: `0:var@3 1:name@5 2:=@7 3:num@9
   4:num@10 5:num@10 …` — tokenization advances through var/name/=/num, then
   **freezes re-producing `num` with pos frozen** after the number.
2. `"1;"` probe: `0:num@1/end1 1:num@2/end1 2:num@2/end1 …` — after the num
   token, the 2nd `nextToken()` ADVANCES pos (1→2, the now-fixed `++this.pos`
   in `getTokenFromCode` `case 59 ';'`) **but `this.type` stays `num` instead of
   becoming `semi`**.
3. Direct `p.finishToken(types$1.semi)` on a fresh full-acorn Parser:
   `before=eof after=eof` — the `this.type = type` write does NOT change
   `this.type`. (Caveat: host-direct call may exercise a different
   `__current_this` path than the in-Wasm call — the WAT below is the solid
   evidence.)

**Root cause (WAT-pinned).** Parser struct = `$__anon_5` = **typeidx 44**;
`type` is field **11** (`(mut externref)`), `pos` field 8, `value` field 12.
`finishToken`'s `this.type = type` store (acorn-full.wat:9544-9561):

```wat
global.get 1588            ;; __current_this  (the receiver)
... local.set 69
local.get 69
any.convert_extern
local.tee 72
ref.test (ref 44)          ;; is __current_this the Parser struct $__anon_5?
(if (then
  local.get 72  ref.cast (ref 44)  local.get 71  struct.set 44 11   ;; → SLOT ✓
) (else
  local.get 69  global.get 539  local.get 71  call 40               ;; __extern_set → SIDECAR
))
```

The #2659 symmetric `struct.set` dispatch arm IS present and correct. The write
is lost ⇒ at runtime **`ref.test (ref 44)` FAILS** for the genuine Parser
instance at this write point, so it takes the `else` → `__extern_set` → sidecar,
while the READ side (`while (this.type !== types$1.eof)` / `this.type !== eof`)
uses `struct.get` on the slot → never sees the write → infinite loop.

**This is NOT a missing dispatch arm (it's there) and NOT the
`compileMemberIncDec` ++/-- lane (this is a plain `=` store).** It is the deeper
`__current_this` representation / `ref.test` machinery: WHY does
`__current_this` (global 1588) fail `ref.test (ref 44)` for the real Parser at
the `finishToken` write, when the member-READ side resolves the same receiver as
struct 44? Candidates:
- `__current_this` holds the receiver as a re-wrapped externref whose
  `any.convert_extern` does not recover the original WasmGC struct identity
  (so `ref.test (ref 44)` is false);
- a struct-subtype / `ref.test` exactness mismatch that only surfaces at acorn's
  full type-table scale.

**Routing:** deep struct-dispatch / `__current_this`-representation internals —
#2659-owner (sendev) territory, not the `compileMemberIncDec` extern-arm lane.
Hand off with this pinned shape.

**Probe artifacts** (`worktree-agent-…/.tmp/`): `probe-8th.mts` (tokenStream +
oneStmt), `post-num.mts` (the num→stuck transition), `ft-acorn.mts` (direct
finishToken before=eof after=eof), `acorn-full.wat` (9 MB; finishToken store at
:9544). `type-write.mts` / `type-collision.mts` are reduced repros that PASS
(isolated `this.type = type` works) — proving the bug is specific to the
full-acorn `__current_this` write path, not the generic externref `=` store.
