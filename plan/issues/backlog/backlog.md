# Backlog index

Lightweight pointer index for unscheduled issues that need sprint candidacy. Authoritative status lives in each issue file's frontmatter.

## Harvest 2026-05-24b (fixable test262 compile-error causes — CE decomposition)

Decomposed the 1,367 `compile_error` results in `test262-current.jsonl`. The
528 `invalid Wasm binary` CEs were sub-clustered by validator error; sub-causes
already enumerated in #1522 / #1543 / #1556 are not re-filed.

- [#1601](1601-array-iteration-callback-stack-underflow.md) — Array reduce/reduceRight/map/filter callback paths emit stack-underflow wasm — **156 CE**, high
- [#1602](1602-call-arg-coercion-externref-invalid-wasm.md) — call-site arg coercion: `call expected externref, found f64` — **39 CE**, high
- [#1603](1603-optional-chaining-ref-is-null-invalid-wasm.md) — optional-chaining short-circuit `ref.is_null expected i32` — **8 CE**, high
- [#1604](1604-string-case-method-return-type-invalid-wasm.md) — String toUpperCase/toLowerCase/toLocale* return i32 into f64.ne — **8 CE**, high
- [#1605](1605-class-computed-setter-scope-local-tee-invalid-wasm.md) — class computed-name / setter scope `local.tee` type mismatch — **6 CE**, medium
- [#1606](1606-internal-crash-object-literal-undefined-declarations.md) — internal crash `reading 'declarations'` on object literals — **8 CE**, high
- [#1607](1607-internal-crash-tdz-use-before-init-stack-overflow.md) — stack overflow on TDZ self-referential lexical initializers — **8 CE**, high
- [#1608](1608-internal-crash-array-mutator-set-typeidx.md) — internal crash `setting 'typeIdx'` on Array push/pop/shift/join — **5 CE**, high
- [#1609](1609-non-literal-spread-in-new-expression.md) — non-literal spread in `new F(...iter)` unsupported — **18 CE**, medium
- [#1610](1610-for-of-requires-array-expression.md) — for-of over non-array iterables rejected — **13 CE**, medium
- [#1611](1611-lexical-declaration-single-statement-context.md) — valid newline `let` misclassified as lexical decl in single-stmt context — **16 CE**, medium
- [#1612](1612-tla-array-literal-element-access-misparse.md) — top-level-await array-literal operand misparsed as element access — **14 CE**, medium
- [#1613](1613-for-in-variable-must-be-identifier.md) — for-in head binding-pattern / non-identifier targets rejected — **10 CE**, low
- [#1614](1614-set-prototype-set-method-missing.md) — Set union/isDisjointFrom etc. cannot resolve `size` on subclass receivers — **7 CE**, low
- [#1615](1615-import-defer-source-phase-proposal-deferred.md) — import.defer / import.source phase proposal (deferred/proposal tracking) — **152 CE**, low

## Harvest 2026-05-24 (new issues from test262 error analysis)

- [#1591](1591-class-elements-same-line-multi-definition.md) — class/elements same-line / stacked member definitions lost or reordered — **~294 fails**, high priority (formerly 779b)
- [#1592](1592-ary-ptrn-elision-rest-holes-dstr.md) — Array pattern elision holes / rest-array consume wrong iterator step — **~305 fails**, high priority
- [#1593](1593-default-init-triggers-on-null-should-be-undefined-only.md) — Destructuring default init triggers on `null` (spec: undefined-only) — **~165 fails**, easy
- [#1594](1594-annexb-strict-function-code-tdz-referenceerror.md) — AnnexB strict function-code / class name-binding TDZ not throwing ReferenceError — **~100 fails**, medium
- [#1595](1595-arraybuffer-transfer-methods-not-implemented.md) — ArrayBuffer.prototype.transfer / transferToFixedLength / transferToImmutable not implemented — **~40 fails**, medium
- [#1596](1596-function-prototype-apply-call-not-accessible.md) — Function.prototype.apply / .call not accessible on compiled Wasm functions — **~46 fails**, high

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
