---
name: project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous
description: "A second class of dishonest test262 pass exists beyond vacuity (dead callback) — \"coincidental wrongness\": code executes and returns an incorrect value that happens to equal another equally-wrong value, so the assertion trivially passes. Inject-throw execution proof does NOT catch this class."
metadata: 
  node_type: memory
  type: project
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

Discovered 2026-07-02, during round-5 leak-elim work on `env::Object_get_constructor` (PR #2537, issue #2999). A dev fixed the leak by making `.constructor` on a standalone builtin receiver emit `ref.null.extern` natively instead of calling the host import. The fix genuinely eliminates the `env::` import, but the underlying VALUE returned is still wrong (null, not the real constructor object) — the 9 target tests only pass because the OTHER side of the `sameValue()` comparison (a bare builtin identifier like `Map`) ALSO compiles to a null-ish carrier in standalone. Proven by the dev's own cross-check: `sameValue(Set.prototype.constructor, Map)` — comparing against the WRONG builtin — also passes, since both sides are equally null.

**Why this is distinct from vacuity** ([[project_hostfree_pass_can_be_vacuous_inject_throw_probe]]): vacuity is "the callback body never executes" — caught by injecting a throw into the body and confirming the test now fails. This new class is "the code executes, computes something, and that something happens to be wrong in a way that cancels out against an equally-wrong comparison target." The inject-throw check does NOT catch this — the code path genuinely runs; it's the VALUE that's wrong, not the execution.

**How to apply:** when a leak-elim fix converts a leaky-pass to a host-free-pass by emitting a literal/placeholder/sentinel value (null, 0, undefined-carrier, etc.) rather than a genuinely-computed correct value, don't accept the flip as "genuine execution-verified progress" without an extra check: does the test still pass if you swap in an obviously-wrong comparison target? If yes, the pass is coincidental, not correct — same caution tier as vacuity, needs its own documentation/tracking, and should NOT be counted in the same "genuine execution-verified" bucket as fixes that produce real values. The underlying correctness gap (here: builtin constructor/prototype object identity) is real substrate work, tracked separately ([[project_2984_2988_2992_convergent_reification_substrate]]-adjacent — see the consolidated "reified builtin constructor/prototype identity" issue).

**Verification technique to add to the toolkit:** alongside inject-throw (proves execution), add "swap-comparison-target" (proves the VALUE, not just the execution, is meaningful) for any fix involving an identity/equality assertion against a placeholder value.
