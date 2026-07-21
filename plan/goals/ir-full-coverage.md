# Goal: ir-full-coverage

**Every supported source unit is prepared as typed IR before emission. WasmGC
and linear differ only below that IR boundary. Unsupported source fails with a
typed diagnostic, and the direct AST→Wasm front-end is deleted.**

- **Status:** Active — current migration priority (2026-07-21)
- **Track:** Compiler architecture / IR retirement
- **Tracking epic:** [#3518](../issues/3518-ir-only-default-and-direct-frontend-retirement.md)
- **Completed R0:** [#3529](../issues/3529-ir-r0-typed-producer-equivalence-parity.md)
  producer parity and
  [#3519](../issues/3519-ir-only-typed-outcomes-and-honest-gate.md) typed
  truth/gate, completed 2026-07-21
- **Next executable slice:** **#3520 / R1 — ready**; R2–R8 remain blocked on
  the dependency spine
- **Target:** `pnpm run check:ir-only` passes across the authoritative corpus
  and both backends; the hybrid/direct path and its escape hatches no longer
  exist; the #3090 reachability audit reports no direct-front-end survivors.
- **Dependencies:** `compiler-architecture`; `backend-agnostic-ir` supplies the
  shared backend seam, while #3518 completes whole-program consumption.

## Why

The backend axis is legitimate: WasmGC and linear use different
representations/lowering. The front-end axis is temporary duplication. Keeping
both typed IR and direct AST→Wasm lowering makes type propagation, binding,
control flow, source semantics, and bug fixes diverge across two or three
implementations.

The desired boundary is:

```text
source → PreparedIrProgram → WasmGC lowering
                           → linear lowering
```

Runtime/builtin behavior may remain shared code below semantic IR intents. No
runtime family may require an AST dispatcher as its entry point.

## Current state (2026-07-21)

The compiler is **default-on hybrid, not IR-only**:

- #2856 reduced the measured playground function `body-shape-rejected` bucket
  to zero, but that is a narrow corpus ratchet, not strictness or reachability.
- The adoption matrix has 18/56 IR-owned rows. Mixed/direct rows remain, and
  an IR-owned node inside one rejected function still uses its legacy handler.
- The latest compile-once ceiling is 441/1,568 functions (28.1%). The remaining
  71.9% needs runtime/object/string/array/method IR, not signature widening.
- Class members and the #3142 module-init unit compile twice. Module claimability
  and successful slot patching do not prove that legacy emission was skipped.
- Multi-source/M0 and linear are incomplete whole-program IR consumers.
- Roughly 59,676 frontend-only fn-lines remain reachable. Roughly 47K
  runtime/builtin entry fn-lines must be rewired behind IR intents, not deleted.
- R0 now provides typed emitted/Unsupported/Invariant outcomes and complete
  gate accounting without substring policy. Full equivalence is 1,608 passing
  / 35 failing against 36 committed known failures: one baseline-known case
  now passes, there are zero new regressions, and the baseline is unchanged.
- The bounded hybrid lane is green at 5/5 entries, 37 terminal units, 31
  emitted IR bodies, 6 Unsupported, 0 Invariants, and 37 legacy bodies. Strict
  IR-only is intentionally red on async (2), call-graph closure (1), body shape
  (1), static class members (2), and the 37 legacy-emitted bodies.

## Delivery strategy

The old bucket-only sequence (#2855) is complete as a measured function-corpus
milestone. The retirement now follows #3518's dependency spine:

1. **R0a / #3529 — done 2026-07-21:** retained strict
   unknown-throw-to-Invariant behavior, preclaimed known capability shapes,
   used narrow typed Unsupported exits for residual evidence, and fixed the 13
   true producer/pass invariants; full equivalence has zero new failures.
2. **R0b / #3519 — done 2026-07-21:** typed
   emitted/Unsupported/Invariant outcomes and
   an honest gate that includes TypeMap failures, thrown compiles,
   `CompileResult.errors`, named corpus denominators, classes, and module init.
   Later retirement slices expand that same schema to inline equivalence and
   the other production lanes before the fail-closed default flip.
3. **R1 / #3520 — ready next:** source-qualified `IrUnitId` and
   `ProgramAbiMap`.
4. **R2 — blocked on R1:** a `PreparedIrProgram` built before body emission; free
   functions compile once without an allowlist.
5. **R3/R4 — blocked on R2:** classes and module init compile once.
6. **R5 — blocked on R1–R4:** multi-source/M0, collisions, imports, fast mode, and
   one program-owned module-init plan.
7. **R6 — blocked on R2:** typed intrinsic contracts and IR entry points for each
   runtime/builtin family.
8. **R7 — blocked on R2/R6:** async becomes IR-owned; deliberately unsupported
   syntax becomes a source-located hard diagnostic, never direct fallback.
9. **R8 — blocked on R1/R2/R6/R7:** linear consumes the same prepared IR.
10. **R9 — policy flip:** fail-closed IR-only becomes the sole production mode;
    remove hybrid demotion and every legacy escape hatch.
11. **R10 — subtraction:** re-run #3090 and delete the proven-unreachable
    direct front-end.

Corpus fallback counts remain useful downward ratchets during this program,
but no zero count advances a later stage without its structural acceptance
evidence.

## Issues

<!-- AUTOGENERATED:GOAL-ISSUES-START -->

| #         | Title                                                            | Sprint  | Status      | Role                                               |
| --------- | ---------------------------------------------------------------- | ------- | ----------- | -------------------------------------------------- |
| **3518**  | IR-only default and direct front-end retirement                  | current | in-progress | Active tracking epic; R0 complete, R1–R10 remain   |
| **3529**  | IR R0 prerequisite: typed producer equivalence parity            | current | done        | R0a completed 2026-07-21                           |
| **3519**  | IR-only R0: typed preparation outcomes and honest readiness gate | current | done        | R0b completed 2026-07-21                           |
| **3520**  | R1 source-qualified unit identity and whole-program ABI map      | current | ready       | Next executable slice                              |
| **3090**  | Retire direct front-end after IR-only reachability gates close   | current | blocked     | R10 deletion ledger                                |
| **3143**  | IR-first default flip                                            | 71      | done        | Historical default-on hybrid milestone             |
| **3142**  | IR module-init overlay adoption                                  | 72      | done        | Historical claim/patch milestone; not compile-once |
| **2855**  | IR fallback-corpus ratchet                                       | 73      | done        | Historical function-corpus zero milestone          |
| **2856**  | `body-shape-rejected` function corpus to zero                    | 73      | done        | #2855 child                                        |
| **2857**  | Class-method fallback corpus to zero                             | current | done        | #2855 child                                        |
| **2858**  | Call-graph-closure fallback corpus to zero                       | current | done        | #2855 child                                        |
| **2859**  | Param-type fallback corpus to zero                               | current | done        | #2855 child                                        |
| **3341**  | Typed strict IR invariant hardening                              | current | in-progress | Precedent/input to R0                              |
| **1373b** | Async CPS lowering                                               | 67      | backlog     | Feeds R7                                           |
| **2950**  | IR-first default flip historical issue                           | 71      | done        | Delivered by #3143; retirement superseded by #3518 |

<!-- AUTOGENERATED:GOAL-ISSUES-END -->

## Success criteria

- `pnpm run check:ir-only` passes with complete denominators and zero
  Unsupported, Invariant, unaccounted, legacy-emitted, or fatal-result rows.
- Every supported function, class member, synthetic callback, module-init unit,
  and multi-source unit belongs to one `PreparedIrProgram` before either
  backend emits bodies.
- WasmGC and linear consume the same program ABI and semantic IR intents.
- Unsupported features fail source-located and typed; there is no silent
  selector fallback or post-claim demotion.
- `experimentalIR`, `JS2WASM_IR_FIRST`, `disableIrFirst`, compile-twice
  allowlists, and direct-path test modes are removed.
- The refreshed #3090 audit reports zero reachable direct AST→Wasm front-end
  handlers. Runtime/substrate survivors are reached only below the IR boundary.
- Equivalence, cross-backend, full Test262 in both lanes, standalone-floor,
  linear, validity, typecheck, lint/format, LOC, and dead-export gates are green.
