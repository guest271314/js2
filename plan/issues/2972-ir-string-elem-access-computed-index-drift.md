---
id: 2972
title: "IR selector accepts string element access with computed index; from-ast throws 'not in slice 12' — 14 test262 CEs under IR-first"
status: done
assignee: ttraenkler/dev-2138f
sprint: 69
created: 2026-07-02
updated: 2026-07-03
completed: 2026-07-02
priority: medium
feasibility: medium
horizon: s
task_type: bug
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2135, 2138, 2945]
origin: "2026-07-02 #2138 Slice-3 full flagged test262 run (28580162377) — divergence class 1 (14 tests)"
---

# Element-access capability drift: selector claims `s[i+1]`-shaped reads, builder throws

## Problem

The largest divergence class from #2138's full `JS2WASM_IR_FIRST=1` test262
run (14 of 15 regressions, all `pass → compile_error`):

```
IR path failed for decimalToPercentHexString: ir/from-ast: element access on
string with index BinaryExpression not in slice 12 (…) [IR-FALLBACK]
[IR-FIRST skipped-slot, #2138]
```

The test262 harness helper `decimalToPercentHexString` (used by the
encodeURI / decodeURI / encodeURIComponent / decodeURIComponent /
parseInt / parseFloat suites) indexes a string with a computed
(BinaryExpression) index. The selector's element-access shape check accepts
it and claims the function; `from-ast.ts`'s element-access lowering only
accepts a narrower index shape and throws post-claim. Flag-off this demotes
silently to legacy; flag-on the skipped slot fails the compile LOUDLY —
exactly the designed #2138 surfacing.

Affected (all share the one harness function):
`built-ins/decodeURI/S15.1.3.1_A2.1_T1`, `decodeURIComponent/S15.1.3.2_A2.1_T1`,
`encodeURI/S15.1.3.3_A1.{1,2,3}_T{1,2}`, `encodeURIComponent/S15.1.3.4_A1.{1,2,3}_T{1,2}`,
`parseFloat/S15.1.2.3_A6`, `parseInt/S15.1.2.2_A8`.

## Fix — this IS #2135 family 2/3 work

