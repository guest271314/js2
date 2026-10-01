# IR migration handoff — 2026-10-01

## Current wrap-up

This ready PR publishes the handoff and preserved evidence. The new source-contract implementation remains uncommitted and incomplete; its historical checks must pass before publication as a ready implementation. Legacy retirement is not certified. All worktrees and original failures are preserved.

The current integration worktree is `/private/tmp/js2-ir-source-contracts-integration-20261001`, branch `codex/3518-source-contracts-integration-20261001`, HEAD/base `ff564bccab11c53ae1aeaf1d510385e16b54a832`, freshly verified against upstream main. It contains 35 changed or new tracked-source/test/metadata/issue paths, with staged and unstaged edits intentionally preserved. [The immutable wrap-up manifest](resume-checkpoint/manifest.json) authenticates [all current file bytes](resume-checkpoint/integration-files.raw.txt), separate [staged](resume-checkpoint/integration-index.patch.raw.txt) and [unstaged](resume-checkpoint/integration-unstaged.patch.raw.txt) patches, and the exact status. These archives preserve unfinished work; they are not executed historical reconstruction inputs.

Scoped claim `3518:source-validation-contracts-20261001`, owner `ttraenkler/codex-source-validation-contracts-20261001`, was released on stand-down. The actual upstream `issue-assignments` record was read back: status `released`, `released_at=2026-10-01T03:13:54Z`, `write_id=68420-4cmsrof8`. The raw record is [preserved](resume-checkpoint/claim-wrapup-release-record.json.raw.txt). Reclaim through the canonical branch after checking overlapping active claims before editing. No other claim or reservation was released.

## Executed evidence and blockers

All following measurements executed in the integration worktree on the exact preserved bytes. No historical receipt was refreshed and no timeout, fixture or existing negative control was removed. Raw JSON assertions and terminal logs are retained in `resume-checkpoint/` and hashed by its manifest.

| Check | Actual result | Limits |
| --- | --- | --- |
| Production TS7 | PASS | No test-source typecheck claim |
| Source-contract and existing component tests | 121/121 | Includes 53 new and 68 existing assertions |
| Complete boundary suites | 477/477 | 352 semantic/provider and 125 general controls; zero skipped |
| Original ownership suite | 22/22 | Previously failed collection with ENOSPC |
| Core vocabulary suite | 16/20 | Four historical relocation receipts still fail |
| Program-data seam suite | 37/47 | Ten historical declaration/retained-source controls still fail |
| Inventory | Valid, no inventory errors | 1752 entries; architecture and graph explicitly incomplete |
| Main-based LOC/function | PASS | 25 changed source paths, +117 LOC; base ff564bcc |
| JsTag seam | PASS | Exact owner relocation; exemption population remains four |

The program-data execution completed normally at its genuine 4096 MiB child heap limit: the previous 2048 MiB heap override was removed while root configuration, real source, diagnostics, rows and timeouts stayed unchanged. Ten failures remain: input/prepared optional-field historical declarations, retained outcomes, identity and prepared-component-dependency statements, and five declaration-detector controls. This is not a green historical cohort. Core's four failing rows concern intrinsic, async, string and counted-site historical moves. Current runtime/fresh-child vocabulary and real bounded type checks pass, while immutable historical counts and hashes stay unchanged.

The first general-boundary run failed one pre-existing static expectation; current main already had the three frontend roots in its policy. The updated test pins all three existing roots and minimum three, retaining prior contract-root, allowed-edge and historical checks. The original 124/125 run remains archived. Semantic activation records append exactly three entries after the unchanged 88 records; three corruption controls were added. Existing ownership inverses and every source/intermediate/output pin moved unchanged into a shared helper; its 22 original controls still execute.

The untouched before-edit a8cd historical cohort remains 107 passed and 35 failed of 142 collected assertions. A separate ownership file could not collect due to ENOSPC; one program-data compiler child aborted at roughly 2 GiB. All four requested files failed. Preserve [original JSON](baseline-historical.raw.txt), [terminal errors](baseline-historical.log.txt) and [provenance](evidence.json). The current results do not constitute a clean before/after attribution study.

## Frozen implementation and next step

The Phase A writer is `/private/tmp/js2-ir-source-contracts-writer-20261001`, branch `codex/3518-source-contracts-writer-20261001`, base a8cd. Its original 26-path snapshot `.tmp/source-contracts-writer/phase-a-v07xt1lw/` remains immutable and is recorded in [the original manifest](phase-a-frozen-manifest.raw.txt). Twelve actual closed owners replace thirteen old declaration/body donors through identity-preserving aliases. The precise later role revision `.tmp/source-contracts-writer/phase-a-role-correction-qktlatcg/` changes only the new test's invalid `support` role to genuine `lifted-closure`; it is preserved in the current integration archive and [revision receipt](resume-checkpoint/role-correction-receipt.json.raw.txt). Production bytes remain unchanged from the original freeze. Actual writer attribution: Codex GPT-6 Astra Max; integration metadata and existing-test edits: Codex GPT-6 Default.

