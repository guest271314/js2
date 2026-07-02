// #3003 — a test262 verdict-logic change must bump ORACLE_VERSION.
//
// Exercises the pure evaluator behind scripts/check-verdict-oracle-bump.mjs so
// the queue-wedge prevention gate is itself covered. The two 2026-07 wedges (the
// −439 strict-negative-verdict change and PR #2463's vacuity scorer) are the
// canonical "verdict-signal change without an oracle bump" cases: they MUST fail.
import { describe, expect, it } from "vitest";

import {
  evaluateVerdictOracle,
  MIXED_VERDICT_FILES,
  OVERRIDE_RE,
  PURE_VERDICT_FILES,
  VERDICT_SIGNAL_RE,
} from "../scripts/check-verdict-oracle-bump.mjs";

// Convenience: build the evaluator input from a compact per-file spec.
function evalDiff(spec: {
  added?: Record<string, string[]>;
  removed?: Record<string, string[]>;
  baseOracle?: number;
  headOracle?: number;
}) {
  const added = spec.added || {};
  const removed = spec.removed || {};
  const changedFiles = Array.from(new Set([...Object.keys(added), ...Object.keys(removed)]));
  return evaluateVerdictOracle({
    changedFiles,
    addedLinesByFile: added,
    removedLinesByFile: removed,
    baseOracle: spec.baseOracle ?? 1,
    headOracle: spec.headOracle ?? 1,
  });
}

describe("#3003 verdict-oracle bump gate", () => {
  it("VERDICT_SIGNAL_RE matches verdict SETs but not READs", () => {
    expect(VERDICT_SIGNAL_RE.test('status: "fail",')).toBe(true);
    expect(VERDICT_SIGNAL_RE.test('result.status = "compile_error";')).toBe(true);
    expect(VERDICT_SIGNAL_RE.test("vacuous: true,")).toBe(true);
    expect(VERDICT_SIGNAL_RE.test("const m = negativeCompileErrorMatches(x, y, z);")).toBe(true);
    // reads / comparisons must NOT trip the gate (report aggregation, guards)
    expect(VERDICT_SIGNAL_RE.test('if (record.status === "pass") count++;')).toBe(false);
    expect(VERDICT_SIGNAL_RE.test("const p = row.status;")).toBe(false);
    expect(VERDICT_SIGNAL_RE.test("// bump the pass total")).toBe(false);
  });

  it("passes when no verdict-logic file changed", () => {
    const r = evalDiff({ added: { "src/codegen/expressions.ts": ['emit("i32.add");'] } });
    expect(r.triggered).toBe(false);
    expect(r.verdict).toBe("pass");
  });

  it("passes when a verdict-logic file changed only in incidental (non-verdict) lines", () => {
    // worker recycle / comment tweak — no verdict-signal token, no bump needed.
    const r = evalDiff({
      added: {
        "scripts/test262-worker.mjs": [
          "// clarify the recycle comment",
          "const forceRecycleReason = driftReason || null;",
        ],
      },
    });
    expect(r.triggered).toBe(true);
    expect(r.signals).toHaveLength(0);
    expect(r.verdict).toBe("pass");
  });

  it("FAILS PR #2463's vacuity scorer shape (verdict change, no oracle bump)", () => {
    const r = evalDiff({
      added: {
        "scripts/test262-worker.mjs": [
          "          vacuous: true,",
          '          error: "vacuous: harness-wrapper callback never executed (#2940) — no assertion ran",',
        ],
        "tests/test262-shared.ts": ["    vacuous: metadata?.vacuous || undefined,"],
      },
      baseOracle: 1,
      headOracle: 1, // NOT bumped — this is the wedge
    });
    expect(r.verdict).toBe("fail");
    expect(r.bumped).toBe(false);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  it("FAILS the −439 strict-negative-verdict shape (negative-verdict.mjs change, no bump)", () => {
    const r = evalDiff({
      added: {
        "scripts/negative-verdict.mjs": [
          "  if (!ES_EARLY_ERROR_CODES.has(code)) return false;",
          "  return expectedType === raisedType;",
        ],
      },
      baseOracle: 1,
      headOracle: 1,
    });
    expect(r.verdict).toBe("fail");
  });

  it("PASSES the same verdict change once ORACLE_VERSION is bumped", () => {
    const r = evalDiff({
      added: { "scripts/test262-worker.mjs": ["          vacuous: true,"] },
      baseOracle: 1,
      headOracle: 2, // bumped — the guards will re-baseline
    });
    expect(r.verdict).toBe("pass");
    expect(r.bumped).toBe(true);
  });

  it("WARNS (not fails) on a verdict-signal change that carries the in-diff override", () => {
    // The #2912 dead-ternary case: verdict logic touched, but author confirmed
    // ZERO existing rows flip, so an in-diff `oracle-version-exempt:` overrides.
    const r = evalDiff({
      added: {
        "scripts/negative-verdict.mjs": [
          "  // oracle-version-exempt: deletes dead ternary; SyntaxError population unchanged (0 flips)",
          "  return negativeCompileErrorMatches(expectedType, errorCodes, message);",
        ],
      },
      baseOracle: 1,
      headOracle: 1,
    });
    expect(r.verdict).toBe("warn");
    expect(r.override).toBe(true);
  });

  it("comment-only edit to a PURE verdict file needs no bump", () => {
    const r = evalDiff({
      added: { "scripts/negative-verdict.mjs": ["  // clarify the phase-gate docstring", "   "] },
      baseOracle: 1,
      headOracle: 1,
    });
    expect(r.signals).toHaveLength(0);
    expect(r.verdict).toBe("pass");
  });

  it("catches a verdict change expressed only as a DELETION (removed line)", () => {
    const r = evalDiff({
      removed: { "scripts/test262-worker.mjs": ['        status: hasEarlyError ? "pass" : "pass",'] },
      baseOracle: 1,
      headOracle: 1,
    });
    expect(r.verdict).toBe("fail");
  });

  it("exposes the authoritative file surface + override token as constants", () => {
    expect(PURE_VERDICT_FILES).toContain("scripts/negative-verdict.mjs");
    expect(MIXED_VERDICT_FILES).toContain("scripts/test262-worker.mjs");
    expect(MIXED_VERDICT_FILES).toContain("tests/test262-shared.ts");
    expect(OVERRIDE_RE.test("// oracle-version-exempt: because")).toBe(true);
  });
});
