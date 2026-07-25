// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { auditIrIntegrationTerminalEvidence } from "../src/codegen/ir-overlay-outcomes.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrIntegrationReport,
  invariantIntegrationFailure,
  IrIntegrationFailureLog,
  type IrIntegrationReport,
  type IrIntegrationTerminalEvidence,
} from "../src/ir/integration-report.js";
import {
  buildIrLegacyUnitProjection,
  buildIrPlanningIdentityContext,
  type IrLegacyUnitProjection,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

interface Fixture {
  readonly sourceFile: ts.SourceFile;
  readonly context: IrPlanningIdentityContext;
  readonly ownerProjection: IrLegacyUnitProjection;
  readonly ownerUnitId: IrUnitId;
}

function fixture(): Fixture {
  const sourceFile = ts.createSourceFile(
    "/repo/report.ts",
    "export function run(value: number): number { return value + 1; }",
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const context = buildIrPlanningIdentityContext(inventory);
  const ownerUnitId = inventory.terminalUnits.find((unit) => unit.legacyMatchName === "run")!.id;
  return {
    sourceFile,
    context,
    ownerUnitId,
    ownerProjection: buildIrLegacyUnitProjection([{ unitId: ownerUnitId, legacyName: "run" }]),
  };
}

function audit(current: Fixture, report: IrIntegrationReport) {
  return auditIrIntegrationTerminalEvidence({
    sourceFile: current.sourceFile,
    identityContext: current.context,
    activeOwners: current.ownerProjection,
    evidence: report.terminalEvidence ?? [],
    compiled: report.compiled,
    errors: report.errors,
    terminalCompiledOwners: report.terminalCompiledOwners,
    syntheticCompiledArtifacts: report.syntheticCompiledArtifacts,
  });
}

function failedEvidence(current: Fixture, errorFunc = "run"): IrIntegrationTerminalEvidence {
  const error = invariantIntegrationFailure(errorFunc, "verifier-failure", "verify", `${errorFunc} failed`);
  return {
    kind: "failed",
    unitId: current.ownerUnitId,
    legacyName: "run",
    error,
    errors: [error],
  };
}

describe("#3520 integration report sidecar completeness", () => {
  it("covers every verifier detail object with one grouped terminal event", () => {
    const current = fixture();
    const failures = new IrIntegrationFailureLog();
    failures.recordVerifierGroups("run", [
      { detailPrefix: "artifact one: ", details: [{ message: "first" }] },
      { detailPrefix: "artifact two: ", details: [{ message: "second" }, { message: "third" }] },
    ]);
    const report = buildIrIntegrationReport(
      [],
      failures.errors,
      current.ownerProjection,
      [],
      failures.terminalFailureEvents,
    );
    const evidence = report.terminalEvidence?.[0];

    expect(report.errors).toHaveLength(3);
    expect(evidence).toMatchObject({ kind: "failed", unitId: current.ownerUnitId, legacyName: "run" });
    expect(evidence?.kind === "failed" ? evidence.errors : undefined).toEqual(report.errors);
    const audited = audit(current, report);
    expect(audited.invariantByUnitId).toEqual(new Map());
    expect(audited.sourceInvariant).toBeUndefined();
  });

  it("keeps a mixed verifier event fail-closed without changing public diagnostic order", () => {
    const current = fixture();
    const failures = new IrIntegrationFailureLog();
    failures.recordVerifierGroups("run", [
      {
        detailPrefix: "",
        details: [{ message: "designed return-shape demotion", demote: true }, { message: "dominance violation" }],
      },
    ]);

    expect(failures.errors.map((error) => error.outcome.kind)).toEqual(["unsupported", "invariant"]);
    expect(failures.terminalFailureEvents[0]?.error.outcome.kind).toBe("invariant");
    expect(failures.terminalFailureEvents[0]?.errors.map((error) => error.message)).toEqual([
      "dominance violation",
      "designed return-shape demotion",
    ]);

    const report = buildIrIntegrationReport(
      [],
      failures.errors,
      current.ownerProjection,
      [],
      failures.terminalFailureEvents,
    );
    const audited = audit(current, report);
    expect(audited.invariantByUnitId).toEqual(new Map());
    expect(audited.sourceInvariant).toBeUndefined();
  });

  it("rejects omitted, foreign, and owner-mismatched public error coverage", () => {
    const current = fixture();
    const first = invariantIntegrationFailure("run", "verifier-failure", "verify", "first");
    const second = invariantIntegrationFailure("run", "verifier-failure", "verify", "second");
    const foreign = invariantIntegrationFailure("run", "verifier-failure", "verify", "foreign");
    const wrongOwner = failedEvidence(current, "other");
    const cases: IrIntegrationReport[] = [
      {
        compiled: [],
        errors: [first, second],
        terminalEvidence: [
          { kind: "failed", unitId: current.ownerUnitId, legacyName: "run", error: first, errors: [first] },
        ],
      },
      {
        compiled: [],
        errors: [first],
        terminalEvidence: [
          {
            kind: "failed",
            unitId: current.ownerUnitId,
            legacyName: "run",
            error: first,
            errors: [first, foreign],
          },
        ],
      },
      {
        compiled: [],
        errors: [wrongOwner.kind === "failed" ? wrongOwner.error : first],
        terminalEvidence: [wrongOwner],
      },
    ];

    for (const report of cases) {
      expect(audit(current, report).invariantByUnitId.get(current.ownerUnitId)).toMatchObject({
        kind: "invariant",
        code: "selection-preparation-mismatch",
      });
    }
  });

  it("classifies synthetic compiled artifacts while requiring exact patched-owner coverage", () => {
    const current = fixture();
    const report = buildIrIntegrationReport(["run", "__lifted_run_0"], [], current.ownerProjection, ["run"], []);

    expect(report.terminalCompiledOwners).toEqual(["run"]);
    expect(report.syntheticCompiledArtifacts).toEqual(["__lifted_run_0"]);
    expect(audit(current, report).invariantByUnitId).toEqual(new Map());

    const missingPatch: IrIntegrationReport = { ...report, terminalEvidence: [] };
    expect(audit(current, missingPatch).invariantByUnitId.get(current.ownerUnitId)).toMatchObject({
      kind: "invariant",
      code: "selection-preparation-mismatch",
    });

    const misclassified: IrIntegrationReport = {
      ...report,
      terminalCompiledOwners: [],
      syntheticCompiledArtifacts: ["run", "__lifted_run_0"],
    };
    expect(audit(current, misclassified).invariantByUnitId.get(current.ownerUnitId)).toMatchObject({
      kind: "invariant",
      code: "selection-preparation-mismatch",
    });

    const unclassified: IrIntegrationReport = { ...report, syntheticCompiledArtifacts: [] };
    expect(audit(current, unclassified).sourceInvariant).toMatchObject({
      kind: "invariant",
      code: "selection-preparation-mismatch",
    });
  });

  it("keeps separately recorded failures as duplicate terminal events", () => {
    const current = fixture();
    const failures = new IrIntegrationFailureLog();
    failures.record(invariantIntegrationFailure("run", "verifier-failure", "verify", "first call"));
    failures.record(invariantIntegrationFailure("run", "verifier-failure", "verify", "second call"));
    const report = buildIrIntegrationReport(
      [],
      failures.errors,
      current.ownerProjection,
      [],
      failures.terminalFailureEvents,
    );

    expect(audit(current, report).invariantByUnitId.get(current.ownerUnitId)).toMatchObject({
      kind: "invariant",
      code: "duplicate-unit-outcome",
    });
  });
});