A separate three-file historical reader draft is frozen in `.tmp/source-contracts-writer/relocation-freeze-ngavd5/`. Its [manifest](resume-checkpoint/relocation-freeze.raw.txt), [handoff](resume-checkpoint/relocation-handoff.raw.txt), helper, receipt and 65 drafted test rows are archived byte-for-byte in `resume-checkpoint/`. It has NOT been integrated, compiled or tested. Static generation reconstructs 13 original donors and reciprocally replays 25 current owners from authenticated live declaration spans, accounting for 184 declarations including 115 moves. These static results are not executed test evidence. Independent review and corruption controls remain required.

The architect's [pre-A inverse findings](resume-checkpoint/pre-a-findings.md.raw.txt) and [fixed manifest](resume-checkpoint/pre-a-inverse-spec.json.raw.txt) preserve read-only provenance and static reciprocal calculations. They are not implemented or adversarially validated. Two identity types moved to shared contracts in cb64af7b; runtime-support changes include both the leading dependency function and the implicit-requirement arm, plus exact optional fields in input/prepared contracts. Missing factories must not be guessed.

Resume in order: verify actual main/base, all archive/current hashes and claim ownership; review and integrate the three-file reader only at initial raw historical reads; then apply authenticated pre-A inverses before existing historical logic. Keep current production/runtime/type reads raw and never normalize injected historical mutations twice. Complete the remaining core/runtime historical reconstruction without storing executable snapshots, changing receipt hashes, or substituting old declarations for current compiled types. Run all new and original affected tests, complete inventory/boundary/preservation gates, normal signed hooks and fresh-main queue checks before publishing source. Serialize heavy compiler/test processes; no validation process is running at this stand-down. Provide an independent pinned test262 checkout if required; never borrow or replace another lane's linked corpus.

Then follow [the full extraction specification](validation-lowering-extraction-spec.md): A closed contracts; B full analysis/verifier/allocation/class-layout bodies; C complete program/runtime rederivation and validator; D generic/Wasm lowering closure; E authentic source identity/fill and linear compatibility. Phase A alone does not make the preserved seven-file mixed source-call draft publishable. That draft remains in `/private/tmp/js2-ir-genuine-mixed-get-call-20261001`, branch `codex/3518-genuine-mixed-get-call-20261001`, base e4737c9, with manifest `.tmp/mixed-invocation/writer/source-target-draft1-glo9qpeg/manifest.json`. Its 43/43 component evidence does not override an invalid dependency inventory.

## Existing PRs and verified delivery

[PR6371, “feat(ir): add native realm state and structural object access”](https://github.com/loopdive/js2/pull/6371) remains OPEN at exact signed head `21c7922d5f8601aab52542690815d5b951796a14`. Fresh wrap-up reads now show quality and issue-tests SUCCESS, as well as the equivalence gate. Protected auto-merge remains enabled. It has not merged and is not counted delivered. Preserve its original failures, fixtures and 35-second timeout; do not open a duplicate or push unrelated work to that branch. Its repair worktree `/private/tmp/js2-ir-6371-canonical-audit-performance-20261001` is clean. Its signed handoff records 392/392 scoped, 213/213 after main integration, 953/953 normal commit-hook assertions and passing normal push hooks; these local measurements do not replace protected merge-group evidence.

[PR6372, “fix(ir): retain closure parameter facts across physical projections”](https://github.com/loopdive/js2/pull/6372) is independently delivered as `d1d7d68583ba312aa04f58f6144b3222a90c2d5e`. Its three production files and seven-row test match verified main; all 102 actual protected conformance shards and final regression/CI/CLA/differential gates passed. Only this verified main merge counts as delivery here. Main ff564 adds six npm-compat benchmark artifacts beyond a8cd, with no production or test changes.

The ready handoff PR is [PR6374, “docs(ir): preserve migration handoff and extraction baseline”](https://github.com/loopdive/js2/pull/6374). Its prior signed head 5f7797d had quality SUCCESS, no auto-merge request and no merge at the wrap-up decision read. This documentation update preserves evidence only; verify its final exact head and normal hook/publication receipts in the PR body.

## Remaining full acceptance

All 45 intrinsic identities, 44 Call algorithms/lifted entries and 2 intrinsic Construct entries, complete source modes/this/Get/Call/Construct/newTarget/bound behavior, dynamic Function/eval/with, original public nine-row Number fixture, fresh-process replay and both-backend equality remain required. The preserved public Number checkpoint was 5/9. Reachability evidence remains preservation-only 6/6 full and 6/6 cut: graph OPEN, strict modeled closure FAIL, retirement NOT CERTIFIED. Develop and prove the full IR path before retiring legacy. The migration epic remains in progress.

The canonical dirty Deno worktree `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm`, branch `codex/4376-deno-callback-construction-20260930`, and all other prepared lanes remain untouched. No worktree was deleted, reset, pruned, stashed or overwritten. No GitHub issue or polling automation was created. No passive webhook tool is available; notifications or an explicit resume must drive fresh PR/main reads and protected merge ancestry/content verification.
