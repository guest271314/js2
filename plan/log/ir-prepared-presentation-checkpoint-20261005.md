# Prepared IR output checkpoint — 2026-10-05

The internal `runPreparedIrPipelinePresentation` entry feeds authentic
whole-program emission into the existing output finalizer. Public routes and
legacy code remain. This is a bounded productive checkpoint under issue 3525,
“IR-only R5: whole-program single- and multi-source Prepared ownership”.

The new ordinary suite passes 44/44, with zero pending/todo or unhandled errors.
Both host backends execute scalar functions, cross-file calls, primitive globals,
automatic initialization and explicit deferred initialization (0 → 1 → 2).
Both actual generated helpers execute. Linear compared artifacts are exact;
WasmGC legacy bookkeeping strings produce an explicit, retained difference in
pool/manifest/helper data. This is not full artifact parity.

Existing prepared-driver and validation suites pass. The six-row finalizer
suite retains two failures. All six rows and full failure text match clean
`650cb1b0a08df7976662c721e0da884b109fbfe0` with only absolute worktree path
replacement. Those failures are not accepted coverage. Initial new-test fixture
and oracle failures remain in the worktree evidence; no existing gate or fixture
was weakened. Full typecheck and repository lint pass; the native dead-export
gate accepts preservation only, with graph closure open and retirement uncertified.

Astra High specified/reviewed the hard contracts. Sol GPT-6.1 Medium writers
implemented separate source and test files in isolated worktrees. Root Codex
GPT-6.1 Sol High owns compiler integration and delivery. Canonical child claims:
`3518:output-finalizer-context-20261004`,
`3525:prepared-presentation-internal-20261004`,
`3525:prepared-presentation-tests-20261004`. Historical claims and work remain.

Integration branch: `codex/3525-prepared-pipeline-presentation-20261004`.
Normal signed commits and protected ready-PR delivery are required. Dependency
PR 6475, “refactor(ir): give linear layout contracts and backend legality
canonical owners”, has immutable head
`650cb1b0a08df7976662c721e0da884b109fbfe0`. At the last genuine release decision
all 63 head checks were green/skipped and protected admission reported already
queued. Neither this statement nor a test merge SHA proves main delivery.
Verify fresh canonical main, exact ancestry/content and actual merge-group
conformance before completing delivery claims. Do not poll or change the armed
head. Broader provider/carrier/layout/options/target coverage remains open.

Issue 6837, “Modular IR analysis and optimization pipeline with measured
performance parity”, remains prepared but unaccepted. Attempt four actually
terminated with driver/worker exit 1, 4/8 reports and 143/240 pairs: the strict
load threshold refused a sample. Preserve all measurements and staged work;
there is no performance acceptance or automatic retry. Compose its preserved
metadata only after the dependency lands and input equivalence is verified.

Retirement remains a later decision requiring the complete IR path to be tested
and equal. The dirty primary worktree, old worktrees, unrelated fixes and
original failures must remain intact.
