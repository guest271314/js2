---
name: reference_a1_unblock_eager_gen_vacuity_not_2580_3053
description: "A1 (#2040 rest-identity, tag-5 === vacuity) unblocks by removing eager-generator/comparator vacuity (#3032 +"
metadata: 
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

Verified against origin/main 2026-07-14 (SD-Substrate triage). The #2040 **A1**
headline (~382 standalone `assert.notSameValue(x,values)` rest-identity fails)
is the tag-5 `===` object-identity vacuity: `_isSameValue`'s `a===b` over two
`any`-boxed refs answers a legacy constant, not real ref-identity. The 3-way
classifier that fixes it is flag-gated OFF; flipping it once caused a **−162
eject**. Key correction: **that eject was NOT a dstr/eq dependency — it was
eager generator bodies + comparator vacuity** (per #3032's own root-cause).

Real unblock map (supersedes #2040's re-ground listing #2580 M2 as the blocker,
and my wrong "#3053 carrier is the keystone" premise):
- **#3053** (`__dyn_member_get` carrier, U0/U1/U2) is **ALREADY LANDED** on main
  but corpus-VACUOUS — property-access alone never claims the reduce/harness
  comparator (claim-delta ~0, byte-inert 39/39). Remaining U3/U4 owned by
  **#3037 CS3** + **#2175 V2-S3b**; real payoff needs the multi-slice **#2949**
  claim-rate forms (S5.P eq/relational/truthiness + dynamic-arithmetic). Not one PR.
- **#2580 M2** is a rabbit hole — M1a ejected (−13/13 regr), M2.2c WONT-FIX, most
  deferred to value-rep. NOT on A1's real critical path despite the re-ground.
- **#3032** lazy-first-resume generators removes eager-gen vacuity → de-risks
  the classifier flip. It IS the real lever, but W3-for-the-dominant-shape is a
  **fresh-window `reasoning_effort: max` big-rock, NOT a quick gate tweak**
  (verified 2026-07-14, SD-Substrate). The 2026-07-12 arch spec route is WRONG:
  a CAPTURING nested named generator routes through
  `src/codegen/statements/nested-declarations.ts` has-captures branch (~:990),
  a DIRECT-CALL-with-leading-cap-params model (`nestedFuncCaptures`) — NOT
  `function-body.ts:1052` / a closure struct / `compileArrowAsClosure`. The
  lazy fix is #3050's `capturingNativeGen`, but the dominant population captures
  TDZ-flagged `let`/`const` bindings and #3050 gated on `tdzFlaggedCaptures==0`;
  the real fix threads TDZ-flag capture boxes through the native-gen state
  machine (paramNames/param-field + factory push + resume-fn `boxedTdzFlags` +
  `leadingCaptureCount` offsets; ~4-6 coupled sites; merge_group-only validation).
  Do NOT attempt in a partial window — strand risk in the floor-sensitive area.

Sequence to A1 (multi-window): #3032 TDZ-native-threading (fresh-window big-rock)
+ #2949 claim-rate forms → the classifier flip becomes safe → A1 fixed (the flip
itself is the #2040 capstone, fable-tier — never flip it before the substrate is
proven non-vacuous). See
[[project_2040_tag5_classifier_dstr_default_regression]],
[[reference_2040_tag5_field4_three_way_classifier]],
[[reference_2583_any_strict_eq_tag5_host_only]].
