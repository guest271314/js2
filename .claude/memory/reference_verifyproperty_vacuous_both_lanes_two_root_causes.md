---
name: reference_verifyproperty_vacuous_both_lanes_two_root_causes
description: "verifyProperty is vacuous on BOTH host and standalone, by two DIFFERENT root causes. Fixing standalone before host converts every honest flip into an invalid-Wasm trap. Host conformance is inflated too."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T02:04:53.189Z
---

**`verifyProperty` reports pass for ANY expectation — on BOTH lanes, via two different
mechanisms.** Measured 2026-07-25 (dev-verifyprop, issue #3596, branch
`issue-3596-verifyproperty-vacuity`). **This means the HOST conformance number is inflated
too**, not just standalone — correcting an earlier lead claim that host was unaffected (that
was true of the *arity* bug, which host fixed at #2623; it is NOT true here).

**Root cause A — STANDALONE.** A plain object literal lowers to a typed WasmGC struct with
**no `$Object` own-property table**, so every RUNTIME (untyped-receiver) MOP query on it
reports zero own properties: `hasOwnProperty`, `getOwnPropertyDescriptor`,
`getOwnPropertyNames`, `Object.keys` AND `for-in` all fail together. `verifyProperty` guards
all four descriptor checks behind `__hasOwnProperty(desc, <field>)` → all four false →
`failures` empty → returns true. Site: `emitHasOwn`'s `ref.test $Object → return 0` arm,
`src/codegen/object-runtime.ts` ~2630-2677. The a1 gate survives only because `obj` is
usually a builtin fn (the #2896 `__builtinfn_get_meta` arm answers correctly); when `obj` is
itself a literal, a CORRECT descriptor **fails** — same cause, opposite direction.

**Root cause B — HOST.** The checks DO run, but the uncurried `__push` is a **silent no-op**,
so `failures.length === 0` and the terminal `assert(false, __join(...))` never fires. Three
independent observations agree (`.length` → 0, `[0]` → undefined, `__join` → "") while native
`arr.push` passes.

So the older `__push`/`__join` lead is **correct for host, refuted for standalone** — on
standalone `__push` is never reached (A short-circuits first) and there it TRAPS rather than
no-ops.

**⚠️ SEQUENCING RULE — fix HOST (`__push`) FIRST.** Fixing standalone without fixing `__push`
converts every honest flip into an **invalid-Wasm trap** — the same class that dogged the
#3592 arity widening. S1 before S2, always.

**Measured (local-vs-local, calibrated detector, nothing extrapolated):**
- Census: **5,067 files / 6,470 call sites is an UPPER BOUND, NOT exact** (author-corrected).
  It matches `verifyProperty` **textually**, and two contamination sources were proven while
  chasing the arm-B survivors: `// TODO: Convert to verifyProperty() format.` matches the
  regex, and some calls sit behind an `if` that is itself false under root cause A (WeakRef).
  6,308 sites pass an object literal with ≥1 checkable field (97.5% of sites).
  **DO NOT scale anything off 5,067.** The 158/158 rate below is derived from EXECUTION, not
  from the census, which is why it stands independently.
- Standalone 600-file uniform sample (seed 20260725): stock 161 pass; with detector, **158
  fail / 3 pass**. The 3 survivors execute **no** `verifyProperty` call at all. So
  **158/158 of executed-verifyProperty passes are vacuous.**
- **Attribution control (arm A2)** — all structural edits with detector throws REMOVED gave
  161/161 identical to stock, proving the flips are the detector, not the instrumentation.
  Do this control; without it the number is a claim.
- Host magnitude: **NOT MEASURED** (run killed at ~275/600 to relieve box load ~19/10 cores).

**Recommended slices (do NOT attempt as one PR — the whole is XL):**
1. **S1 (M, FIRST)** — repair the uncurryThis family (`Function.prototype.call.bind(F)`).
   Un-vacuums HOST alone; prerequisite for S2 not producing traps. **The stronger reason for
   S1-first: it is the only slice that can PROVE itself today.** Host vacuity is entirely
   S1's fault and the detector is already calibrated for host, so S1 lands with a real
   before/after number from the same harness. **S2 has NO measurement available until S1 is
   in**, because until then every standalone flip is a trap rather than a verdict.
2. **S2 (L/XL)** — promote object literals to a runtime-queryable rep on standalone. **A
   promotion path ALREADY EXISTS**: one computed-key write (`o["a"]=1`) flips the object into
   a fully queryable `$Object`, as do `new Object()`, `Object.create`, `JSON.parse`, spread.
   Start narrow: a literal passed as an argument to an untyped parameter.
3. **S3 (S/M)** — `Object.defineProperty` does not promote either; small and self-contained.
4. **S4** — re-measure and land the honest floor (it goes DOWN; `__builtinfn_gopd` already
   returns a wrong `value` for `Math.abs.name`, so the name/length family flips to honest FAIL).

**DETECTOR TRAP — do NOT use `Object.keys(desc)` / `getOwnPropertyNames(desc)` as a yardstick
in any standalone detector.** On a directly-named module global `Object.keys(DESC).length` is
4 (compile-time fold); on the SAME object through an `any` parameter it is 0. A detector built
on it never fires and returns a null result that looks like a clean bill of health.

Related: [[reference_standalone_floor_inflated_three_vacuity_mechanisms]] (the arity layer,
separate), [[reference_f1_honest_floor_deinflation_landing_recipe]] (how to land the drop),
[[feedback_measure_never_extrapolate]].
