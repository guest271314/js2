// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import type { CompileResult, IrObservedOutcome } from "../src/index.js";
import {
  evaluateIrOnlyReport,
  observeSingleHostLane,
  type IrOnlyBaseline,
  type IrOnlyEntryObservation,
  type IrOnlyLaneObservation,
} from "../scripts/check-ir-only.js";

function emitted(name: string, legacyBodyEmitted = false): IrObservedOutcome {
  return {
    key: `fixture.ts::function::${name}#0`,
    file: "fixture.ts",
    unitKind: "function",
    displayName: name,
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "gc",
    legacyBodyEmitted,
    irBodyEmitted: true,
    kind: "emitted",
    stage: "patch",
  };
}

function unsupported(name: string): IrObservedOutcome {
  return {
    ...emitted(name, true),
    irBodyEmitted: false,
    kind: "unsupported",
    code: "async-function",
    stage: "select",
    detail: "deferred async unit",
  };
}

function entry(outcomes: readonly IrObservedOutcome[], overrides: Partial<IrOnlyEntryObservation> = {}) {
  return {
    entry: "fixture.ts",
    success: true,
    outcomes,
    hardDiagnostics: [],
    irPostClaimErrors: [],
    irCompiledFuncs: outcomes.filter((outcome) => outcome.kind === "emitted").map((outcome) => outcome.displayName),
    irFirstSkipped: outcomes
      .filter((outcome) => outcome.unitKind === "function" && !outcome.legacyBodyEmitted)
      .map((outcome) => outcome.displayName),
    failures: [],
    ...overrides,
  } satisfies IrOnlyEntryObservation;
}

function lane(entries: readonly IrOnlyEntryObservation[], expectedEntries = entries.length): IrOnlyLaneObservation {
  return { name: "single-host", expectedEntries, entries };
}

function baseline(overrides: Partial<IrOnlyBaseline["lanes"][string]> = {}): IrOnlyBaseline {
  return {
    schemaVersion: 1,
    generated: "2026-07-21",
    lanes: {
      "single-host": {
        entryFloor: 1,
        terminalUnitFloor: 1,
        emittedFloor: 1,
        irBodyEmittedFloor: 1,
        unsupportedCeiling: 0,
        unsupportedByCode: {},
        invariantCeiling: 0,
        ...overrides,
      },
    },
  };
}

function failedResult(overrides: Partial<CompileResult>): CompileResult {
  return {
    binary: new Uint8Array(),
    wat: "",
    dts: "",
    importsHelper: "",
    success: false,
    errors: [],
    stringPool: [],
    imports: [],
    hasMain: false,
    hasTopLevelStatements: false,
    irOutcomes: [emitted("f")],
    ...overrides,
  };
}

