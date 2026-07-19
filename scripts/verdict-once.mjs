// #3407 — one canonical test262 verdict per file.
//
// The fixture runner's `recordResult` writes the canonical JSONL row for a
// verdict and THEN throws a `ConformanceError` for every non-pass status (so a
// failing test still surfaces to vitest). That sentinel is the signal that a
// row has ALREADY been written for this file.
//
// The fixture execution path nests two catches: an inner catch that classifies
// an execution error into a verdict, and an outer catch that treats an
// unexpected throw as a compile error. If EITHER catch receives a
// recorded-verdict sentinel and proceeds to call `recordResult` again, it emits
// a SECOND, often contradictory, row for the same file (e.g. a `pass` path that
// `recordResult` internally reclassified to `compile_error` via a standalone
// host-import leak throws its sentinel into the inner catch, which then records
// a `fail` "ConformanceError: [compile_error] …" row). That is the
// duplicate/contradictory verdict-key defect this module guards against.
//
// Both catches must therefore RETHROW a recorded-verdict sentinel before any
// error-classification branch, so the already-written row stays the single
// canonical verdict.
//
// The check is name-based rather than `instanceof` so it holds across module
// realms and for any future subclass that keeps the `ConformanceError` name.

/**
 * @param {unknown} err
 * @returns {boolean} true when `err` is the sentinel `recordResult` throws after
 *   it has already written a canonical (non-pass) verdict row.
 */
export function isRecordedVerdictSentinel(err) {
  return (
    !!err &&
    (typeof err === "object" || typeof err === "function") &&
    /** @type {{ name?: unknown }} */ (err).name === "ConformanceError"
  );
}
