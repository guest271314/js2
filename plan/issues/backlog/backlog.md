# Backlog index

Lightweight pointer index for unscheduled issues that need sprint candidacy. Authoritative status lives in each issue file's frontmatter.

## Harvest 2026-05-24b (fixable test262 compile-error causes — CE decomposition)

Decomposed the 1,367 `compile_error` results in `test262-current.jsonl`. The
528 `invalid Wasm binary` CEs were sub-clustered by validator error; sub-causes
already enumerated in #1522 / #1543 / #1556 are not re-filed.


## Harvest 2026-05-24 (new issues from test262 error analysis)

- [#1591](1591-class-elements-same-line-multi-definition.md) — class/elements same-line / stacked member definitions lost or reordered — **~294 fails**, high priority (formerly 779b)
- [#1592](1592-ary-ptrn-elision-rest-holes-dstr.md) — Array pattern elision holes / rest-array consume wrong iterator step — **~305 fails**, high priority
- [#1593](1593-default-init-triggers-on-null-should-be-undefined-only.md) — Destructuring default init triggers on `null` (spec: undefined-only) — **~165 fails**, easy
- [#1594](1594-annexb-strict-function-code-tdz-referenceerror.md) — AnnexB strict function-code / class name-binding TDZ not throwing ReferenceError — **~100 fails**, medium
- [#1595](1595-arraybuffer-transfer-methods-not-implemented.md) — ArrayBuffer.prototype.transfer / transferToFixedLength / transferToImmutable not implemented — **~40 fails**, medium
- [#1596](1596-function-prototype-apply-call-not-accessible.md) — Function.prototype.apply / .call not accessible on compiled Wasm functions — **~46 fails**, high

## Destructuring-lane sweep follow-ups (2026-05-24)

From the dev-1553b destructuring-lane verification sweep.

- [#1658](../1658-destructured-function-param-default-not-applied.md) — Destructured/scalar **function-parameter** default not applied: returns 30 where 40 is expected on the real runtime (distinct from the object/array decl-mode #1553b/#1553d which are done) — high, medium, **ready**. NOT currently caught by CI (see #1659); depends on #1659 for gating.
- [#1659](../1659-ci-equivalence-tests-not-run.md) — CI does not run `tests/equivalence/` (OOMs in runner) so genuine equivalence regressions (e.g. #1658) land silently. Options: shard like test262 / constrained workers / `--no-threads` / separate scheduled job. Sub-item: fix `__extern_get` harness-fidelity gap in `tests/equivalence/helpers.ts` so the suite runs clean — high, medium, **ready**. Gates CI-visibility of #1658.

## Sprint 55 — repo structure / website (2026-05-24)

- [#1656](../1656-group-website-files-into-website-dir.md) — Consolidate all website/frontend files under `website/` (components, dashboard, playground, index.html, public, frame-nav-sync.js, images, vite.config.ts, CNAME) — medium, medium, **ready (sprint 55)**. Needs architect spec (`arch(#1656)`) before dev; lands as one PR. Related: #1583, #1590.
- [#1657](../1657-mq-test262-paths-filter.md) — Skip `merge_group` test262 shards for non-src changes while keeping the "merge shard reports" required check green — medium, medium, **in-review (sprint 55)**. Conservative path detector (`scripts/test262-paths-match.sh`) + `changes` job gate the queue's shard matrix; fail-safe runs shards on any doubt. Related: #1656.

## WASI Native Messaging — AssemblyScript-reference alignment (2026-05-24)

Compiler gaps blocking full convergence of `examples/native-messaging/host.ts`
(#1530) on the reference `nm_assemblyscript.ts`. #1654 is the root (unblocks
both others); #1653 is the keystone for the read side + continuous loop.

- [#1654](../1654-wasi-dataview-arraybuffer-invalid-module.md) — DataView/ArrayBuffer-backed TypedArrays emit an invalid wasm module under `--target wasi` — high, medium, **root (ready)**
- [#1653](../1653-wasi-process-stdin-read-binary.md) — `process.stdin.read(buffer, offset?)` binary incremental stdin read (keystone) — high, hard, **depends on #1654**
- [#1655](../1655-wasi-process-stdout-write-arraybuffer.md) — `process.stdout.write(ArrayBuffer)` accept ArrayBuffer arg, not only Uint8Array literal — medium, easy, **depends on #1654**

## Spec-compliance easy wins (from #1563 gap analysis, 2026-05-21)

- [#1564](1564-toNumeric-symbol-throws-typeError.md) — ToNumeric: Symbol argument must throw TypeError (§7.1.3 step 3) — ~12 fails, easy
- ~~[#1565](1565-toBoolean-bigint-i64-eqz.md)~~ — DONE (merged PR #541 in s55)
- ~~[#1566](1566-toNumber-symbol-throws-typeError.md)~~ — DONE (merged PR #541 in s55)

## Developer experience / docs

- [#1590](1590-first-5-min-ux-docs-and-hints.md) — First-5-minutes UX: Wasmtime run docs, coverage-honesty section, CLI run-hint, standalone I/O docs, pitch-language accuracy, "compare to…" section — docs+CLI only, 6 commits in order, easy

## Carry-over from earlier analysis

- [#779a](779a-class-dstr-method-tramp-residual.md) — class/dstr method-tramp residual (gen/async-gen/private/static) — **~727 fails**, ready
- [#779d](779d-object-literal-dstr-residual.md) — object-literal dstr non-method residuals — **~132 fails**, ready
- [#779e](779e-arguments-object-residual.md) — arguments-object mapped/trailing-comma/sloppy-strict residuals — **~134 fails**, ready
- [#846](846-assert-throws-not-thrown-built.md) — assert.throws not thrown: built-in methods accept invalid args silently — **~2,799 fails**, ready
- [#1319](../sprints/50/1319-cannot-convert-to-primitive-symbol-toprimitive.md) — Cannot convert object to primitive (Symbol.toPrimitive chain) — **~150 fails**, ready
- [#1529](1529-codegen-illegal-cast-at-closure-and-destructuring-boundaries.md) — illegal cast at closure/dstr boundaries — **~197 fails**, backlog
- [#1555](1555-destructure-param-array-streaming-iterator.md) — destructureParamArray streaming IteratorStep refactor — ready
- [#1568](1568-object-bigint-symbol-auto-box.md) — Object(BigInt) / Object(Symbol) auto-box wrappers — ready
- [#1564](1564-toNumeric-symbol-throws-typeError.md) — ToNumeric: Symbol → TypeError — ~12 fails, easy

- [#1600](1600-finalizationregistry-host-delegate-noop-stub.md) — FinalizationRegistry host-delegate (JS mode, like WeakRef) + no-op standalone stub; clears ~12 CEs. Faithful standalone finalization stays out of scope (→ #1101).
