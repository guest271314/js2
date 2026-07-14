---
name: reference_postflip_standalone_hostfreefail_is_the_frontier
description: "After the #3020 undefined-singleton flip landed (2026-07-13), a fresh post-flip standalone re-rank shows the SOLE-IMPORT LEAK track is essentially EXHAUSTED — of 4,020 remaining leaky-passes, 94% co-occur __get_caught_exception (the #3132 generator-runtime epic, ALL-OR-NOTHING: nothing flips until the whole gen runtime self-hosts together), the rest is dynamic_import (host gate) + deferred features. The real lever pool is 4× bigger: HOST-FREE-FAIL (15,450) — tests that compile host-free but return the WRONG runtime result, so a SEMANTICS fix (not an import fix) flips host_free_pass. Pivot fleet dispatch from individual-import-leak-fixes to host-free-fail semantics clusters."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Post-#3020-flip standalone landscape re-rank (opus-leak3, 2026-07-13, fresh
baseline promoted 17:48 UTC — AFTER the 16:50 flip merge).** Corpus 48,121 rows;
host_free_pass = status==pass AND zero `env::` imports (#2879 §2).

**(A) LEAKY-PASS (pass but ≥1 import) — 4,020, essentially MINED OUT.** Almost
entirely sync/async generator RUNTIME substrate and **all-or-nothing**:
`__get_caught_exception` co-occurs in 3,758/4,020 (94%), so no generator test
flips host-free until the WHOLE gen runtime (create_generator, gen_next,
gen_yield_star, gen_result_*, Promise_*, __get_caught_exception) self-hosts
*together* — that IS the #3132 epic (opus-asyncgen2's banked S2/S3/S4). Outside
that: `dynamic_import` (99+141) is a genuine host module-loader gate (out of
scope). **No actionable individual-import-leak lever remains** — the season of
`#3016`-style bounded gate fixes + one-import-at-a-time substrate (weak-collections,
subclass-ctors, `__make_callback`, gen-proto) is over post-flip.

**(B) HOST-FREE FAIL — 15,450 (4× bigger, the real pool).** Compiles host-free
but wrong runtime result → a **semantics** fix flips host_free_pass (no import
involved). assertion_fail 9,731 · type_error 2,256 · illegal_cast 265 · null_deref
251. Deferred ~7k (Temporal 5,000+, dynamic/annexB eval ~977, ShadowRealm 58).
Top ACTIONABLE concentrated clusters:
1. **Object.defineProperty/defineProperties validation — ~914.** Exotic-object
   redefinition (arguments/array-index non-configurable not throwing TypeError,
   137) + defineProperties shape gaps ("Property description must be an object"
   191, "unsupported descriptor shape" bail 78). Standalone-only (host uses
   `__defineProperty_desc` import → host byte-identical). Plain data+accessor
   paths ALREADY validate (#2042-S4/#2992-S3/#2965) — residual is exotic +
   shape. (opus-leak3's pick.)
2. **type_error "Cannot access property on null/undefined" — 925 → re-scoped
   (opus-tabrand):** NOT a single 925 root. It's **~100 shared-root getter-GOPD
   brand-check — FIXED by #3250/PR#3041** (GOPD returned undefined for un-wired
   buffer-family accessor getters ArrayBuffer/SharedArrayBuffer/DataView/
   %TypedArray%.buffer → the test's `.get` deref trapped; 1-line fix extending the
   `native-proto.ts` refusal-body fallback from methods to getters; +37 measured,
   0 regressions, byte-inert on wired getters) — **plus ~800 DIFFUSE remainder**
   (detached-buffer, bigint, species, null-deref elsewhere), no single next root.
3. **illegal_cast 141 / null_deref 164** — runtime crashes across Array/String/
   DataView prototype methods, diffuse.

**Dispatch strategy going forward:** pivot the fleet from import-leak fixes to
host-free-fail semantics clusters (1→2→3 by size/tractability). Related:
[[reference_standalone_leak_gate_vs_substrate_numeric_callN]] (the now-exhausted
leak track), the descriptor-cluster family #2042/#2992/#2965.