describe("#3519 honest IR-only gate", () => {
  it("rejects empty lanes, an empty corpus, missing telemetry, and zero emitted units", () => {
    expect(evaluateIrOnlyReport([], baseline(), "hybrid").ready).toBe(false);
    expect(
      evaluateIrOnlyReport([lane([entry([emitted("a")])]), lane([entry([emitted("b")])])], baseline(), "hybrid")
        .failures,
    ).toContain("report has duplicate lane names");

    const empty = evaluateIrOnlyReport([lane([], 1)], baseline(), "hybrid");
    expect(empty.failures).toEqual(expect.arrayContaining([expect.stringContaining("empty corpus")]));

    const missing = evaluateIrOnlyReport([lane([entry([])])], baseline(), "hybrid");
    expect(missing.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing terminal telemetry"),
        expect.stringContaining("zero terminal units"),
      ]),
    );

    const noEmitted = evaluateIrOnlyReport(
      [lane([entry([unsupported("f")])])],
      baseline({ emittedFloor: 0, irBodyEmittedFloor: 0, unsupportedCeiling: 1 }),
      "hybrid",
    );
    expect(noEmitted.failures).toEqual(expect.arrayContaining([expect.stringContaining("zero emitted units")]));
  });

  it("rejects duplicate keys, missing-terminal invariants, unsupported growth, and emitted-floor regression", () => {
    const same = emitted("f");
    expect(evaluateIrOnlyReport([lane([entry([same, same])])], baseline(), "hybrid").failures).toEqual(
      expect.arrayContaining([expect.stringContaining("duplicate observational outcome keys")]),
    );

    const missingTerminal: IrObservedOutcome = {
      ...emitted("f", true),
      irBodyEmitted: false,
      kind: "invariant",
      code: "missing-terminal-outcome",
      stage: "patch",
      detail: "prepared without a terminal patch",
    };
    expect(evaluateIrOnlyReport([lane([entry([missingTerminal])])], baseline(), "hybrid").ready).toBe(false);

    const growth = evaluateIrOnlyReport([lane([entry([emitted("ok"), unsupported("new")])])], baseline(), "hybrid");
    expect(growth.failures).toEqual(expect.arrayContaining([expect.stringContaining("unsupported population grew")]));

    const floor = evaluateIrOnlyReport(
      [lane([entry([emitted("only")])])],
      baseline({ emittedFloor: 2, irBodyEmittedFloor: 2, terminalUnitFloor: 2 }),
      "hybrid",
    );
    expect(floor.failures).toEqual(expect.arrayContaining([expect.stringContaining("emitted floor regressed")]));
  });

  it("accepts bankable unsupported decreases and emitted increases in hybrid only", () => {
    const current = lane([entry([emitted("a"), emitted("b")])]);
    const prior = baseline({
      terminalUnitFloor: 2,
      emittedFloor: 1,
      irBodyEmittedFloor: 1,
      unsupportedCeiling: 1,
      unsupportedByCode: { "select/async-function": 1 },
    });
    expect(evaluateIrOnlyReport([current], prior, "hybrid").ready).toBe(true);
    expect(evaluateIrOnlyReport([current], prior, "ir-only").ready).toBe(true);

    const compileTwice = lane([entry([emitted("a", true), unsupported("b")])]);
    expect(
      evaluateIrOnlyReport(
        [compileTwice],
        baseline({
          terminalUnitFloor: 2,
          emittedFloor: 1,
          irBodyEmittedFloor: 1,
          unsupportedCeiling: 1,
          unsupportedByCode: { "select/async-function": 1 },
        }),
        "hybrid",
      ).ready,
    ).toBe(true);
    expect(
      evaluateIrOnlyReport(
        [compileTwice],
        baseline({
          terminalUnitFloor: 2,
          emittedFloor: 1,
          irBodyEmittedFloor: 1,
          unsupportedCeiling: 1,
          unsupportedByCode: { "select/async-function": 1 },
        }),
        "ir-only",
      ).ready,
    ).toBe(false);
  });

  it("counts compile throws, success:false, and fatal result.errors without consulting irPostClaimErrors", async () => {
    const seed = ["website/playground/examples/js/algorithms.ts"];

    const thrown = await observeSingleHostLane(seed, async () => {
      throw new Error("compile exploded");
    });
    expect(thrown.entries[0]!.failures).toEqual([{ code: "compile-threw", detail: "compile exploded" }]);

    const failed = await observeSingleHostLane(seed, async () => failedResult({ success: false }));
    expect(failed.entries[0]!.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "compile-failed" })]),
    );

    const fatal = await observeSingleHostLane(seed, async () =>
      failedResult({
        success: true,
        irPostClaimErrors: [],
        errors: [
          {
            message: "[IR-FIRST skipped-slot] fatal but absent from irPostClaimErrors",
            line: 1,
            column: 1,
            severity: "error",
          },
        ],
      }),
    );
    expect(fatal.entries[0]!.irPostClaimErrors).toHaveLength(0);
    expect(fatal.entries[0]!.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "fatal-diagnostic",
          detail: expect.stringContaining("IR-FIRST skipped-slot"),
        }),
      ]),
    );
  });

  it("rejects disagreement with transitional compiled, skipped, and post-claim signals", () => {
    const current = entry([emitted("f")], {
      irCompiledFuncs: [],
      irFirstSkipped: [],
      irPostClaimErrors: [{ kind: "lower", func: "f", message: "contradictory fatal" }],
    });
    const verdict = evaluateIrOnlyReport([lane([current])], baseline(), "hybrid");
    expect(verdict.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("absent from irCompiledFuncs"),
        expect.stringContaining("absent from irFirstSkipped"),
        expect.stringContaining("contradicts emitted terminal"),
      ]),
    );
  });
});
