# Goal: ir-full-coverage

**Every supported source unit is prepared as typed IR before emission. WasmGC
and linear differ only below that IR boundary. Unsupported source fails with a
typed diagnostic, and the direct AST→Wasm front-end is deleted.**

- **Status:** Active — current migration priority (2026-07-21)
- **Track:** Compiler architecture / IR retirement
- **Tracking epic:** [#3518](../issues/3518-ir-only-default-and-direct-frontend-retirement.md)
- **First executable slice:** [#3519](../issues/3519-ir-only-typed-outcomes-and-honest-gate.md)
- **Allocated ownership spine:** [#3520](../issues/3520-ir-r1-source-qualified-identity-program-abi.md)
  → [#3521](../issues/3521-ir-r2-prepared-program-free-function-compile-once.md)
  → [#3522](../issues/3522-ir-r3-classes-closures-compile-once.md) →
  [#3523](../issues/3523-ir-r4-module-init-compile-once.md) →
  [#3525](../issues/3525-ir-r5-whole-program-multi-source-ownership.md) +
  [#3526](../issues/3526-ir-r6-semantic-runtime-contract.md) →
  [#3527](../issues/3527-ir-r7-ast-free-async-plan.md) →
  [#3528](../issues/3528-ir-r8-shared-linear-prepared-program.md)
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
- `STRICT_IR_REASONS` and corpus baselines cannot define IR-only policy. A
  legitimate unsupported source may use a reason that happens to be zero on a
  sample corpus. #3341's typed invariant work is the precedent, but substring
  matching must be retired by #3519.

## Delivery strategy

The old bucket-only sequence (#2855) is complete as a measured function-corpus
milestone. The retirement now follows #3518's dependency spine:

1. **R0 / #3519 — truth:** typed Prepared/Unsupported/Invariant outcomes and an
   honest gate that includes TypeMap failures, thrown compiles,
   `CompileResult.errors`, named corpus denominators, classes, and module init.
   Later retirement slices expand that same schema to inline equivalence and
   the other production lanes before the fail-closed default flip.
2. **R1 / #3520 — identity/ABI:** source-qualified `IrUnitId` and
   `ProgramAbiMap`.
3. **R2 / #3521 — ownership:** a `PreparedIrProgram` built before body
   emission; free functions compile once without an allowlist.
4. **R3 / #3522 then R4 / #3523 — remaining unit kinds:** classes/closures
   compile once before their ordered static intents feed compile-once module
   init.
5. **R5 / #3525 — whole program:** multi-source/M0, collisions, imports, fast
   mode, and one program-owned module-init plan.
6. **R6 / #3526 — semantics:** typed intrinsic/runtime-feature/host-capability
   contract, immutable fixed-point manifest, then measured runtime families.
7. **R7 / #3527 — async:** AST-free suspension/liveness/handler plans and one
   canonical Promise ABI through the existing frame engine.
8. **R8 / #3528 — backend convergence:** linear consumes the exact same
   Prepared program, ABI, runtime manifest, and async plans.
9. **R9 — policy flip:** fail-closed IR-only becomes the sole production mode;
   remove hybrid demotion and every legacy escape hatch.
10. **R10 — subtraction:** re-run #3090 and delete the proven-unreachable
    direct front-end.

Corpus fallback counts remain useful downward ratchets during this program,
but no zero count advances a later stage without its structural acceptance
evidence.

## Issues

<!-- AUTOGENERATED:GOAL-ISSUES-START -->

| #         | Title                                                            | Sprint  | Status      | Role                                               |
| --------- | ---------------------------------------------------------------- | ------- | ----------- | -------------------------------------------------- |
| **3518**  | IR-only default and direct front-end retirement                  | current | in-progress | Active tracking epic, R0–R10                       |
| **3519**  | IR-only R0: typed preparation outcomes and honest readiness gate | current | ready       | First executable slice                             |
| **3520**  | IR-only R1: source-qualified identity and whole-program ABI      | current | blocked     | Depends on #3519                                   |
| **3521**  | IR-only R2: Prepared free-function compile-once ownership        | current | blocked     | Depends on #3520                                   |
| **3522**  | IR-only R3: compile-once classes, members, and closures          | current | blocked     | Depends on #3521                                   |
| **3523**  | IR-only R4: typed ordered module-init compile-once ownership     | current | blocked     | Depends on #3521 and #3522                         |
| **3525**  | IR-only R5: whole-program single/multi Prepared ownership        | current | blocked     | Depends on #3520–#3523                             |
| **3526**  | IR-only R6: typed semantic runtime contract                      | current | blocked     | Depends on #3521                                   |
| **3527**  | IR-only R7: AST-free async suspension plans                      | current | blocked     | Depends on #3522, #3525, and #3526                 |
| **3528**  | IR-only R8: linear consumes shared Prepared program              | current | blocked     | Depends on #3525–#3527                             |
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