Single-source the **element-access index-shape** guard in
`src/ir/capability.ts` (the #2135 table), consumed by the selector's
element-access arm and asserted at from-ast's lowering entry. Then either:

1. **Selector-side (cheap)**: reject computed-index string element access
   (capability "defer" for that shape) — restores flag-on/flag-off parity
   immediately; the 14 tests go back to legacy compile.
2. **Builder-side (better)**: lower `s[<f64 expr>]` — the constant-index
   string read lowering exists; extend it to a computed index (same charAt
   semantics: index ToInteger, out-of-range → undefined … match the LEGACY
   emission, verify-first per #2945's lesson).

## Acceptance criteria

- A `JS2WASM_IR_FIRST=1` compile of the `decimalToPercentHexString` harness
  function either legacy-compiles (option 1) or IR-compiles (option 2) —
  no hard error; the 14 test262 tests pass flag-on.
- The shape guard lives in `capability.ts` (one row/predicate, not two).

## Scoping analysis (dev-2138f, 2026-07-02) — read before implementing

Mechanism verified against the code; the fix options above need correction:

1. **Option 1 (selector-side shape reject) is NOT viable as written.** The
   drift is TYPE-level, not shape-level: `isPhase1Expr`'s element-access arm
   (`select.ts` ~:1887) is shape-only and cannot distinguish `s[i+1]`
   (string receiver — unlowered) from `arr[i+1]` (vec receiver — the
   working slice-12 fast path with the #2766 prove-then-specialize bounds
   handling). Rejecting computed-index element access at the selector would
   destroy the vec fast path. In capability-table terms the element-access
   family is **claim-partial** (documented type residual in
   `lowerElementAccess`, `from-ast.ts` ~:2141 — arms today: string-literal
   key on object shape; any index on vec receiver; everything else throws
   at the tail).
2. **Option 2 (string-receiver lowering) has an OOB-semantics trap.** JS
   `s[i]` yields a 1-char string in-bounds but **`undefined`** out of
   bounds (NOT `""` — charAt semantics differ). An IR result typed `string`
   diverges on OOB (`"%" + undefined` → `"%undefined"` vs `"%" + ""` →
   `"%"`). A sound computed-index string read therefore needs either
   (a) a **proven-in-bounds gate** — the actual harness shape is
   `hex[(n >> 4) & 0xf]` on a 16-char literal: a bitmask-bound rule
   (`& 0xf` ⇒ idx ∈ [0,15]) against a known-literal receiver length,
   extending `isProvenInBoundsIr` (vec arm) with mask-range + tracked
   literal-length receivers; or (b) a result widen to a string|undefined
   representation (bigger; touches value-rep). (a) covers all 14 tests and
   is the recommended slice; the unproven-index case stays a documented
   claim-partial residual.
3. **Cheap IR-first-noise stopgap exists independently**: a
   `computeIrFirstSkipSet` gate (like sr-irfirst's gate 4) excluding
   functions whose bodies contain element access on non-vec-provable
   receivers — restores flag-on parity for the 14 tests WITHOUT the
   lowering, but keeps the compile-twice demote flag-off. Acceptable
   stopgap; not the fix.

Recommended slice: (2a) proven-in-bounds string read + a capability-table
predicate documenting the element-access family as claim-partial with this
exact residual. Verify the emitted read against LEGACY's string-index
emission first (verify-first — #2945's lesson; legacy may route through a
host import with its own OOB contract).

## Resolution (dev-2138f, 2026-07-02) — option 2a implemented

Key verify-first simplification: for an integer index i with 0 ≤ i <
s.length, `s[i]` ≡ `s.charAt(i)` exactly — and the IR ALREADY lowers charAt
on both lanes (`STRING_METHOD_TABLE` / `lowerStringMethodCall` → host
`string_charAt` import or native `__str_charAt`). So the slice is a proof +
a delegation, not a new read primitive:

- **`stringIndexProvenBelow`** (`src/ir/capability.ts` — the single-source
  guard per acceptance criterion 2): non-negative int literal `< len`, or
  `<expr> & K` / `K & <expr>` with non-negative int32 K < len (ToInt32 ⇒
  result ∈ [0, K] — the harness shape `hex[(n >> 4) & 0xf]`).
- **`collectStringLiteralLens`** (`from-ast.ts`): receiver lengths — locals
  bound exactly once to a string literal and never written anywhere in the
  function INCLUDING nested-function bodies (stricter than `mutatedLets`,
  which deliberately skips those). Populated on the outer LowerCtx only.
- **String-receiver arm in `lowerElementAccess`**: proven → delegate to
  `lowerStringMethodCall("charAt", …)`; UNPROVEN stays on the demote path —
  an OOB `s[i]` is `undefined` while charAt is `""`, so claiming an unproven
  read would be silently wrong (the exact trap the scoping analysis called).
- **Import materialization**: element-access syntax never mentions
  `.charAt`, so the legacy method-syntax pre-scan can't see it; a new
  element-access arm in `unifiedVisitNode` (`declarations.ts`) adds
  "charAt" to `stringMethodNeeded` when a string-typed receiver is indexed
  by a non-literal — the existing finalize loop then registers the host
  import / ensures native helpers up-front (no late-import shift at IR
  lower time). Over-registration is harmless (eliminateDeadImports).

Verified: the exact harness shape is selector-claimed, IR-compiles with
ZERO post-claim errors, is SKIPPED under `JS2WASM_IR_FIRST=1`
(compile-once), and returns bit-correct results (`run(0xAB) === "%AB"`)
both flag states (`tests/issue-2972.test.ts`, 5 tests: claim + parity +
unproven-index OOB semantics preserved + proof-predicate unit rows +
reassigned-receiver invalidation). `check:ir-fallbacks` unchanged.

NOTE (selector `var` gate): in `.ts`-fileName probes the selector rejects
`var`-declared bodies (`vardecl-var-kind`), so the probe/test uses `const`;
the real test262 pipeline claimed the `var`-declared harness (proven by the
Slice-3 post-claim errors), and the from-ast fix is declaration-kind-
agnostic — the 14 tests should flip back under the next `ir_first`
measurement dispatch (#2947 lane), which is the acceptance check for the
flag-on criterion.

## Parallel resolution (sr session, 2026-07-02, landed first as PR #2519): gate 5 stopgap

A parallel session independently landed option 3 (the stopgap from the
scoping analysis above) while the 2a lowering PR was in flight: **gate 5**
(`irFirstBodyReadsStringElement` in `src/codegen/ir-first-gate.ts`, wired
into `computeIrFirstSkipSet`) keeps any function whose body reads an element
of a syntactically-string receiver on the compile-twice path, converting the
flag-on hard error back into a silent demote. Its notes correctly confirmed
two of the scoping-analysis findings (no string-receiver arm existed at all;
the checker-free selector cannot defer this) but its premise "no
string-element read can validly be IR-first today" is retired by the 2a
lowering in this PR.

## Merge reconciliation (dev-2138f) — the two layers compose

- **The 2a lowering (this PR)** makes PROVEN-in-bounds string element reads
  genuinely IR-lowerable — for those, compile-once is correct and desirable.
- **Gate 5 (landed)** remains the guard for the UNPROVEN residual — but as
  landed it excluded ALL string-element reads, which would waste the new
  lowering (proven functions stay compile-twice forever) and contradict the
  skip-set's purpose. **Refined in this PR**: gate 5 now consults the SAME
  single-source proof (`stringIndexProvenBelow` + literal-length receiver
  facts from `capability.ts`) and only keeps functions with UNPROVEN string
  element reads on the compile-twice path. Proven-only functions re-enter
  the compile-once skip set. One predicate, two consumers — exactly the
  acceptance criterion.
- Gate 5's "lifting trigger" note stands, narrowed: the remaining lift is
  the unproven residual (OOB→undefined widening or broader proofs).
