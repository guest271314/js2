---
id: 3319
title: "standalone: gOPD miss + descriptor undefined-slots materialize as null, not the $undefined singleton (#2106-flip family — the two #3316 residuals and friends)"
status: done
assignee: ttraenkler/fable-3316
completed: 2026-07-16
sprint: 72
created: 2026-07-16
priority: high
horizon: m
feasibility: medium
model: fable
task_type: bug
area: codegen, runtime
language_feature: object-property-descriptors
goal: standalone-mode
related: [3316, 2106, 2874, 2896, 2885, 2965, 2984, 2987]
origin: "self-assigned follow-up from #3316's documented residuals (fable-3316, lead-approved 2026-07-16); allocated via claim-issue --allocate"
# LOC-ratchet allowance (#3102): every arm is a regime-gated one-mechanism fix
# (null → $undefined singleton at descriptor/miss materialization sites) with
# root-cause commentary, spread across the pre-existing descriptor god-files.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/object-ops.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/regexp-standalone.ts
---

# #3319 — gOPD miss / descriptor "undefined" slots vs the #2106 singleton

## Problem

Same #2106-default-flip family as #3316, next mechanism out: every place the
descriptor machinery materializes **"undefined"** as a bare `ref.null.extern`
broke when the flip made null DISTINCT from undefined. Measured failing on
main (pre-fix), all standalone:

- `issue-2874 > missing own property returns undefined` — typed-receiver gOPD
  miss (compile-time static miss in `call-builtin-static.ts`).
- `issue-2896 > delete fn.name works` — post-delete gOPD miss (dynamic
  `__getOwnPropertyDescriptor` miss arms).
- `issue-2984` ×4 — builtin absent-member miss arms (`builtin-static-gopd.ts`),
  @@species accessor synthesis `set === undefined`.
- `issue-2885` ×3 — `__create_accessor_descriptor` null set-half; §22.2.6
  proto-identity getter arm returning null (`regexp-standalone.ts`).
- `issue-2965` ×2 — no-value define (`{writable:true}`) stored null as
  [[Value]] (§10.1.6.3 defaults it to undefined), so `typeof o.p` read
  "object"; absent-coerced-key miss.
- `issue-2987` ×3 — string-wrapper exotic arm miss returns.

16 failing tests total across those suites on base; probes showed the same
`gOPD(o, missing) === undefined → false` / `=== null → true` on both the
typed-receiver AND `$Object` arms.

## Fix (all regime-gated on `undefinedSingletonActive`; legacy + gc lanes byte-identical)

One mechanism, applied at each materialization site — "undefined" surfaces as
the `$undefined` singleton (via `undefinedExternInstrs` / `emitUndefinedExtern`),
never bare null:

1. `object-runtime-descriptors.ts` — `__getOwnPropertyDescriptor` miss returns
   (`undefRet`, now a FACTORY since the singleton arm carries an index-bearing
   `global.get`; plus the non-`$Object` receiver arm); the
   `__create_accessor_descriptor` null get/set halves (unambiguous: §6.2.5.6
   throws on `{get: null}` before reaching it); the `__obj_define_from_desc` +
   `__defineProperties` L_VALUE **default** (fresh-define [[Value]] =
   undefined). GETTER/SETTER null resets intentionally stay null — null is the
   appliers' "absent half" convention.
2. `expressions/call-builtin-static.ts` — typed-receiver static miss.
3. `builtin-static-gopd.ts` — namespace-no-prototype / unknown-member /
   degenerate misses, non-literal-key runtime chain miss, absent-proto value.
4. `object-ops.ts` — inline singular flag-only define + plural static
   expansion no-value pushes.
5. `regexp-standalone.ts` — §22.2.6 proto-identity getter `undefined` result.

**Deliberately NOT changed:** the gOPD data branch's `e.value` read-back — a
stored `ref.null` there may be a legitimate JS `null` value (`{value: null}`);
materializing it as undefined would corrupt null-valued properties. The fix
instead corrects what gets STORED for a no-value define, and the
`{ value: null }` round-trip is regression-tested.

## Measured (2026-07-16, fable-3316)

- Adjacent 7-suite set (2987/2965/2984/2885/3160/2915/2989): base 16 failed →
  **95/95 pass**; failure-name diff confirmed a strict subset (0 new failures).
- Targets: issue-2874 7/7 (was 6/7), issue-2896 11/11 (was 10/11).
- New `tests/issue-3319.test.ts`: 18 pass / 2 skipped (the two gc-lane
  typed-receiver cases — see residuals).
- Core matrix (2992 family + 2106 + 3316 + 2874 + 2896 + 1888 + 3116):
  138 pass / 2 skipped, only pre-existing failures remain (below).
- **Byte-inert** on gc and legacy-standalone (`undefinedSingleton: false`):
  SHA-identical binaries base vs fix on representative shapes.

## Residuals (pre-existing, verified failing identically on base — NOT this slice)

- `issue-1888` ×2 refuse-loud guardrails (unsupported builtin static
  value-reads) — fail on base, unrelated mechanism.
- **gc/host lane typed-receiver gOPD miss** answers null-extern while host
  `undefined` is the `__get_undefined` sentinel — the host twin of this bug;
  needs a host-lane decision (not regime-gated), out of scope here.
- any-typed descriptor hop `d.get; g.call(proto)` dispatch gap (the direct
  `.get` off the gOPD expression works — 2885 shape).

## Acceptance

- The #3316-documented residual shapes (issue-2874 miss / issue-2896 delete)
  pass standalone. ✅
- No regressions in the descriptor/gOPD suite family. ✅ (strict-subset diff)
- gc + legacy lanes byte-inert. ✅
