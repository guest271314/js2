---
id: 1913
title: "standalone RegExp string protocol, matchAll, split/replace, and lastIndex residuals"
status: done
completed: 2026-06-10
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp, string-methods
goal: standalone-mode
related: [1909, 1539, 1439, 1328, 1329, 1330, 1331]
test262_bucket: standalone-regexp-string-protocol
test262_count: 452
---

# #1913 — Standalone RegExp string protocol and lastIndex residuals

## Problem

After #1539, standalone mode supports a useful static RegExp subset, but the
test262 residual still contains protocol and stateful string-method semantics:
`@@match`, `@@replace`, `@@matchAll`, `@@split`, global/sticky `lastIndex`,
split limits/captures/empty separators, replacement substitutions, and function
replacers.

Representative signatures from the 2026-06-07 standalone JSONL:

- `literal-substring backend does not support @@replace symbol protocol calls`.
- `literal-substring backend does not support @@match symbol protocol calls`.
- `literal-substring backend does not support @@matchAll symbol protocol calls`.
- `RegExp.prototype.exec with g/y lastIndex semantics`.
- `String.prototype.split(RegExp, limit)`.
- `String.prototype.replace with a $-substitution pattern or non-literal/function replacer`.

## Scope

- Implement the next standalone string/RegExp protocol slice without JS-host
  dispatch.
- Model observable `lastIndex` semantics for global and sticky RegExp values.
- Keep symbol-protocol fallbacks and custom receiver cases separated from the
  static backend-created RegExp path.

## Acceptance Criteria

- Representative protocol/lastIndex/split/replace test262 rows leave the
  `standalone-regexp-string-protocol` bucket.
- The implementation emits no `env.RegExp_*` or JS-host string protocol imports
  under `--target standalone`.
- Focused tests compare standalone output to native JavaScript for each landed
  method family.

## Implementation Notes (fable-rx-surface, 2026-06-10)

Landed in PR (branch `issue-1913-regexp-string-protocol`, stacked on #1914's
match-vec + lastIndex groundwork). Five pieces — the WHY for each:

1. **g/y exec/test [[LastIndex]] semantics (§22.2.7.2 / §22.2.6.17)** —
   `emitRegexSearchCall` gains a `gyLastIndex` option: the scan starts at
   `i32.trunc_sat(lastIndex)` (NaN→0 like ToLength; oversized values fail the
   scan like lastIndex>length; negatives clamp in `__regex_search`) and the
   match end (or 0 on failure) is written back to struct field 5. Applied
   only when flags are STATICALLY g/y — non-g/y exec neither reads nor
   writes lastIndex, exactly per spec. `.test` is RegExpExec, so it gets the
   same semantics when flags are statically recoverable.

2. **Global `String.prototype.match` (§22.2.6.8 step 6)** — new
   `__regex_match_all` helper walks the subject with AdvanceStringIndex and
   returns the match-vec subtype (null when no matches); the call site resets
   `lastIndex` to 0 (the net effect of the spec's exec loop). Type uniformity
   note: the result reuses `$__regexp_match_vec`, so `.index`/`.input` on a
   GLOBAL match result return first-match values instead of spec `undefined`
   — a documented narrow deviation that keeps every inference site
   (locals/globals/index.ts) on one type.

3. **Full §22.2.6.14 split** — `__regex_split` rewritten: `lim` parameter
   (ToUint32; -1 = 2^32-1 via unsigned compares), capture values interleaved
   after each slice (unmatched → undefined elements), the `e == p` empty-
   separator rule (also makes `"abc".split(/(?:)/)`-style char splits
   terminate), and the empty-subject special cases. The call site accepts a
   numeric limit argument and drops the capturing-group/empty-match refusals.

4. **GetSubstitution (§22.2.6.11)** — new `__regex_get_substitution` expands
   `$$`/`$&`/`` $` ``/`$'`/`$n`/`$nn` at RUNTIME against the caps array;
   `__regex_replace` routes every match through it, so replace now accepts
   $-patterns AND dynamic (non-literal) string replacements. Out-of-range
   `$n` and `$<` (no named groups in the engine) pass through literally per
   spec. Function replacers remain a narrowed refusal (closure dispatch with
   capture-arg marshalling — follow-up).

5. **`nativeRegexHelpers` late-import-shift fix** (late-imports.ts + the two
   index.ts shift loops). The four shift sites kept `funcMap` and
   `nativeStrHelpers` (#1677) in lockstep but omitted `nativeRegexHelpers` —
   any late import landing BETWEEN two regex call sites left the cached
   helper indices stale-low, the second site baked a wrong `call` funcIdx,
   and stack-balance "fixed" the args against the wrong callee signature,
   emitting invalid `ref.cast`s (the S15.5.4.10 match family failed
   validation exactly this way). This was a LATENT pre-existing bug in the
   #1539 helper registry; #1913's multi-call-site patterns exposed it.

### Validation

- `tests/issue-1913.test.ts` — 12 focused tests incl. the shift-regression
  pin, all asserting zero env imports.
- 11/11 semantics probes match native JS (exec-g chains, sticky fail+reset,
  manual lastIndex writes, g-match, split limit/captures/empty/empty-subject,
  $-substitutions, dynamic replacements).
- The previously invalid-Wasm S15.5.4.10 match family now validates; rows
  remaining red in my local probe fail only on the probe's missing
  `__new_Test262Error` polyfill (the real runner provides it).

### Out of scope / residuals

- Function replacers (`replace(re, fn)`) — narrowed refusal, needs closure
  dispatch with per-match capture marshalling.
- `matchAll` / RegExpStringIterator — bucket rows are mostly custom-receiver
  protocol tests; an eager vec-of-match-vecs slice for `for-of`/spread
  consumption is the natural follow-up.
- `@@match`/`@@replace`/`@@split`/`@@matchAll` direct symbol-protocol calls
  with custom receivers — out of the static-backend model.
- Note from #1912 (landed under this branch): invalid static patterns at
  `new RegExp(...)` now compile to runtime SyntaxError throws, not compile
  refusals — classifier expectations updated accordingly.

