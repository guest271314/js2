// #3407 — the test262 fixture runner must emit exactly ONE canonical verdict
// row per file. `recordResult` writes the JSONL row and then throws a
// ConformanceError sentinel for any non-pass verdict; the fixture execution
// path nests an inner classification catch inside an outer compile-error catch.
// Before the guard, a `pass` record that `recordResult` internally reclassified
// to `compile_error` (standalone host-import leak) threw its sentinel into the
// inner catch, which reclassified it into a SECOND, contradictory `fail` row —
// the duplicate/contradictory verdict-key defect.
//
// This test pins the shared `isRecordedVerdictSentinel` guard AND a faithful
// model of the fixture runner's two-catch control flow, proving the guard makes
// every branch emit exactly one row and that WITHOUT the guard the double-write
// reproduces.
import { describe, it, expect } from "vitest";
import { isRecordedVerdictSentinel } from "../scripts/verdict-once.mjs";

// Mirror of tests/test262-shared.ts ConformanceError: recordResult throws this
// AFTER it has already written the canonical JSONL row for a non-pass verdict.
class ConformanceError extends Error {
  constructor(status: string, detail?: string) {
    super(`[${status}] ${detail || "unknown"}`);
    this.name = "ConformanceError";
  }
}

describe("#3407 isRecordedVerdictSentinel", () => {
  it("recognizes a ConformanceError instance as an already-recorded verdict", () => {
    expect(isRecordedVerdictSentinel(new ConformanceError("fail", "boom"))).toBe(true);
    expect(isRecordedVerdictSentinel(new ConformanceError("compile_error"))).toBe(true);
  });

  it("recognizes any object carrying the ConformanceError name (cross-realm safe)", () => {
    expect(isRecordedVerdictSentinel({ name: "ConformanceError", message: "x" })).toBe(true);
  });

  it("does NOT treat ordinary execution errors or non-errors as recorded verdicts", () => {
    expect(isRecordedVerdictSentinel(new Error("plain execution throw"))).toBe(false);
    expect(isRecordedVerdictSentinel(new TypeError("bad"))).toBe(false);
    expect(isRecordedVerdictSentinel(Symbol("originalHarnessNoThrow"))).toBe(false);
    expect(isRecordedVerdictSentinel(undefined)).toBe(false);
    expect(isRecordedVerdictSentinel(null)).toBe(false);
    expect(isRecordedVerdictSentinel("ConformanceError")).toBe(false);
  });
});

// ── Faithful model of the fixture runner's nested-catch verdict flow ────────
//
// Reproduces tests/test262-shared.ts:713-862 structure: an inner try records a
// `pass` (which recordResult may reclassify to compile_error + throw), an inner
// catch classifies execution errors, and an outer catch treats an unexpected
// throw as compile_error. `guard` is injected so we can prove the shipped guard
// is load-bearing (guard on ⇒ one row; guard off ⇒ the historical double write).
type Row = { status: string; error?: string };

const RUNTIME_NEG_SUCCESS = Symbol("originalHarnessNoThrow");

function simulateFixture(
  scenario: {
    // an execution error thrown from the try body BEFORE the `pass` record
    execThrow?: unknown;
    // recordResult internally flips a `pass` to compile_error (host-import leak)
    hostImportLeak?: boolean;
    isRuntimeNegative?: boolean;
  },
  // The inner catch (test262-shared.ts:779) is the one #3407 adds a guard to.
  // The outer catch (test262-shared.ts:843) has always carried the #1221 guard,
  // so it is fixed ON here — the historical defect was the INNER catch alone.
  innerGuard: (err: unknown) => boolean,
): Row[] {
  const rows: Row[] = [];
  // Mirror of recordResult: write the row, then throw the sentinel for non-pass.
  const recordResult = (status: string, error?: string): void => {
    let s = status;
    let e = error;
    if (s === "pass" && scenario.hostImportLeak) {
      s = "compile_error";
      e = "standalone host-import leak";
    }
    rows.push({ status: s, error: e });
    if (s !== "pass") throw new ConformanceError(s, e);
  };

  try {
    try {
      // try body (test262-shared.ts:713-778)
      if (scenario.isRuntimeNegative) throw RUNTIME_NEG_SUCCESS;
      if (scenario.execThrow !== undefined) throw scenario.execThrow;
      recordResult("pass");
    } catch (execErr: unknown) {
      // inner classification catch (test262-shared.ts:779) — guard under test
      if (innerGuard(execErr)) throw execErr;
      if (execErr === RUNTIME_NEG_SUCCESS) {
        recordResult("fail", "expected runtime error but execution succeeded");
      } else {
        recordResult("fail", String(execErr));
      }
    }
  } catch (e: unknown) {
    // outer compile-error catch (test262-shared.ts:843) — #1221 guard always on
    if (isRecordedVerdictSentinel(e)) return rows;
    recordResult("compile_error", String(e));
  }
  return rows;
}

describe("#3407 fixture verdict-key invariant — exactly one row per file", () => {
  const guard = isRecordedVerdictSentinel;

  it("positive pass records exactly one pass row", () => {
    const rows = simulateFixture({}, guard);
    expect(rows).toEqual([{ status: "pass", error: undefined }]);
  });

  it("ordinary execution failure records exactly one fail row", () => {
    const rows = simulateFixture({ execThrow: new Error("boom") }, guard);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fail");
  });

  it("runtime-negative that succeeds records exactly one fail row", () => {
    const rows = simulateFixture({ isRuntimeNegative: true }, guard);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fail");
  });

  it("REGRESSION: pass reclassified to compile_error records exactly one row", () => {
    // The core #3407 case: recordResult flips pass→compile_error and throws its
    // sentinel INTO the inner catch. The guard must rethrow, not re-record.
    const rows = simulateFixture({ hostImportLeak: true }, guard);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("compile_error");
  });

  it("proves the inner guard is load-bearing: WITHOUT it the pass→compile_error case double-writes", () => {
    const noInnerGuard = () => false;
    const rows = simulateFixture({ hostImportLeak: true }, noInnerGuard);
    // Historical defect: the inner catch re-records a contradictory `fail` row
    // (whose message embeds the ConformanceError sentinel) after the real
    // compile_error row; the outer #1221 guard then stops a third write.
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("compile_error");
    expect(rows[1].status).toBe("fail");
    expect(rows[1].error).toContain("ConformanceError");
  });
});
