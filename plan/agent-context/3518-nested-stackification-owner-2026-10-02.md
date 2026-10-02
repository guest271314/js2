# Nested stackification analysis ownership — 2026-10-02

Issue: 3518, IR-only default and direct front-end retirement. This is one
preservation checkpoint; full IR coverage and legacy retirement remain open.

Branch: codex/3518-nested-stackification-owner-d1-20261002.
Base: freshly verified canonical main e473d92460af75ced29e9666e7e97cdde8df12ca.
Source, graph-integration and inventory slices are individually held on canonical
issue-assignments. Earlier lowering implementation and symbolic-support claims
remain intact. Parent-owned integration/control custody is recorded in the
existing lowering-cycle checkpoint; no other worktree was modified.

Sol6.1Medium moved the complete implementation into
src/ir/analysis/nested-stackification.ts, using canonical effects and node types.
Reversing the sole nodes import change reproduces the original3570-byte source
exactly (SHA f66f42492cb6aaf0c55ad3681289802c1e598ea98119edc975bd37618c905a33).
The old path forwards the same function and input type. Effect classification,
lexical refusal rules and both-set mutation behavior are unchanged.

Root inventoried the actual new owner, retained the old compatibility facade,
raised ir-analysis roots/entries/minimum from11 to12 and appended the complete
activation obligation and move. Existing evidence, allowed edges, old history
and every other classification are preserved. Sol updated only exact live graph
expectations/comment, retaining all25 controls. The old graph expectations had
21modules/24edges; actual predecessor27/31; candidate28/32. New ownership adds
only one module and replaces one compatibility edge with two canonical edges.
The existing eight added/two removed main modules were individually justified.

Validation: actual combined55/55 (new ownership21, original nested9, lowering25),
zero failures/pending; ordinary error handling. Four-file lint passes; current
TS7 typecheck exits0. Actual inventory mode exits0 with inventoryValid=true and
zero policy errors, while graphComplete/architectureComplete remain false.
Actual complete mode exits1 with inventory-valid-architecture-incomplete.
The earlier24/25 and unclassified-owner refusals are preserved in owned scratch.
Independent Sol6.1Medium reviewed both the original extraction and full five-path
integration; AstraHigh specified extraction and graph obligations. Root source
metadata/integration producer is Codex GPT-6 Default.

A fresh complete23-PR census found no other source extraction or new test owner.
Ten PRs share inventory JSON. PR5753 (TypeScript standalone compiler coverage)
also adds object layout/construction order to the live graph expectation. Its
changes are preserved in its own branch; this checkpoint describes current main.
Whichever checkpoint integrates second must resolve graph and inventory against
the actual combined source, preserving both identity sets and duplicate edges.
No other session's branch/file/claim was released or overwritten. Exact current
PR heads and patches are in .tmp/nested-owner/prepublication-census.json and
updated overlap-details.json, not inferred from an old mergeability flag.

The separate intrinsic-preparation delivery PR6405 remains at publishedbfcf.
Its normal commit stopped after631/631 historical and456/456 Number controls,
then102failed/3passed program-data rows due to the historical linear-index pin.
Astra has specified an explicit immutable-history/current-proof separation;
H1/H2 receive independent claims and implementers. Nothing here fixes those
receipts or implies they pass. Preserve all historical assertions/fixtures,
main's concatenation fixes, current proof requirements and original failures.

Evidence: .tmp/nested-owner/integrated-freeze.json, graph-integration-freeze.json,
closure-census.json, integration-results.json, combined-review.md,
inventory-final.log, complete-final.log and final typecheck/lint logs.
Only verified protected main integration counts as delivery.
