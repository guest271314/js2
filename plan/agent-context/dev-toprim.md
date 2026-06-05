# dev-toprim — context / resume note

**Role:** Developer teammate (dev lane: plain `fix(...)`/`refactor(...)`/`dev:` tasks).
**Last active:** 2026-06-05 (shut down in the drain-to-4 rate-limiting pass).
**State at shutdown:** clean — no uncommitted source WIP; both open PRs MERGED.

## Landed this session (all MERGED)
- **#1836 Number↔String** family (earlier): exponential toString (PR #1206),
  toFixed/whitespace/fractional (#1204), strict StringToNumber `+"12abc"→NaN`
  (#1836-ston). Backlog issue #1889 (`any`-value ToNumber over-reject) filed via
  PR #1207.
- **#1866** — externref-destructuring `__extern_get` leak: routed the 5
  standalone-reachable bypass sites (destructuring-params.ts,
  assignment.ts ×2, statements/loops.ts ×2) through `ensureLateImport` so
  `--target standalone` emits zero `env::__extern_get`. **PR #1211 MERGED.**
  Test: `tests/issue-1866.test.ts`.
  - VERIFIED: the 2 other raw-`addImport("env","__extern_get")` sites
    (declarations.ts:1089, index.ts:6077) do NOT leak under standalone — both
    gated `if (split||match) && !ctx.nativeStrings`, and standalone auto-enables
    nativeStrings, so split() returns a native string array. They fire only in
    JS-host mode (import legitimately provided). The "7 sites" in the task desc
    was conservative; 5 are the standalone-reachable ones and all are fixed.
  - DEFERRED: the headline `o[k]` computed-member-read leak is sd-1472c's #1472
    Phase C (flows through property-access.ts; needs native object-runtime to
    serve `__extern_get` for the dynamic-read path) — NOT in this PR.

## Handed off (do NOT re-claim)
- **#1890 / #1891** (dstr-rest-param standalone late-import funcIdx-shift cluster,
  ~1,142 standalone CE) — handed to **sd-1886 / #329** (it owns the
  deferred-flush re-resolve mechanism). My narrow per-site branch
  `issue-1890-dstr-trunc-sat` (origin SHA 2dcc112a7, PR #1208 CLOSED) is
  preserved for reference; capture sites are destructuring-params.ts
  :1012/:1014/:1029 (capture) and :1131-1133 (my re-resolve). #1891 root-cause
  (generator-method over-shift +5) documented in **PR #1210 MERGED**. The whole
  late-shift/funcIdx-stale class is sd-1886/#329 + sd-1888 territory now.

## Data-driven mining result (for whoever resumes the standalone push)
Sampled ~1,150 standalone compiles across language/ + built-ins
(TypedArray/Number/Math/operators), family-bucketed with the owned-family
exclusions applied (late-shift #329/sd-1886, dynamic-shape/`__extern_get`/`o[k]`
#1472/sd-1472c+sd-1888, regex/dev-regex, iterator/for-of/dev-iter,
@@toPrimitive/sd-1886). **HONEST RESULT: no large coherent dev-lane cluster
remains.** The standalone CE wall is dominated by:
1. **#1472/#1888 dynamic-shape** (`__get_builtin`/`__hasOwnProperty`/
   `__extern_method_call`/`Reflect.set`) — BIGGEST; every static-builtin dynamic
   read (Math.LN10, Number.prototype, …) hits `__get_builtin`. Owned by sd-1888
   (#1888 S6 `__get_builtin` built-ins-as-static-globals, ~4.6k lever — arch
   spec landed #336, sd driving S1-S7).
2. **late-shift #329** — second.
3. **TS-typecheck noise** from harness wrapping (Object-possibly-undefined,
   IArguments-not-assignable, this-implicitly-any, missing harness helpers like
   `testWithBigIntTypedArrayConstructors`/`floatCtors`/`CollectValuesAndResize`)
   — NOT codegen; a test262-runner/`wrapTest` shim gap (test-infra, not dev-lane
   compiler work).
Residual DEVLANE buckets are all single-digit/scattered (`Binary emit error:
u32 out of range: -1` is heterogeneous — Function()-ctor/eval-class +
obj-rest-dstr shapes, not one root cause; delete-on-readonly; import.source;
with-in-strict — mostly deferred-feature/parse edges).

**Recommendation:** highest standalone leverage is the two owned families
(sd-1888 #1888 `__get_builtin`, sd-1886 #329 late-shift). For a fresh dev-lane
pick, the one plain candidate I saw was **#137 fix(#1609)** (non-literal spread
in new-expression, ~18 fails) — but issue #1609 is `status: blocked`
(feasibility: medium), so confirm it's unblocked before claiming. Otherwise
re-mine the post-#1888/#329 residue once those land (they'll collapse the two
dominant buckets and expose what's actually left for dev-lane).

## Worktrees (mine — can be GC'd on resume if clean)
issue-1866-extern-get-leak (merged), chore-1891-rootcause (merged),
issue-1836-exp-tostring (has stale untracked 1889-*.md copy — #1889 already
landed via PR #1207, safe to discard), plus older toprim/1806/1836 worktrees
from earlier slices (all merged/clean).
