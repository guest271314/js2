---
name: feedback_reground_spec_against_current_main
description: "Before implementing a hard-issue spec, re-probe the failure against CURRENT main — sibling PRs may have moved the path; a stale 'architect-scale' framing can collapse to a narrow fix"
metadata:
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

When picking up a spec/escalation for a hard issue (especially one written hours
or a sprint earlier, or marked `feasibility: hard` / architect-scale), **re-probe
the actual failure against the CURRENT main HEAD before designing or building
anything.** The base advances under specs: a sibling slice may have landed a path
the spec assumed was broken.

**Concrete case (#2162b, sprint 64, 2026-06-18):** the spec (and the tech lead's
repeated routing) framed standalone `[...arr.entries()]` array-spread as an
architect-scale "externref-pair-vec REPRESENTATION fork" (vec-of-externref-pairs
vs vec-of-tuple-structs) needing the high-blast `buildVecFromExternref`/`__tup_mat_*`
materialization rewrite + `__array_from_iter` host-leak removal. Re-probing on
current main showed:
- the VALIDATE-FAIL the spec described was GONE (a sibling slice, #2169, had
  landed the native array-iterator);
- the real residual was two NARROW, additive, type-safe edits: (1) `__extern_get_idx`
  was missing an indexing arm for the canonical externref `$Vec` container
  (`boxVecElementToExternref` skipped externref elements wholesale per the #2190
  ref/ref_null hazard) — add an identity pass-through arm gated on
  `arrDef.element.kind === "externref"` EXACTLY (see [[reference_vec_externref_key_not_uniform]]);
  (2) a tuple-struct inner read used string-keyed `__extern_get` instead of
  positional `__extern_get_idx`.
- the feared `__array_from_iter`/`!noJsHost` core change DID NOT EXIST — that
  gating was already pre-existing and the diff never touched it.

Result: an "architect-scale, raise-with-user" item shipped as a +236/−20 green PR
(#1718), user-code codegen WAT-byte-identical, zero new host imports.

**Why:** specs encode a snapshot of the codebase. Parallel slices land between
spec-write and pick-up. Implementing from a stale spec wastes effort on a
disproven plan (I built the spec's "PR-A" literals.ts heuristic first — it was a
provable NO-OP) and mis-routes work to architects it doesn't need.

**Secondary lesson — crossed-thread ossification:** when the tech lead sends
several routing messages that all predate your landing (a known multi-session
lag), each one re-asserts the stale plan. Don't keep re-explaining at length;
send ONE firm reconciliation that (a) states the PR is already shipped+green,
(b) names exactly why the old plan (PR-A / the core change) does not apply with
proof (`git diff upstream/main` hit-counts), and (c) reduces it to a single open
decision (enqueue or revise). See [[feedback_verify_fix_in_git_not_narrative]].

**How to apply:** on any hard-issue/spec pickup — (1) compile+run the exact repro
on current `upstream/main` HEAD FIRST; (2) if it behaves differently than the
spec says, RE-GROUND the spec (update the issue doc) before coding; (3) prefer the
narrowest additive fix the fresh evidence supports over the spec's heavy plan;
(4) verify any "we'd lose host-fallback coverage" worry with an actual
`git diff upstream/main` on the gating, not from the spec's description.
